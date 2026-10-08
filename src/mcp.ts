import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { RankError } from "./errors.js";
import { executeTool, type ToolDeps } from "./tools.js";

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const site = z.string().min(1).max(2048);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const searchType = z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional();
const country = z.string().regex(/^[A-Za-z]{3}$/).optional();
const device = z.enum(["DESKTOP", "MOBILE", "TABLET"]).optional();
const range = {
  startDate: day.optional(),
  endDate: day.optional(),
  country,
  device,
  searchType
};

const definitions: Array<{ name: string; title: string; description: string; schema: z.ZodRawShape }> = [
  {
    name: "list_properties",
    title: "List properties",
    description: "List the Search Console properties on the connected Google account. Returns siteUrl and permissionLevel exactly as the sites.list API returned them.",
    schema: {}
  },
  {
    name: "top_queries",
    title: "Top queries",
    description: "Top search queries for one property and date range. clicks, impressions, ctr, and position are copied from Search Console. ctr is a fraction from 0 to 1, not a percent. Omit dates to use the default 28-day window.",
    schema: { siteUrl: site, ...range, limit: z.number().int().min(1).max(250).optional() }
  },
  {
    name: "top_pages",
    title: "Top pages",
    description: "Top pages for one property and date range. Metrics are copied from Search Console rows. ctr is the API fraction from 0 to 1. Omit dates to use the default 28-day window.",
    schema: { siteUrl: site, ...range, limit: z.number().int().min(1).max(250).optional() }
  },
  {
    name: "performance_trends",
    title: "Performance trends",
    description: "Daily clicks, impressions, ctr, and position for a property. Each row is a date Search Console returned. Missing dates are not filled in, and ctr is the API fraction.",
    schema: { siteUrl: site, ...range }
  },
  {
    name: "compare_periods",
    title: "Compare periods",
    description: "Compare two date ranges using the Search Console totals for a property (no dimension grouping). Reports both API metric objects. Differences are labeled as derived from those returned numbers. Omit compare dates to use the previous window of the same length.",
    schema: { siteUrl: site, ...range, compareStartDate: day.optional(), compareEndDate: day.optional() }
  },
  {
    name: "quick_wins",
    title: "Quick wins",
    description: "Queries with high impressions and low ctr in Search Console. Defaults are at least 100 impressions and ctr at or below 0.02 (the API fraction, so 0.02 is 2%). Does not estimate missed clicks.",
    schema: {
      siteUrl: site,
      ...range,
      minImpressions: z.number().min(0).optional(),
      maxCtr: z.number().min(0).max(1).optional(),
      limit: z.number().int().min(1).max(100).optional()
    }
  },
  {
    name: "dropped_pages",
    title: "Dropped pages",
    description: "Pages whose Search Console position got worse, whose clicks fell, or that disappeared from the current response. Does not invent zeros for pages the current response omitted.",
    schema: {
      siteUrl: site,
      ...range,
      compareStartDate: day.optional(),
      compareEndDate: day.optional(),
      limit: z.number().int().min(1).max(100).optional()
    }
  },
  {
    name: "inspect_url",
    title: "Inspect URL",
    description: "URL Inspection status for one URL on a property you can access. Returns the Search Console inspection response, including verdict, coverage, and last crawl fields when the API sent them.",
    schema: { siteUrl: site, inspectionUrl: z.string().url().max(2048), languageCode: z.string().max(35).optional() }
  },
  {
    name: "account_status",
    title: "Account status",
    description: "Whether Google Search Console is connected, when the 14-day trial ends, and whether Pro access is active. Does not query Search Console and does not include a price.",
    schema: {}
  }
];

function toolResult(data: unknown, isError = false) {
  return {
    structuredContent: { data },
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {})
  };
}

export function createRankServer(deps: ToolDeps | null) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  }, {
    instructions: `${SERVER_NAME} answers SEO questions from the user's own Google Search Console account. Report only clicks, impressions, ctr, and position that a tool returned. ctr is a fraction from 0 to 1. Do not estimate traffic, fill missing days with zeros, or invent rankings. If a tool says the trial ended or Google is not connected, send the user to the URL in the tool result.`
  });
  for (const definition of definitions) {
    server.registerTool(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.schema,
      outputSchema: { data: z.unknown() },
      annotations: read,
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["rank"] }] }
    }, async (args) => {
      if (!deps) return toolResult({ error: "not_signed_in", message: "Sign in to Rank to use this tool." }, true);
      try {
        return toolResult(await executeTool(definition.name, args as Record<string, unknown>, deps));
      } catch (error) {
        if (error instanceof RankError) {
          return toolResult({ error: error.code, message: error.message, ...error.details }, true);
        }
        return toolResult({ error: "tool_failed", message: "Rank could not complete this request." }, true);
      }
    });
  }
  return server;
}
