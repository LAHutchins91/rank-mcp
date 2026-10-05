import { shapeAnalytics, compareResponses, filterQuickWins, findDroppedPages, asRecord } from "./analytics.js";
import type { AppConfig } from "./config.js";
import { resolveRange, previousWindow, assertRange } from "./dates.js";
import { RankError } from "./errors.js";
import type { GscClient } from "./google.js";
import { isEntitled, type UserRecord } from "./users.js";

export const TOOL_NAMES = [
  "list_properties",
  "top_queries",
  "top_pages",
  "performance_trends",
  "compare_periods",
  "quick_wins",
  "dropped_pages",
  "inspect_url",
  "account_status"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const SEARCH_TYPES = new Map<string, string>([
  ["web", "WEB"], ["image", "IMAGE"], ["video", "VIDEO"], ["news", "NEWS"], ["discover", "DISCOVER"], ["googlenews", "GOOGLE_NEWS"],
  ["WEB", "WEB"], ["IMAGE", "IMAGE"], ["VIDEO", "VIDEO"], ["NEWS", "NEWS"], ["DISCOVER", "DISCOVER"], ["GOOGLE_NEWS", "GOOGLE_NEWS"]
]);

export type ToolDeps = {
  config: AppConfig;
  user: UserRecord;
  now: Date;
  gsc: GscClient;
};

function requireEntitled(deps: ToolDeps) {
  if (!deps.user.encryptedRefreshToken) {
    throw new RankError("Connect a Google account that can read Search Console.", "google_not_connected", 403, {
      connectUrl: `${deps.config.appBaseUrl}/google/start?return=/account`
    });
  }
  if (!isEntitled(deps.user, deps.now)) {
    throw new RankError("The 14-day trial has ended. Subscribe to Pro to query Search Console.", "subscription_required", 402, {
      subscribeUrl: `${deps.config.appBaseUrl}/account`,
      trialEndsAt: deps.user.trialEndsAt,
      subscriptionStatus: deps.user.subscriptionStatus
    });
  }
}

export function assertSiteUrl(siteUrl: string) {
  if (typeof siteUrl !== "string" || !siteUrl || siteUrl.length > 2048) {
    throw new RankError("siteUrl is required.", "invalid_site");
  }
  if (siteUrl.startsWith("sc-domain:")) {
    const host = siteUrl.slice("sc-domain:".length);
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new RankError("Domain properties use sc-domain:hostname.", "invalid_site");
    return siteUrl;
  }
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new RankError("siteUrl must be a URL-prefix property or sc-domain:hostname.", "invalid_site");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RankError("siteUrl must be an http or https URL-prefix property.", "invalid_site");
  }
  return siteUrl;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function searchBody(args: Record<string, unknown>, startDate: string, endDate: string, dimensions?: string[]) {
  const body: Record<string, unknown> = { startDate, endDate };
  if (dimensions?.length) body.dimensions = dimensions;
  const filters: Array<Record<string, string>> = [];
  const country = optionalString(args.country);
  if (country) {
    if (!/^[A-Za-z]{3}$/.test(country)) throw new RankError("country must be a 3-letter ISO code.", "invalid_filter");
    filters.push({ dimension: "COUNTRY", operator: "EQUALS", expression: country });
  }
  const device = optionalString(args.device)?.toUpperCase();
  if (device) {
    if (!["DESKTOP", "MOBILE", "TABLET"].includes(device)) throw new RankError("device must be DESKTOP, MOBILE, or TABLET.", "invalid_filter");
    filters.push({ dimension: "DEVICE", operator: "EQUALS", expression: device });
  }
  if (filters.length) body.dimensionFilterGroups = [{ groupType: "AND", filters }];
  const searchType = optionalString(args.searchType);
  if (searchType) {
    const mapped = SEARCH_TYPES.get(searchType) ?? SEARCH_TYPES.get(searchType.toLowerCase());
    if (!mapped) throw new RankError("searchType must be web, image, video, news, discover, or googleNews.", "invalid_filter");
    body.searchType = mapped;
  }
  return body;
}

async function collectRows(gsc: GscClient, siteUrl: string, body: Record<string, unknown>, maxRows: number) {
  const rows: unknown[] = [];
  let startRow = 0;
  let truncated = false;
  let responseAggregationType: string | undefined;
  let metadata: unknown;
  while (rows.length < maxRows) {
    const rowLimit = Math.min(1000, maxRows - rows.length);
    const page = await gsc.searchAnalytics(siteUrl, { ...body, rowLimit, startRow });
    const record = asRecord(page) ?? {};
    if (typeof record.responseAggregationType === "string") responseAggregationType = record.responseAggregationType;
    if (asRecord(record.metadata)) metadata = record.metadata;
    const batch = Array.isArray(record.rows) ? record.rows : [];
    rows.push(...batch);
    if (!Array.isArray(record.rows) || batch.length < rowLimit) break;
    startRow += batch.length;
    if (rows.length >= maxRows) truncated = true;
  }
  return { rows, truncated, responseAggregationType, metadata };
}

function limitOf(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new RankError(`limit must be an integer from 1 to ${max}.`, "invalid_limit");
  }
  return value;
}

