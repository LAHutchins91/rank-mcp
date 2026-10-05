import { describe, expect, it } from "vitest";
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  SEARCH_CONSOLE_DISCOVERY_URL,
  SEARCH_CONSOLE_ORIGIN,
  SITES_LIST_PATH,
  SEARCH_ANALYTICS_PATH_TEMPLATE,
  URL_INSPECTION_PATH,
  searchAnalyticsUrl,
  sitesListUrl,
  urlInspectionUrl
} from "../src/config.js";

describe("live Google discovery documents", () => {
  it("matches the published OAuth and Search Console endpoints", async () => {
    const [openidResponse, discoveryResponse] = await Promise.all([
      fetch("https://accounts.google.com/.well-known/openid-configuration"),
      fetch(SEARCH_CONSOLE_DISCOVERY_URL)
    ]);
    expect(openidResponse.ok).toBe(true);
    expect(discoveryResponse.ok).toBe(true);
    const openid = await openidResponse.json() as { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; scopes_supported?: string[] };
    const discovery = await discoveryResponse.json() as {
      baseUrl: string;
      resources: {
        sites: { methods: { list: { path: string; httpMethod: string; scopes: string[] } } };
        searchanalytics: { methods: { query: { path: string; httpMethod: string; scopes: string[] } } };
        urlInspection: { resources: { index: { methods: { inspect: { path: string; httpMethod: string; scopes: string[] } } } } };
      };
    };
    expect(openid.authorization_endpoint).toBe(GOOGLE_AUTH_ENDPOINT);
    expect(openid.token_endpoint).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(openid.userinfo_endpoint).toBe(GOOGLE_USERINFO_ENDPOINT);
    expect(discovery.baseUrl).toBe(`${SEARCH_CONSOLE_ORIGIN}/`);
    expect(discovery.resources.sites.methods.list).toMatchObject({ httpMethod: "GET", path: SITES_LIST_PATH });
    expect(discovery.resources.searchanalytics.methods.query).toMatchObject({ httpMethod: "POST", path: SEARCH_ANALYTICS_PATH_TEMPLATE });
    expect(discovery.resources.urlInspection.resources.index.methods.inspect).toMatchObject({ httpMethod: "POST", path: URL_INSPECTION_PATH });
    for (const scopes of [
      discovery.resources.sites.methods.list.scopes,
      discovery.resources.searchanalytics.methods.query.scopes,
      discovery.resources.urlInspection.resources.index.methods.inspect.scopes
    ]) {
      expect(scopes).toContain(GOOGLE_SCOPES[2]);
    }
    expect(sitesListUrl()).toBe(new URL(SITES_LIST_PATH, discovery.baseUrl).href);
    expect(urlInspectionUrl()).toBe(new URL(URL_INSPECTION_PATH, discovery.baseUrl).href);
    expect(searchAnalyticsUrl("https://example.com/")).toBe(
      new URL(SEARCH_ANALYTICS_PATH_TEMPLATE.replace("{siteUrl}", encodeURIComponent("https://example.com/")), discovery.baseUrl).href
    );
  });
});
