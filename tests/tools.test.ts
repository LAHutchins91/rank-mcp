import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RankError } from "../src/errors.js";
import { encryptString } from "../src/secrets.js";
import { executeTool, TOOL_NAMES } from "../src/tools.js";
import { newTrial, type UserRecord } from "../src/users.js";

const now = new Date("2026-04-01T00:00:00.000Z");
const key = "tool-test-key";

function user(patch: Partial<UserRecord> = {}): UserRecord {
  const trial = newTrial(now);
  return {
    id: "owner",
    email: "owner@example.com",
    googleSubject: "owner",
    encryptedRefreshToken: encryptString("refresh", key),
    trialStartedAt: trial.trialStartedAt,
    trialEndsAt: trial.trialEndsAt,
    subscriptionStatus: "trialing",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...patch
  };
}

const gsc = {
  async listSites() {
    return { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "SITE_OWNER" }] };
  },
  async searchAnalytics(_siteUrl: string, body: Record<string, unknown>) {
    const dimensions = body.dimensions as string[] | undefined;
    if (dimensions?.includes("DATE")) {
      return { rows: [{ keys: ["2026-03-01"], clicks: 3, impressions: 40, ctr: 0.075, position: 6.5 }] };
    }
    if (dimensions?.includes("QUERY")) {
      return {
        rows: [
          { keys: ["best coffee grinder"], clicks: 12, impressions: 980, ctr: 0.012244897959183673, position: 8.4 },
          { keys: ["buy espresso machine"], clicks: 80, impressions: 400, ctr: 0.2, position: 2.2 }
        ]
      };
    }
    if (dimensions?.includes("PAGE")) {
      if (body.startDate === "2026-02-01") {
        return { rows: [{ keys: ["https://example.com/gone"], clicks: 7, impressions: 150, ctr: 0.04666666666666667, position: 4 }] };
      }
      return { rows: [{ keys: ["https://example.com/grinders"], clicks: 4, impressions: 220, ctr: 0.01818181818181818, position: 14 }] };
    }
    if (body.startDate === "2026-02-01") return { rows: [{ clicks: 55, impressions: 900, ctr: 0.06111111111111111, position: 5 }] };
    return { rows: [{ clicks: 40, impressions: 1000, ctr: 0.04, position: 7.25 }] };
  },
  async inspectUrl() {
    return { inspectionResult: { indexStatusResult: { verdict: "PASS", lastCrawlTime: "2026-03-20T11:04:05Z" } } };
  }
};

const deps = {
  config: loadConfig({ APP_BASE_URL: "http://127.0.0.1:44721", TOKEN_ENCRYPTION_KEY: key }),
  user: user(),
  now,
  gsc
};

describe("tool handlers", () => {
  it("covers every registered tool name", () => {
    expect(TOOL_NAMES).toEqual([
      "list_properties",
      "top_queries",
      "top_pages",
      "performance_trends",
      "compare_periods",
      "quick_wins",
      "dropped_pages",
      "inspect_url",
      "account_status"
    ]);
  });

  it("returns the sites.list entries unchanged", async () => {
    const result = await executeTool("list_properties", {}, deps) as { properties: unknown[] };
    expect(result.properties).toEqual([{ siteUrl: "sc-domain:example.com", permissionLevel: "SITE_OWNER" }]);
  });

  it("returns query metrics exactly", async () => {
    const result = await executeTool("top_queries", { siteUrl: "https://example.com/", startDate: "2026-03-01", endDate: "2026-03-28" }, deps) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0].ctr).toBe(0.012244897959183673);
    expect(result.rows[0].position).toBe(8.4);
  });

  it("returns page metrics exactly", async () => {
    const result = await executeTool("top_pages", { siteUrl: "https://example.com/", startDate: "2026-03-01", endDate: "2026-03-28" }, deps) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({ page: "https://example.com/grinders", clicks: 4, position: 14 });
  });

  it("returns daily rows without inventing the missing day", async () => {
    const result = await executeTool("performance_trends", { siteUrl: "sc-domain:example.com", startDate: "2026-03-01", endDate: "2026-03-03" }, deps) as { rows: Array<{ date: string }> };
    expect(result.rows.map((row) => row.date)).toEqual(["2026-03-01"]);
  });

  it("compares period totals from the two API responses", async () => {
    const result = await executeTool("compare_periods", {
      siteUrl: "https://example.com/",
      startDate: "2026-03-01",
      endDate: "2026-03-28",
      compareStartDate: "2026-02-01",
      compareEndDate: "2026-02-28"
    }, deps) as { current: { clicks: number }; previous: { clicks: number }; differenceFromReturnedMetrics: { clicks: number } };
    expect(result.current.clicks).toBe(40);
    expect(result.previous.clicks).toBe(55);
    expect(result.differenceFromReturnedMetrics.clicks).toBe(40 - 55);
  });

  it("keeps only low-ctr queries and does not estimate clicks", async () => {
    const result = await executeTool("quick_wins", { siteUrl: "https://example.com/", startDate: "2026-03-01", endDate: "2026-03-28" }, deps) as { rows: Array<Record<string, unknown>> };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].query).toBe("best coffee grinder");
    expect(result.rows[0].ctr).toBe(0.012244897959183673);
    expect(result.rows[0]).not.toHaveProperty("potentialClicks");
  });

  it("marks a page absent instead of zero", async () => {
    const result = await executeTool("dropped_pages", {
      siteUrl: "https://example.com/",
      startDate: "2026-03-01",
      endDate: "2026-03-28",
      compareStartDate: "2026-02-01",
      compareEndDate: "2026-02-28"
    }, deps) as { pages: Array<{ page: string; current: unknown }> };
    expect(result.pages[0]).toMatchObject({ page: "https://example.com/gone", current: null });
  });

  it("returns the URL inspection payload unchanged", async () => {
    const result = await executeTool("inspect_url", { siteUrl: "https://example.com/", inspectionUrl: "https://example.com/grinders" }, deps) as { apiResponse: { inspectionResult: { indexStatusResult: { verdict: string; lastCrawlTime: string } } } };
    expect(result.apiResponse.inspectionResult.indexStatusResult).toEqual({
      verdict: "PASS",
      lastCrawlTime: "2026-03-20T11:04:05Z"
    });
  });

  it("reports trial status without a price", async () => {
    const result = await executeTool("account_status", {}, deps) as { entitled: boolean; trialEndsAt: string };
    expect(result.entitled).toBe(true);
    expect(result.trialEndsAt).toBe(newTrial(now).trialEndsAt);
    expect(JSON.stringify(result)).not.toMatch(/\$\d/);
  });

  it("does not call Search Console after the trial ends", async () => {
    let called = false;
    const expired = user({
      trialStartedAt: "2026-01-01T00:00:00.000Z",
      trialEndsAt: "2026-01-15T00:00:00.000Z",
      subscriptionStatus: "trialing"
    });
    await expect(executeTool("list_properties", {}, {
      ...deps,
      user: expired,
      gsc: { ...gsc, listSites: async () => { called = true; return {}; } }
    })).rejects.toMatchObject({ code: "subscription_required" });
    expect(called).toBe(false);
  });

  it("rejects a siteUrl that is not a property", async () => {
    await expect(executeTool("top_queries", { siteUrl: "not a url" }, deps)).rejects.toBeInstanceOf(RankError);
  });
});
