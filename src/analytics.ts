/**
 * Shapes Search Console JSON for tools.
 * Metric numbers are copied from the API response. Missing metrics stay missing.
 * Nothing here fills gaps with zero or estimates traffic.
 */

const METRIC_KEYS = ["clicks", "impressions", "ctr", "position"] as const;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function shapeRow(row: unknown, dimensionName: "query" | "page" | "date" | null) {
  const record = asRecord(row) ?? {};
  const shaped: Record<string, unknown> = {};
  if (Array.isArray(record.keys)) {
    shaped.keys = record.keys;
    if (dimensionName && typeof record.keys[0] === "string") shaped[dimensionName] = record.keys[0];
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "keys") continue;
    if (typeof value === "number" && Number.isFinite(value)) shaped[key] = value;
    else if (typeof value === "string" || typeof value === "boolean" || value === null) shaped[key] = value;
  }
  return shaped;
}

export function shapeAnalytics(body: unknown, dimensionName: "query" | "page" | "date" | null) {
  const record = asRecord(body);
  const apiRows = record && Array.isArray(record.rows) ? record.rows : null;
  const rows = (apiRows ?? []).map((row) => shapeRow(row, dimensionName));
  const shaped: Record<string, unknown> = {
    rows,
    rowCount: rows.length,
    apiReturnedRows: apiRows !== null
  };
  if (record && typeof record.responseAggregationType === "string") {
    shaped.responseAggregationType = record.responseAggregationType;
  }
  if (record && asRecord(record.metadata)) shaped.metadata = record.metadata;
  return shaped;
}

export function metricSnapshot(row: Record<string, unknown> | null) {
  if (!row) return null;
  const snapshot: Record<string, unknown> = {};
  if (Array.isArray(row.keys)) snapshot.keys = row.keys;
  for (const key of METRIC_KEYS) {
    if (typeof row[key] === "number") snapshot[key] = row[key];
  }
  return snapshot;
}

export function firstRowMetrics(body: unknown) {
  const record = asRecord(body);
  if (!record || !Array.isArray(record.rows) || !record.rows[0]) return null;
  return metricSnapshot(shapeRow(record.rows[0], null));
}

export function compareResponses(currentBody: unknown, previousBody: unknown) {
  const current = firstRowMetrics(currentBody);
  const previous = firstRowMetrics(previousBody);
  const differenceFromReturnedMetrics: Record<string, number> = {};
  if (current && previous) {
    for (const key of METRIC_KEYS) {
      if (typeof current[key] === "number" && typeof previous[key] === "number") {
        differenceFromReturnedMetrics[key] = (current[key] as number) - (previous[key] as number);
      }
    }
  }
  return { current, previous, differenceFromReturnedMetrics };
}

export function filterQuickWins(rows: unknown[], minImpressions: number, maxCtr: number) {
  return rows
    .map((row) => shapeRow(row, "query"))
    .filter((row) => typeof row.impressions === "number" && typeof row.ctr === "number" && row.impressions >= minImpressions && row.ctr <= maxCtr)
    .sort((a, b) => {
      const impressions = (b.impressions as number) - (a.impressions as number);
      if (impressions !== 0) return impressions;
      return String(a.query ?? "").localeCompare(String(b.query ?? ""));
    });
}

export function findDroppedPages(currentRows: unknown[], previousRows: unknown[]) {
  const current = new Map<string, Record<string, unknown>>();
  for (const row of currentRows) {
    const shaped = shapeRow(row, "page");
    if (typeof shaped.page === "string") current.set(shaped.page, shaped);
  }
  const dropped: Array<{
    page: string;
    reasons: string[];
    current: Record<string, unknown> | null;
    previous: Record<string, unknown>;
  }> = [];
  for (const row of previousRows) {
    const previous = shapeRow(row, "page");
    if (typeof previous.page !== "string") continue;
    const previousMetrics = metricSnapshot(previous) ?? {};
    const match = current.get(previous.page);
    if (!match) {
      dropped.push({
        page: previous.page,
        reasons: ["absent_from_current_response"],
        current: null,
        previous: previousMetrics
      });
      continue;
    }
    const reasons: string[] = [];
    if (typeof match.position === "number" && typeof previous.position === "number" && match.position > previous.position) {
      reasons.push("position_worse");
    }
    if (typeof match.clicks === "number" && typeof previous.clicks === "number" && match.clicks < previous.clicks) {
      reasons.push("clicks_down");
    }
    if (!reasons.length) continue;
    dropped.push({
      page: previous.page,
      reasons,
      current: metricSnapshot(match),
      previous: previousMetrics
    });
  }
  dropped.sort((a, b) => {
    const left = typeof a.previous.impressions === "number" ? a.previous.impressions : -1;
    const right = typeof b.previous.impressions === "number" ? b.previous.impressions : -1;
    return right - left || a.page.localeCompare(b.page);
  });
  return dropped;
}