export async function executeTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  if (name === "account_status") {
    return {
      email: deps.user.email,
      googleConnected: Boolean(deps.user.encryptedRefreshToken),
      trialStartedAt: deps.user.trialStartedAt,
      trialEndsAt: deps.user.trialEndsAt,
      subscriptionStatus: deps.user.subscriptionStatus,
      entitled: isEntitled(deps.user, deps.now),
      hasStripeCustomer: Boolean(deps.user.stripeCustomerId),
      subscribeUrl: `${deps.config.appBaseUrl}/account`,
      connectUrl: `${deps.config.appBaseUrl}/google/start?return=/account`
    };
  }

  requireEntitled(deps);

  if (name === "list_properties") {
    const body = await deps.gsc.listSites();
    const record = asRecord(body) ?? {};
    const siteEntry = Array.isArray(record.siteEntry) ? record.siteEntry : [];
    return {
      source: "google_search_console_sites_list",
      apiReturnedSiteEntry: Array.isArray(record.siteEntry),
      properties: siteEntry
    };
  }

  const siteUrl = assertSiteUrl(String(args.siteUrl ?? ""));
  const range = resolveRange(deps.now, optionalString(args.startDate), optionalString(args.endDate));

  if (name === "inspect_url") {
    const inspectionUrl = optionalString(args.inspectionUrl);
    if (!inspectionUrl) throw new RankError("inspectionUrl is required.", "invalid_url");
    let parsed: URL;
    try {
      parsed = new URL(inspectionUrl);
    } catch {
      throw new RankError("inspectionUrl must be an absolute http or https URL.", "invalid_url");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new RankError("inspectionUrl must be an absolute http or https URL.", "invalid_url");
    }
    const request: Record<string, string> = { siteUrl, inspectionUrl };
    const languageCode = optionalString(args.languageCode);
    if (languageCode) request.languageCode = languageCode;
    const apiResponse = await deps.gsc.inspectUrl(request);
    return {
      source: "google_search_console_url_inspection",
      siteUrl,
      inspectionUrl,
      apiResponse
    };
  }

  if (name === "top_queries" || name === "top_pages") {
    const dimension = name === "top_queries" ? "QUERY" : "PAGE";
    const label = name === "top_queries" ? "query" : "page";
    const rowLimit = limitOf(args.limit, 25, 250);
    const request = { ...searchBody(args, range.startDate, range.endDate, [dimension]), rowLimit };
    const apiResponse = await deps.gsc.searchAnalytics(siteUrl, request);
    return {
      source: "google_search_console_search_analytics",
      siteUrl,
      ...range,
      request,
      note: "Row order is the order Search Console returned. clicks, impressions, ctr, and position are copied from each API row. ctr is the API fraction between 0 and 1.",
      ...shapeAnalytics(apiResponse, label)
    };
  }

  if (name === "performance_trends") {
    const request = { ...searchBody(args, range.startDate, range.endDate, ["DATE"]), rowLimit: 1000 };
    const apiResponse = await deps.gsc.searchAnalytics(siteUrl, request);
    return {
      source: "google_search_console_search_analytics",
      siteUrl,
      ...range,
      request,
      note: "One row per date the API returned. Dates the API omitted are not filled in. ctr is the API fraction between 0 and 1.",
      ...shapeAnalytics(apiResponse, "date")
    };
  }

  if (name === "compare_periods") {
    let compareStartDate = optionalString(args.compareStartDate);
    let compareEndDate = optionalString(args.compareEndDate);
    let comparisonRangeDefaulted = false;
    if (!compareStartDate && !compareEndDate) {
      const previous = previousWindow(range.startDate, range.endDate);
      compareStartDate = previous.compareStartDate;
      compareEndDate = previous.compareEndDate;
      comparisonRangeDefaulted = true;
    } else if (!compareStartDate || !compareEndDate) {
      throw new RankError("Pass both compareStartDate and compareEndDate, or neither to use the previous window of the same length.", "invalid_date");
    } else {
      assertRange(compareStartDate, compareEndDate);
    }
    const currentRequest = { ...searchBody(args, range.startDate, range.endDate), rowLimit: 1 };
    const previousRequest = { ...searchBody(args, compareStartDate, compareEndDate), rowLimit: 1 };
    const [currentResponse, previousResponse] = await Promise.all([
      deps.gsc.searchAnalytics(siteUrl, currentRequest),
      deps.gsc.searchAnalytics(siteUrl, previousRequest)
    ]);
    return {
      source: "google_search_console_search_analytics",
      siteUrl,
      currentRange: { startDate: range.startDate, endDate: range.endDate, dateRangeDefaulted: range.dateRangeDefaulted },
      previousRange: { startDate: compareStartDate, endDate: compareEndDate, comparisonRangeDefaulted },
      note: "current and previous are the metric objects Search Console returned for each range with no dimension grouping. differenceFromReturnedMetrics subtracts previous from current only when both responses included that metric. It is not a Search Console field. Empty API results stay null instead of zero.",
      ...compareResponses(currentResponse, previousResponse)
    };
  }

  if (name === "quick_wins") {
    const minImpressions = typeof args.minImpressions === "number" ? args.minImpressions : 100;
    const maxCtr = typeof args.maxCtr === "number" ? args.maxCtr : 0.02;
    if (!Number.isFinite(minImpressions) || minImpressions < 0) throw new RankError("minImpressions must be a non-negative number.", "invalid_filter");
    if (!Number.isFinite(maxCtr) || maxCtr < 0 || maxCtr > 1) throw new RankError("maxCtr must be a fraction from 0 to 1, matching Search Console ctr.", "invalid_filter");
    const rowLimit = limitOf(args.limit, 25, 100);
    const request = { ...searchBody(args, range.startDate, range.endDate, ["QUERY"]) };
    const collected = await collectRows(deps.gsc, siteUrl, request, 5000);
    const matches = filterQuickWins(collected.rows, minImpressions, maxCtr);
    return {
      source: "google_search_console_search_analytics",
      siteUrl,
      ...range,
      thresholds: { minImpressions, maxCtr },
      request,
      scannedRowCount: collected.rows.length,
      scanTruncated: collected.truncated,
      responseAggregationType: collected.responseAggregationType,
      metadata: collected.metadata,
      note: "Each row is a Search Console query row whose returned impressions and ctr met the thresholds. ctr is the API fraction. No click estimate is added.",
      matched: matches.length,
      rows: matches.slice(0, rowLimit)
    };
  }

  if (name === "dropped_pages") {
    let compareStartDate = optionalString(args.compareStartDate);
    let compareEndDate = optionalString(args.compareEndDate);
    let comparisonRangeDefaulted = false;
    if (!compareStartDate && !compareEndDate) {
      const previous = previousWindow(range.startDate, range.endDate);
      compareStartDate = previous.compareStartDate;
      compareEndDate = previous.compareEndDate;
      comparisonRangeDefaulted = true;
    } else if (!compareStartDate || !compareEndDate) {
      throw new RankError("Pass both compareStartDate and compareEndDate, or neither to use the previous window of the same length.", "invalid_date");
    } else {
      assertRange(compareStartDate, compareEndDate);
    }
    const rowLimit = limitOf(args.limit, 25, 100);
    const currentRequest = searchBody(args, range.startDate, range.endDate, ["PAGE"]);
    const previousRequest = searchBody(args, compareStartDate, compareEndDate, ["PAGE"]);
    const [currentCollected, previousCollected] = await Promise.all([
      collectRows(deps.gsc, siteUrl, currentRequest, 2000),
      collectRows(deps.gsc, siteUrl, previousRequest, 2000)
    ]);
    const dropped = findDroppedPages(currentCollected.rows, previousCollected.rows);
    return {
      source: "google_search_console_search_analytics",
      siteUrl,
      currentRange: { startDate: range.startDate, endDate: range.endDate, dateRangeDefaulted: range.dateRangeDefaulted },
      previousRange: { startDate: compareStartDate, endDate: compareEndDate, comparisonRangeDefaulted },
      scanTruncated: currentCollected.truncated || previousCollected.truncated,
      note: "A page is listed when its returned position got worse (a larger number), its returned clicks fell, or it was in the previous response and absent from the current one. current is null in that last case. Missing metrics are omitted, not replaced with zero.",
      matched: dropped.length,
      pages: dropped.slice(0, rowLimit)
    };
  }

  throw new RankError("Unknown tool.", "unknown_tool", 404);
}
