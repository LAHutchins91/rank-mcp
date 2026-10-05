import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  googleRedirectUri,
  searchAnalyticsUrl,
  sitesListUrl,
  urlInspectionUrl,
  type AppConfig
} from "./config.js";
import { RankError } from "./errors.js";
import { decryptString } from "./secrets.js";
import type { UserRecord } from "./users.js";

export type FetchImpl = typeof fetch;

type TokenCache = Map<string, { token: string; expiresAt: number }>;

export function googleAuthUrl(config: AppConfig, state: string) {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new RankError("Google OAuth is not configured on this server.", "google_not_configured", 503);
  }
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", googleRedirectUri(config.appBaseUrl));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function googleMessage(body: unknown, status: number) {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const nested = record?.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null;
  const message = typeof nested?.message === "string"
    ? nested.message
    : typeof record?.error_description === "string"
      ? record.error_description
      : typeof record?.error === "string"
        ? record.error
        : `Google request failed (${status})`;
  return message.slice(0, 500);
}

export async function exchangeGoogleCode(config: AppConfig, code: string, fetchImpl: FetchImpl) {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: googleRedirectUri(config.appBaseUrl),
    grant_type: "authorization_code"
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await readJson(response);
  if (!response.ok) throw new RankError(googleMessage(payload, response.status), "google_token_exchange_failed", 502);
  const record = payload as Record<string, unknown>;
  if (typeof record.access_token !== "string") throw new RankError("Google did not return an access token.", "google_token_exchange_failed", 502);
  return {
    accessToken: record.access_token,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : null,
    expiresIn: typeof record.expires_in === "number" ? record.expires_in : 3600
  };
}

export async function fetchGoogleProfile(accessToken: string, fetchImpl: FetchImpl) {
  const response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = await readJson(response);
  if (!response.ok) throw new RankError(googleMessage(payload, response.status), "google_profile_failed", 502);
  const record = payload as Record<string, unknown>;
  if (typeof record.sub !== "string" || typeof record.email !== "string") {
    throw new RankError("Google did not return an account email.", "google_profile_failed", 502);
  }
  return { sub: record.sub, email: record.email };
}

async function refreshAccessToken(config: AppConfig, refreshToken: string, fetchImpl: FetchImpl) {
  const body = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await readJson(response);
  if (!response.ok) throw new RankError("Search Console authorization expired. Connect Google again from your account page.", "google_refresh_failed", 401);
  const record = payload as Record<string, unknown>;
  if (typeof record.access_token !== "string") throw new RankError("Google did not return an access token.", "google_refresh_failed", 502);
  return {
    accessToken: record.access_token,
    expiresIn: typeof record.expires_in === "number" ? record.expires_in : 3600
  };
}

export function createTokenCache(): TokenCache {
  return new Map();
}

async function accessTokenFor(config: AppConfig, user: UserRecord, fetchImpl: FetchImpl, cache: TokenCache, now: number) {
  const cached = cache.get(user.id);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;
  if (!user.encryptedRefreshToken) {
    throw new RankError("Connect a Google account that can read Search Console.", "google_not_connected", 403, {
      connectUrl: `${config.appBaseUrl}/google/start?return=/account`
    });
  }
  let refreshToken: string;
  try {
    refreshToken = decryptString(user.encryptedRefreshToken, config.tokenEncryptionKey);
  } catch {
    throw new RankError("The stored Google connection could not be read. Connect Google again.", "google_token_unreadable", 409, {
      connectUrl: `${config.appBaseUrl}/google/start?return=/account`
    });
  }
  const fresh = await refreshAccessToken(config, refreshToken, fetchImpl);
  cache.set(user.id, { token: fresh.accessToken, expiresAt: now + fresh.expiresIn * 1000 });
  return fresh.accessToken;
}

async function googleApi(config: AppConfig, user: UserRecord, fetchImpl: FetchImpl, cache: TokenCache, now: number, url: string, init?: RequestInit) {
  const token = await accessTokenFor(config, user, fetchImpl, cache, now);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetchImpl(url, { ...init, headers });
  const payload = await readJson(response);
  if (!response.ok) throw new RankError(googleMessage(payload, response.status), "search_console_error", response.status === 401 ? 401 : 502);
  return payload;
}

export type GscClient = {
  listSites(): Promise<unknown>;
  searchAnalytics(siteUrl: string, body: Record<string, unknown>): Promise<unknown>;
  inspectUrl(body: Record<string, unknown>): Promise<unknown>;
};

export function createGscClient(config: AppConfig, user: UserRecord, fetchImpl: FetchImpl, cache: TokenCache, now: () => Date): GscClient {
  return {
    listSites: () => googleApi(config, user, fetchImpl, cache, now().getTime(), sitesListUrl()),
    searchAnalytics: (siteUrl, body) => googleApi(config, user, fetchImpl, cache, now().getTime(), searchAnalyticsUrl(siteUrl), {
      method: "POST",
      body: JSON.stringify(body)
    }),
    inspectUrl: (body) => googleApi(config, user, fetchImpl, cache, now().getTime(), urlInspectionUrl(), {
      method: "POST",
      body: JSON.stringify(body)
    })
  };
}
