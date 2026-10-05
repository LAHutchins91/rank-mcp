export const SERVER_NAME = "Rank by Ouroboros";
export const SERVER_VERSION = "0.1.0";
export const MCP_SCOPE = "rank";
export const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;

/** Scopes Lawrence must add on the Google consent screen, and the scopes this server requests. */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/webmasters.readonly"
] as const;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
export const SEARCH_CONSOLE_DISCOVERY_URL = "https://www.googleapis.com/discovery/v1/apis/searchconsole/v1/rest";
export const SEARCH_CONSOLE_ORIGIN = "https://searchconsole.googleapis.com";
export const SITES_LIST_PATH = "webmasters/v3/sites";
export const SEARCH_ANALYTICS_PATH_TEMPLATE = "webmasters/v3/sites/{siteUrl}/searchAnalytics/query";
export const URL_INSPECTION_PATH = "v1/urlInspection/index:inspect";

export const MCP_BROWSER_ORIGINS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://claude.ai",
  "https://gemini.google.com",
  "https://grok.com",
  "https://cursor.com",
  "https://www.cursor.com"
] as const;

export type StorageBackend = "memory" | "file" | "postgres" | "blob";

export type AppConfig = {
  appBaseUrl: string;
  port: number;
  googleClientId: string;
  googleClientSecret: string;
  tokenEncryptionKey: string;
  stripeSecretKey: string;
  stripePriceMonthly: string;
  stripePriceYearly: string;
  stripeWebhookSecret: string;
  storageBackend: StorageBackend;
  storageFile: string;
  storageBlobPath: string;
  databaseUrl: string;
  testHooks: boolean;
  nodeEnv: string;
};

export function googleRedirectUri(appBaseUrl: string) {
  return `${appBaseUrl.replace(/\/$/, "")}/google/callback`;
}

export function sitesListUrl() {
  return `${SEARCH_CONSOLE_ORIGIN}/${SITES_LIST_PATH}`;
}

export function searchAnalyticsUrl(siteUrl: string) {
  return `${SEARCH_CONSOLE_ORIGIN}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

export function urlInspectionUrl() {
  return `${SEARCH_CONSOLE_ORIGIN}/${URL_INSPECTION_PATH}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 44721);
  const appBaseUrl = (env.APP_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const nodeEnv = env.NODE_ENV ?? "development";
  const testHooks = env.RANK_TEST_HOOKS === "1";
  if (testHooks && nodeEnv === "production") {
    throw new Error("RANK_TEST_HOOKS must not be set when NODE_ENV is production");
  }
  const storageBackend = env.STORAGE_BACKEND ?? "memory";
  if (storageBackend !== "memory" && storageBackend !== "file" && storageBackend !== "postgres" && storageBackend !== "blob") {
    throw new Error("STORAGE_BACKEND must be memory, file, postgres, or blob");
  }
  return {
    appBaseUrl,
    port: Number.isFinite(port) ? port : 44721,
    googleClientId: env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? "",
    stripeSecretKey: env.STRIPE_SECRET_KEY ?? "",
    stripePriceMonthly: env.STRIPE_PRICE_MONTHLY ?? "",
    stripePriceYearly: env.STRIPE_PRICE_YEARLY ?? "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
    storageBackend,
    storageFile: env.STORAGE_FILE || "./data/rank-store.json",
    storageBlobPath: env.STORAGE_BLOB_PATH || "rank/store.json",
    databaseUrl: env.DATABASE_URL ?? "",
    testHooks,
    nodeEnv
  };
}

export function billingConfigured(config: AppConfig) {
  return Boolean(config.stripeSecretKey && config.stripePriceMonthly && config.stripePriceYearly);
}

export function googleOAuthConfigured(config: AppConfig) {
  return Boolean(config.googleClientId && config.googleClientSecret);
}
