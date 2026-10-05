import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { GOOGLE_TOKEN_ENDPOINT, GOOGLE_SCOPES, googleRedirectUri } from "../src/config.js";
import { decryptString } from "../src/secrets.js";
import { createMemoryStore } from "../src/storage.js";
import { TOOL_NAMES } from "../src/tools.js";

const clock = { time: Date.parse("2026-04-01T00:00:00.000Z") };
const encryptionKey = "http-test-encryption-key";
const store = createMemoryStore();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === GOOGLE_TOKEN_ENDPOINT) return json({ access_token: "ya29.test-access", expires_in: 3600, token_type: "Bearer" });
  if (url.endsWith("/webmasters/v3/sites")) {
    return json({ siteEntry: [{ siteUrl: "https://example.com/", permissionLevel: "SITE_OWNER" }] });
  }
  if (url.includes("/searchAnalytics/query")) {
    const body = JSON.parse(String(init?.body)) as { dimensions?: string[]; startDate?: string };
    if (body.dimensions?.includes("DATE")) {
      return json({
        responseAggregationType: "AUTO",
        rows: [
          { keys: ["2026-03-01"], clicks: 3, impressions: 40, ctr: 0.075, position: 6.5 },
          { keys: ["2026-03-03"], clicks: 1, impressions: 22, ctr: 0.045454545454545456, position: 9 }
        ]
      });
    }
    if (body.dimensions?.includes("QUERY")) {
      return json({
        rows: [
          { keys: ["best coffee grinder"], clicks: 12, impressions: 980, ctr: 0.012244897959183673, position: 8.4 },
          { keys: ["buy espresso machine"], clicks: 80, impressions: 400, ctr: 0.2, position: 2.2 }
        ]
      });
    }
    if (body.dimensions?.includes("PAGE")) {
      if (body.startDate === "2026-02-01") {
        return json({
          rows: [
            { keys: ["https://example.com/grinders"], clicks: 9, impressions: 300, ctr: 0.03, position: 6 },
            { keys: ["https://example.com/gone"], clicks: 7, impressions: 150, ctr: 0.04666666666666667, position: 4 },
            { keys: ["https://example.com/kept"], clicks: 10, impressions: 100, ctr: 0.1, position: 3 }
          ]
        });
      }
      return json({
        rows: [
          { keys: ["https://example.com/grinders"], clicks: 4, impressions: 220, ctr: 0.01818181818181818, position: 14 },
          { keys: ["https://example.com/kept"], clicks: 10, impressions: 100, ctr: 0.1, position: 3 }
        ]
      });
    }
    if (body.startDate === "2026-02-01") return json({ rows: [{ clicks: 55, impressions: 900, ctr: 0.06111111111111111, position: 5 }] });
    return json({ rows: [{ clicks: 40, impressions: 1000, ctr: 0.04, position: 7.25 }] });
  }
  if (url.endsWith("/v1/urlInspection/index:inspect")) {
    return json({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-03-20T11:04:05Z" } } });
  }
  if (url.startsWith("https://api.stripe.com/")) {
    const body = String(init?.body);
    if (body.includes("$")) throw new Error("checkout body included a dollar amount");
    return json({ id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test_session" });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const app = createApp({
  env: {
    NODE_ENV: "test",
    RANK_TEST_HOOKS: "1",
    APP_BASE_URL: "http://127.0.0.1:44721",
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_PRICE_MONTHLY: "price_month",
    STRIPE_PRICE_YEARLY: "price_year",
    STRIPE_WEBHOOK_SECRET: "whsec_test"
  },
  store,
  fetchImpl,
  now: () => new Date(clock.time)
});

let server: Server;
let base = "";

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function login() {
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Rank test",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  const client = await registered.json() as { client_id: string };
  const { verifier, challenge } = pkce();
  const authorize = new URL(`${base}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.client_id);
  authorize.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "state-1");
  authorize.searchParams.set("scope", "rank");
  authorize.searchParams.set("resource", "http://127.0.0.1:44721/mcp");
  authorize.searchParams.set("test_subject", "owner");
  const redirected = await fetch(authorize, { redirect: "manual" });
  const location = new URL(redirected.headers.get("location") ?? "");
  const tokenResponse = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: location.searchParams.get("code") ?? "",
      redirect_uri: "http://127.0.0.1/callback",
      client_id: client.client_id,
      code_verifier: verifier
    })
  });
  const token = await tokenResponse.json() as { access_token: string; refresh_token: string };
  return { clientId: client.client_id, verifier, token, location };
}

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function callTool(accessToken: string, name: string, args: Record<string, unknown>) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const client = new Client({ name: "rank-http-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    return { result, data: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

describe("streamable HTTP", () => {
  it("serves health, the logo, and a price-free landing page", async () => {
    const health = await fetch(`${base}/health`).then((response) => response.json()) as { ok: boolean; billingConfigured: boolean; googleRedirectUri: string };
    expect(health.ok).toBe(true);
    expect(health.billingConfigured).toBe(true);
    expect(health.googleRedirectUri).toBe(googleRedirectUri("http://127.0.0.1:44721"));
    const logo = await fetch(`${base}/logo.jpg`);
    expect(logo.headers.get("content-type")).toContain("image/jpeg");
    expect((await logo.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const html = await fetch(`${base}/`).then((response) => response.text());
    expect(html).toContain("Rank by Ouroboros");
    expect(html).toContain("/logo.jpg");
    expect(html).not.toMatch(/\$\d/);
    const connect = await fetch(`${base}/connect`).then((response) => response.text());
    for (const scope of GOOGLE_SCOPES) expect(connect).toContain(scope);
    expect(connect).toContain("http://127.0.0.1:44721/google/callback");
  });

  it("runs OAuth PKCE and every tool over Streamable HTTP", async () => {
    const { token, location } = await login();
    expect(location.searchParams.get("state")).toBe("state-1");
    const saved = await store.get("users", "owner");
    expect(String(saved?.encryptedRefreshToken)).not.toContain("test-refresh-token");
    expect(decryptString(String(saved?.encryptedRefreshToken), encryptionKey)).toBe("test-refresh-token");

    const anonymous = new Client({ name: "rank-anon", version: "0.0.0" });
    const anonTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await anonymous.connect(anonTransport);
    const listed = await anonymous.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    await anonymous.close();

    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_properties", arguments: {} } })
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");

    const range = { siteUrl: "https://example.com/", startDate: "2026-03-01", endDate: "2026-03-28", compareStartDate: "2026-02-01", compareEndDate: "2026-02-28" };
    const properties = await callTool(token.access_token, "list_properties", {});
    expect(properties.data.properties).toEqual([{ siteUrl: "https://example.com/", permissionLevel: "SITE_OWNER" }]);

    const queries = await callTool(token.access_token, "top_queries", range);
    expect((queries.data.rows as Array<{ ctr: number }>)[0].ctr).toBe(0.012244897959183673);

    const pages = await callTool(token.access_token, "top_pages", range);
    expect((pages.data.rows as Array<{ page: string; clicks: number }>)[0]).toMatchObject({ page: "https://example.com/grinders", clicks: 4 });

    const trends = await callTool(token.access_token, "performance_trends", range);
    expect((trends.data.rows as Array<{ date: string }>).map((row) => row.date)).toEqual(["2026-03-01", "2026-03-03"]);

    const compared = await callTool(token.access_token, "compare_periods", range);
    expect(compared.data.current).toMatchObject({ clicks: 40, impressions: 1000, ctr: 0.04, position: 7.25 });
    expect(compared.data.previous).toMatchObject({ clicks: 55, position: 5 });

    const wins = await callTool(token.access_token, "quick_wins", range);
    expect(wins.data.rows).toHaveLength(1);
    expect((wins.data.rows as Array<{ query: string }>)[0].query).toBe("best coffee grinder");

    const dropped = await callTool(token.access_token, "dropped_pages", range);
    const droppedPages = dropped.data.pages as Array<{ page: string; current: unknown }>;
    expect(droppedPages.find((page) => page.page === "https://example.com/gone")?.current).toBeNull();

    const inspection = await callTool(token.access_token, "inspect_url", { siteUrl: "https://example.com/", inspectionUrl: "https://example.com/grinders" });
    expect(inspection.data.apiResponse).toMatchObject({ inspectionResult: { indexStatusResult: { verdict: "PASS", lastCrawlTime: "2026-03-20T11:04:05Z" } } });

    const status = await callTool(token.access_token, "account_status", {});
    expect(status.data.entitled).toBe(true);
    expect(status.data.googleConnected).toBe(true);
    expect(JSON.stringify(status.data)).not.toMatch(/\$\d/);

    const checkout = await fetch(`${base}/billing/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan: "monthly" })
    });
    const checkoutBody = await checkout.json() as { url: string };
    expect(checkout.status).toBe(200);
    expect(checkoutBody.url).toBe("https://checkout.stripe.com/c/pay/cs_test_session");
  });

  it("sends Google the read-only Search Console scope and the configured redirect URI", async () => {
    const response = await fetch(`${base}/google/start?return=/account`, { redirect: "manual" });
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    expect(location.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:44721/google/callback");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
  });

  it("rejects a public http redirect and a bad PKCE verifier", async () => {
    const evil = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/callback"] })
    });
    expect(evil.status).toBe(400);

    const { clientId } = await login();
    const { challenge } = pkce();
    const authorize = new URL(`${base}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("test_subject", "owner");
    const redirected = await fetch(authorize, { redirect: "manual" });
    const location = new URL(redirected.headers.get("location") ?? "");
    const tokenResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        redirect_uri: "http://127.0.0.1/callback",
        client_id: clientId,
        code_verifier: "a".repeat(50)
      })
    });
    expect(tokenResponse.status).toBe(400);
  });
});
