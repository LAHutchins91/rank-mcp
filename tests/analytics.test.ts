import { describe, expect, it } from "vitest";
import { compareResponses, filterQuickWins, findDroppedPages, shapeAnalytics } from "../src/analytics.js";
import { defaultRecentRange, previousWindow } from "../src/dates.js";

const queryBody = {
  responseAggregationType: "AUTO",
  rows: [
    { keys: ["best coffee grinder"], clicks: 12, impressions: 980, ctr: 0.012244897959183673, position: 8.4 },
    { keys: ["buy espresso machine"], clicks: 80, impressions: 400, ctr: 0.2, position: 2.2 },
    { keys: ["missing metrics"] }
  ]
};

describe("analytics shaping", () => {
  it("copies Search Console metrics and does not invent values for sparse rows", () => {
    const shaped = shapeAnalytics(queryBody, "query");
    expect(shaped.responseAggregationType).toBe("AUTO");
    const rows = shaped.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      keys: ["best coffee grinder"],
      query: "best coffee grinder",
      clicks: 12,
      impressions: 980,
      ctr: 0.012244897959183673,
      position: 8.4
    });
    expect(rows[2]).toEqual({ keys: ["missing metrics"], query: "missing metrics" });
    expect(rows[2]).not.toHaveProperty("clicks");
    expect(rows[2]).not.toHaveProperty("ctr");
  });

  it("keeps an omitted rows field distinct from an empty list", () => {
    expect(shapeAnalytics({}, "date").apiReturnedRows).toBe(false);
    expect(shapeAnalytics({ rows: [] }, "date").apiReturnedRows).toBe(true);
  });

  it("does not fill dates the API left out", () => {
    const shaped = shapeAnalytics({
      rows: [
        { keys: ["2026-03-01"], clicks: 3, impressions: 40, ctr: 0.075, position: 6.5 },
        { keys: ["2026-03-03"], clicks: 1, impressions: 22, ctr: 0.045454545454545456, position: 9 }
      ]
    }, "date");
    const dates = (shaped.rows as Array<{ date: string }>).map((row) => row.date);
    expect(dates).toEqual(["2026-03-01", "2026-03-03"]);
  });

  it("subtracts only metrics present on both period totals", () => {
    const compared = compareResponses(
      { rows: [{ clicks: 40, impressions: 1000, ctr: 0.04, position: 7.25 }] },
      { rows: [{ clicks: 55, impressions: 900, position: 5 }] }
    );
    expect(compared.current).toMatchObject({ clicks: 40, ctr: 0.04, position: 7.25 });
    expect(compared.previous).not.toHaveProperty("ctr");
    expect(compared.differenceFromReturnedMetrics).toEqual({
      clicks: 40 - 55,
      impressions: 1000 - 900,
      position: 7.25 - 5
    });
    expect(compared.differenceFromReturnedMetrics).not.toHaveProperty("ctr");
  });

  it("returns null totals when Search Console omits rows", () => {
    const compared = compareResponses({}, { rows: [] });
    expect(compared.current).toBeNull();
    expect(compared.previous).toBeNull();
    expect(compared.differenceFromReturnedMetrics).toEqual({});
  });

  it("selects quick wins from returned impressions and ctr only", () => {
    const wins = filterQuickWins(queryBody.rows, 100, 0.02);
    expect(wins.map((row) => row.query)).toEqual(["best coffee grinder"]);
    expect(wins[0].ctr).toBe(0.012244897959183673);
    expect(wins[0]).not.toHaveProperty("potentialClicks");
  });

  it("reports dropped pages without zero-filling an absent URL", () => {
    const current = [
      { keys: ["https://example.com/grinders"], clicks: 4, impressions: 220, ctr: 0.01818181818181818, position: 14 },
      { keys: ["https://example.com/kept"], clicks: 10, impressions: 100, ctr: 0.1, position: 3 }
    ];
    const previous = [
      { keys: ["https://example.com/grinders"], clicks: 9, impressions: 300, ctr: 0.03, position: 6 },
      { keys: ["https://example.com/gone"], clicks: 7, impressions: 150, ctr: 0.04666666666666667, position: 4 },
      { keys: ["https://example.com/kept"], clicks: 10, impressions: 100, ctr: 0.1, position: 3 }
    ];
    const dropped = findDroppedPages(current, previous);
    expect(dropped.map((page) => page.page)).toEqual(["https://example.com/grinders", "https://example.com/gone"]);
    expect(dropped[0].reasons).toEqual(["position_worse", "clicks_down"]);
    expect(dropped[0].current).toMatchObject({ clicks: 4, position: 14 });
    expect(dropped[1].current).toBeNull();
    expect(dropped[1].previous).toMatchObject({ clicks: 7, impressions: 150 });
    expect(JSON.stringify(dropped[1])).not.toContain("\"clicks\":0");
  });

  it("builds the previous window from the inclusive day count", () => {
    expect(previousWindow("2026-03-01", "2026-03-28")).toMatchObject({
      compareStartDate: "2026-02-01",
      compareEndDate: "2026-02-28"
    });
    expect(defaultRecentRange(new Date("2026-04-04T15:00:00.000Z"))).toEqual({
      startDate: "2026-03-05",
      endDate: "2026-04-01",
      dateRangeDefaulted: true
    });
  });
});
