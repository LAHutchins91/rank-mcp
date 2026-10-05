import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { applyStripeEvent, buildCheckoutParams, stripeEventUserId, stripePost, verifyStripeEvent } from "./billing.js";
import {
  billingConfigured,
  googleOAuthConfigured,
  googleRedirectUri,
  MCP_BROWSER_ORIGINS,
  MCP_SCOPE,
  SERVER_NAME,
  SERVER_VERSION,
  loadConfig,
  type AppConfig
} from "./config.js";
import { RankError } from "./errors.js";
import { createGscClient, createTokenCache, exchangeGoogleCode, fetchGoogleProfile, googleAuthUrl } from "./google.js";
import { createRankServer } from "./mcp.js";
import {
  accountPage,
  consentPage,
  connectPage,
  landingPage,
  logoBytes,
  messagePage,
  privacyPage,
  supportPage,
  termsPage
} from "./pages.js";
import { encryptString, pkceS256, randomToken, readSignedPayload, safeEqual, sha256, signPayload } from "./secrets.js";
import { createStore, type KvStore } from "./storage.js";
import { getUser, isEntitled, newTrial, type UserRecord } from "./users.js";

export type CreateAppOptions = {
  env?: NodeJS.ProcessEnv;
  store?: KvStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const TEST_REFRESH_TOKEN = "test-refresh-token";

function cookieValue(req: Request, name: string) {
  const header = req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function bearer(req: Request) {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function allowedClientRedirect(uri: string) {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")) return true;
    const blocked = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:", "http:", "https:"]);
    return url.protocol.length > 2 && !blocked.has(url.protocol);
  } catch {
    return false;
  }
}

function localReturn(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/account";
}

export function createApp(options: CreateAppOptions = {}) {
  const config = loadConfig(options.env ?? process.env);
  const store = options.store ?? createStore(config);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const cache = createTokenCache();
  const logo = logoBytes();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY"
    });
    next();
  });

  const buckets = new Map<string, { count: number; reset: number }>();
  function allow(key: string, limit: number, windowMs: number) {
    const time = now().getTime();
    if (buckets.size > 2000) {
      for (const [name, bucket] of buckets) if (bucket.reset <= time) buckets.delete(name);
    }
    const current = buckets.get(key);
    if (!current || current.reset <= time) {
      if (buckets.size > 5000) return false;
      buckets.set(key, { count: 1, reset: time + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const signature = req.header("stripe-signature");
      if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).send("Missing Stripe signature");
      const event = verifyStripeEvent(req.body, signature, config.stripeWebhookSecret, now().getTime());
      const userId = stripeEventUserId(event);
      if (userId) {
        const user = await getUser(store, userId);
        if (user) {
          const updated = applyStripeEvent(user, event, now());
          if (updated) await store.put("users", updated.id, updated);
        }
      }
      res.json({ received: true });
    } catch (error) {
      console.error(error instanceof RankError ? error.code : "stripe_webhook_failed");
      res.status(400).send("Webhook could not be processed");
    }
  });

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false }));

  function setSession(res: Response, userId: string) {
    const exp = now().getTime() + 30 * 24 * 60 * 60 * 1000;
    const value = signPayload({ sub: userId, exp }, config.tokenEncryptionKey);
    const secure = config.appBaseUrl.startsWith("https://") ? "; Secure" : "";
    res.append("Set-Cookie", `rank_session=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure}`);
  }

  async function readSession(req: Request) {
    if (!config.tokenEncryptionKey) return null;
    const raw = cookieValue(req, "rank_session");
    if (!raw) return null;
    const payload = readSignedPayload<{ sub?: string; exp?: number }>(raw, config.tokenEncryptionKey);
    if (!payload?.sub || typeof payload.exp !== "number" || payload.exp < now().getTime()) return null;
    return getUser(store, payload.sub);
  }

  async function userFromAccessToken(token: string) {
    if (!token) return null;
    const row = await store.get("access_tokens", sha256(token));
    if (!row || typeof row.userId !== "string" || typeof row.expiresAt !== "string") return null;
    if (new Date(row.expiresAt).getTime() <= now().getTime()) return null;
    return getUser(store, row.userId);
  }

  async function currentUser(req: Request) {
    const token = bearer(req);
    if (token) return userFromAccessToken(token);
    return readSession(req);
  }

  async function saveUser(user: UserRecord) {
    await store.put("users", user.id, user);
    return user;
  }

  async function connectUser(input: { id: string; email: string; refreshToken: string | null }) {
    const existing = await getUser(store, input.id);
    const trial = newTrial(now());
    const encryptedRefreshToken = input.refreshToken
      ? encryptString(input.refreshToken, config.tokenEncryptionKey)
      : existing?.encryptedRefreshToken ?? null;
    return saveUser({
      id: input.id,
      email: input.email,
      googleSubject: input.id,
      encryptedRefreshToken,
      trialStartedAt: existing?.trialStartedAt ?? trial.trialStartedAt,
      trialEndsAt: existing?.trialEndsAt ?? trial.trialEndsAt,
      subscriptionStatus: existing?.subscriptionStatus ?? trial.subscriptionStatus,
      stripeCustomerId: existing?.stripeCustomerId ?? null,
      stripeSubscriptionId: existing?.stripeSubscriptionId ?? null,
      currentPeriodEnd: existing?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: existing?.cancelAtPeriodEnd ?? false,
      createdAt: existing?.createdAt ?? now().toISOString(),
      updatedAt: now().toISOString()
    });
  }

  async function saveAuthCode(input: { clientId: string; redirectUri: string; codeChallenge: string; userId: string; scope: string }) {
    const code = randomToken();
    await store.put("auth_codes", sha256(code), {
      ...input,
      expiresAt: new Date(now().getTime() + CODE_TTL_MS).toISOString()
    });
    return code;
  }

  async function issueTokens(userId: string, clientId: string, scope: string) {
    const access = randomToken();
    const refresh = randomToken();
    const issued = now().getTime();
    await store.put("access_tokens", sha256(access), {
      userId, clientId, scope, expiresAt: new Date(issued + ACCESS_TTL_MS).toISOString()
    });
    await store.put("refresh_tokens", sha256(refresh), {
      userId, clientId, scope, expiresAt: new Date(issued + REFRESH_TTL_MS).toISOString()
    });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope };
  }

  const resourceMetadata = {
    resource: `${config.appBaseUrl}/mcp`,
    resource_name: SERVER_NAME,
    authorization_servers: [config.appBaseUrl],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${config.appBaseUrl}/connect`
  };
  const authorizationMetadata = {
    issuer: config.appBaseUrl,
    authorization_endpoint: `${config.appBaseUrl}/authorize`,
    token_endpoint: `${config.appBaseUrl}/token`,
    registration_endpoint: `${config.appBaseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    service_documentation: `${config.appBaseUrl}/connect`
  };

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json(resourceMetadata);
  });
  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration"], (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json(authorizationMetadata);
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "rank",
      name: SERVER_NAME,
      version: SERVER_VERSION,
      billingConfigured: billingConfigured(config),
      googleOAuthConfigured: googleOAuthConfigured(config),
      encryptionConfigured: Boolean(config.tokenEncryptionKey),
      storageBackend: config.storageBackend,
      googleRedirectUri: googleRedirectUri(config.appBaseUrl)
    });
  });

  app.get("/logo.jpg", (_req, res) => {
    if (!logo) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=86400").type("image/jpeg").send(logo);
  });
  app.get("/", (_req, res) => res.type("html").send(landingPage(config)));
  app.get("/connect", (_req, res) => res.type("html").send(connectPage(config)));
  app.get("/privacy", (_req, res) => res.type("html").send(privacyPage(config)));
  app.get("/terms", (_req, res) => res.type("html").send(termsPage(config)));
  app.get("/support", (_req, res) => res.type("html").send(supportPage(config)));

  app.get("/account", async (req, res) => {
    const user = await readSession(req);
    const checkout = String(req.query.checkout ?? "");
    const notice = checkout === "success"
      ? "Checkout completed. Subscription status updates when Stripe confirms it."
      : checkout === "cancelled"
        ? "Checkout was cancelled. No changes were made."
        : undefined;
    res.type("html").send(accountPage(config, {
      email: user?.email,
      googleConnected: Boolean(user?.encryptedRefreshToken),
      trialEndsAt: user?.trialEndsAt,
      subscriptionStatus: user?.subscriptionStatus,
      entitled: user ? isEntitled(user, now()) : false,
      billingReady: billingConfigured(config),
      hasCustomer: Boolean(user?.stripeCustomerId),
      notice
    }));
  });

  app.options(["/register", "/token"], (_req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }).status(204).end();
  });

  app.post("/register", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (!allow(`register:${req.ip}`, 30, 60 * 60 * 1000)) return res.status(429).json({ error: "slow_down" });
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((uri: unknown): uri is string => typeof uri === "string") : [];
    const method = req.body?.token_endpoint_auth_method;
    if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some((uri: string) => !allowedClientRedirect(uri)) || (method && method !== "none")) {
      return res.status(400).json({ error: "invalid_client_metadata" });
    }
    const clientId = randomToken(16);
    const clientName = typeof req.body?.client_name === "string" && req.body.client_name.trim() ? req.body.client_name.trim().slice(0, 200) : "MCP client";
    await store.put("clients", clientId, { clientId, clientName, redirectUris, createdAt: now().toISOString() });
    res.status(201).json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE
    });
  });

  app.get("/authorize", async (req, res) => {
    if (!allow(`authorize:${req.ip}`, 60, 60 * 1000)) return res.status(429).json({ error: "slow_down" });
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const challenge = String(req.query.code_challenge ?? "");
    const method = String(req.query.code_challenge_method ?? "");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const scope = typeof req.query.scope === "string" && req.query.scope ? req.query.scope : MCP_SCOPE;
    const resource = typeof req.query.resource === "string" ? req.query.resource : "";
    const client = await store.get("clients", clientId);
    const redirectUris = Array.isArray(client?.redirectUris) ? client.redirectUris.filter((uri): uri is string => typeof uri === "string") : [];
    if (!client || !redirectUris.includes(redirectUri)) return res.status(400).json({ error: "invalid_request" });
    const fail = (error: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      if (state) url.searchParams.set("state", state);
      res.redirect(url.toString());
    };
    if (req.query.response_type !== "code") return fail("unsupported_response_type");
    if (method !== "S256" || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return fail("invalid_request");
    if (scope.split(" ").some((part) => part && part !== MCP_SCOPE)) return fail("invalid_scope");
    if (resource && resource !== `${config.appBaseUrl}/mcp`) return fail("invalid_target");

    if (typeof req.query.test_subject === "string") {
      if (!config.testHooks) return res.status(403).json({ error: "test_hooks_disabled" });
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.query.test_subject)) return fail("invalid_request");
      if (!config.tokenEncryptionKey) return res.status(503).json({ error: "encryption_not_configured" });
      await connectUser({ id: req.query.test_subject, email: `${req.query.test_subject}@rank.test`, refreshToken: TEST_REFRESH_TOKEN });
      const code = await saveAuthCode({ clientId, redirectUri, codeChallenge: challenge, userId: req.query.test_subject, scope });
      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      if (state) url.searchParams.set("state", state);
      return res.redirect(url.toString());
    }

    if (!config.tokenEncryptionKey || !googleOAuthConfigured(config)) {
      return res.status(503).type("html").send(messagePage(config, "Setup needed", "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and TOKEN_ENCRYPTION_KEY before connecting."));
    }
    const id = randomToken(16);
    const exp = now().getTime() + CODE_TTL_MS;
    await store.put("pending_auth", id, {
      kind: "mcp",
      createdAt: now().toISOString(),
      expiresAt: new Date(exp).toISOString(),
      clientId,
      redirectUri,
      codeChallenge: challenge,
      scope,
      state
    });
    res.redirect(googleAuthUrl(config, signPayload({ id, exp }, config.tokenEncryptionKey)));
  });

  app.get("/google/start", async (req, res) => {
    if (!allow(`google:${req.ip}`, 30, 60 * 60 * 1000)) return res.status(429).type("html").send(messagePage(config, "Slow down", "Try the Google connection again in a little while."));
    if (!config.tokenEncryptionKey || !googleOAuthConfigured(config)) {
      return res.status(503).type("html").send(messagePage(config, "Setup needed", "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and TOKEN_ENCRYPTION_KEY before connecting Google."));
    }
    const id = randomToken(16);
    const exp = now().getTime() + CODE_TTL_MS;
    await store.put("pending_auth", id, {
      kind: "account",
      returnTo: localReturn(req.query.return),
      createdAt: now().toISOString(),
      expiresAt: new Date(exp).toISOString()
    });
    res.redirect(googleAuthUrl(config, signPayload({ id, exp }, config.tokenEncryptionKey)));
  });

  app.get("/google/callback", async (req, res) => {
    if (typeof req.query.error === "string") {
      return res.status(400).type("html").send(messagePage(config, "Google connection cancelled", "Google did not grant Search Console access."));
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const parsed = config.tokenEncryptionKey ? readSignedPayload<{ id?: string; exp?: number }>(state, config.tokenEncryptionKey) : null;
    if (!code || !parsed?.id || typeof parsed.exp !== "number" || parsed.exp < now().getTime()) {
      return res.status(400).type("html").send(messagePage(config, "Connection expired", "Start the Google connection again."));
    }
    const pending = await store.get("pending_auth", parsed.id);
    if (!pending || typeof pending.expiresAt !== "string" || new Date(pending.expiresAt).getTime() < now().getTime()) {
      return res.status(400).type("html").send(messagePage(config, "Connection expired", "Start the Google connection again."));
    }
    try {
      const tokens = await exchangeGoogleCode(config, code, fetchImpl);
      const profile = await fetchGoogleProfile(tokens.accessToken, fetchImpl);
      if (!tokens.refreshToken) {
        const existing = await getUser(store, profile.sub);
        if (!existing?.encryptedRefreshToken) {
          return res.status(400).type("html").send(messagePage(config, "Refresh token missing", "Google did not return a refresh token. Remove Rank's access in your Google Account permissions, then connect again."));
        }
      }
      const user = await connectUser({ id: profile.sub, email: profile.email, refreshToken: tokens.refreshToken });
      setSession(res, user.id);
      if (pending.kind === "mcp") {
        await store.put("pending_auth", parsed.id, { ...pending, userId: user.id });
        return res.redirect(`/oauth/consent?authorization_id=${encodeURIComponent(parsed.id)}`);
      }
      await store.delete("pending_auth", parsed.id);
      return res.redirect(localReturn(pending.returnTo));
    } catch (error) {
      const message = error instanceof RankError ? error.message : "Google connection failed.";
      return res.status(400).type("html").send(messagePage(config, "Connection failed", message));
    }
  });

  app.get("/oauth/consent", async (req, res) => {
    const id = String(req.query.authorization_id ?? "");
    const pending = await store.get("pending_auth", id);
    const session = await readSession(req);
    if (!pending || pending.kind !== "mcp" || !session || session.id !== pending.userId || typeof pending.redirectUri !== "string") {
      return res.status(400).type("html").send(messagePage(config, "Consent unavailable", "Start the connection from your assistant again."));
    }
    const client = typeof pending.clientId === "string" ? await store.get("clients", pending.clientId) : null;
    res.type("html").send(consentPage(config, {
      clientName: typeof client?.clientName === "string" ? client.clientName : "this application",
      redirectUri: pending.redirectUri,
      authorizationId: id
    }));
  });

  app.post("/oauth/decision", async (req, res) => {
    const id = String(req.body?.authorization_id ?? "");
    const pending = await store.get("pending_auth", id);
    const session = await readSession(req);
    if (!pending || pending.kind !== "mcp" || !session || session.id !== pending.userId || typeof pending.redirectUri !== "string" || typeof pending.codeChallenge !== "string" || typeof pending.clientId !== "string") {
      return res.status(400).type("html").send(messagePage(config, "Consent unavailable", "Start the connection from your assistant again."));
    }
    const url = new URL(pending.redirectUri);
    if (typeof pending.state === "string" && pending.state) url.searchParams.set("state", pending.state);
    await store.delete("pending_auth", id);
    if (req.body?.decision !== "approve") {
      url.searchParams.set("error", "access_denied");
      return res.redirect(url.toString());
    }
    const code = await saveAuthCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      userId: session.id,
      scope: typeof pending.scope === "string" ? pending.scope : MCP_SCOPE
    });
    url.searchParams.set("code", code);
    res.redirect(url.toString());
  });

  app.post("/token", async (req, res) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    if (!allow(`token:${req.ip}`, 60, 60 * 1000)) return res.status(429).json({ error: "slow_down" });
    const clientId = String(req.body?.client_id ?? "");
    const client = await store.get("clients", clientId);
    if (!client) return res.status(400).json({ error: "invalid_client" });
    const resource = typeof req.body?.resource === "string" ? req.body.resource : "";
    if (resource && resource !== `${config.appBaseUrl}/mcp`) return res.status(400).json({ error: "invalid_target" });
    const grant = String(req.body?.grant_type ?? "");
    if (grant === "authorization_code") {
      const code = String(req.body?.code ?? "");
      const redirectUri = String(req.body?.redirect_uri ?? "");
      const verifier = String(req.body?.code_verifier ?? "");
      const id = sha256(code);
      const record = await store.get("auth_codes", id);
      const challenge = typeof record?.codeChallenge === "string" ? record.codeChallenge : "";
      const expired = !record || typeof record.expiresAt !== "string" || new Date(record.expiresAt).getTime() <= now().getTime();
      const verifierOk = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && safeEqual(pkceS256(verifier), challenge);
      if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri || expired || !verifierOk || typeof record.userId !== "string") {
        if (record) await store.delete("auth_codes", id);
        return res.status(400).json({ error: "invalid_grant" });
      }
      await store.delete("auth_codes", id);
      return res.json(await issueTokens(record.userId, clientId, typeof record.scope === "string" ? record.scope : MCP_SCOPE));
    }
    if (grant === "refresh_token") {
      const refresh = String(req.body?.refresh_token ?? "");
      const id = sha256(refresh);
      const record = await store.get("refresh_tokens", id);
      if (!record || record.clientId !== clientId || typeof record.userId !== "string" || typeof record.expiresAt !== "string" || new Date(record.expiresAt).getTime() <= now().getTime()) {
        if (record) await store.delete("refresh_tokens", id);
        return res.status(400).json({ error: "invalid_grant" });
      }
      await store.delete("refresh_tokens", id);
      return res.json(await issueTokens(record.userId, clientId, typeof record.scope === "string" ? record.scope : MCP_SCOPE));
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  app.post("/billing/checkout", async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Sign in first." });
    const plan = req.body?.plan === "yearly" || req.body?.plan === "annual" ? "yearly" : req.body?.plan === "monthly" ? "monthly" : null;
    if (!plan) return res.status(400).json({ error: "Choose monthly or yearly." });
    try {
      const params = buildCheckoutParams(config, user, plan, now());
      const session = await stripePost<{ id: string; url: string }>(config, "checkout/sessions", params, fetchImpl);
      res.json({ id: session.id, url: session.url });
    } catch (error) {
      const status = error instanceof RankError ? error.status : 400;
      res.status(status).json({ error: error instanceof RankError ? error.message : "Unable to start checkout." });
    }
  });

  app.post("/billing/portal", async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Sign in first." });
    if (!user.stripeCustomerId) return res.status(400).json({ error: "No Stripe customer exists for this account yet." });
    try {
      const params = new URLSearchParams({ customer: user.stripeCustomerId, return_url: `${config.appBaseUrl}/account` });
      const session = await stripePost<{ url: string }>(config, "billing_portal/sessions", params, fetchImpl);
      res.json({ url: session.url });
    } catch (error) {
      res.status(error instanceof RankError ? error.status : 400).json({ error: "Unable to open billing management." });
    }
  });

  function originAllowed(origin: string | undefined) {
    if (!origin) return true;
    return origin === config.appBaseUrl || (MCP_BROWSER_ORIGINS as readonly string[]).includes(origin);
  }

  const mcpCors = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
    "Access-Control-Max-Age": "600"
  };

  function guardMcp(req: Request, res: Response) {
    const origin = req.header("origin");
    if (!originAllowed(origin)) {
      res.status(403).json({ error: "Origin is not allowed." });
      return false;
    }
    if (origin) res.set({ ...mcpCors, "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    return true;
  }

  app.options("/mcp", (req, res) => {
    if (!guardMcp(req, res)) return;
    res.status(204).end();
  });

  app.get("/mcp", (req, res) => {
    if (!guardMcp(req, res)) return;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${config.appBaseUrl}/.well-known/oauth-protected-resource/mcp"`);
    res.status(405).json({ error: "Use Streamable HTTP POST with your Rank connection." });
  });

  app.post("/mcp", async (req, res) => {
    if (!guardMcp(req, res)) return;
    if (!allow(`mcp:${req.ip}`, 300, 60 * 1000)) return res.status(429).json({ error: "Too many requests. Retry in one minute." });
    const method = req.body?.method;
    const publicMethods = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);
    let user: UserRecord | null = null;
    if (!publicMethods.has(method)) {
      user = await userFromAccessToken(bearer(req));
      if (!user) {
        res.set("WWW-Authenticate", `Bearer resource_metadata="${config.appBaseUrl}/.well-known/oauth-protected-resource/mcp"`);
        return res.status(401).json({ error: "Sign in to Rank to use these tools." });
      }
    }
    try {
      const server = createRankServer(user ? {
        config,
        user,
        now: now(),
        gsc: createGscClient(config, user, fetchImpl, cache, now)
      } : null);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error instanceof Error ? error.name : "mcp_failed");
      if (!res.headersSent) res.status(500).json({ error: "Unable to process the plugin request." });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const tooLarge = typeof error === "object" && error !== null && "type" in error && (error as { type?: string }).type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({ error: "Invalid or oversized request." });
  });

  return app;
}
