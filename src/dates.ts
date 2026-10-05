import { RankError } from "./errors.js";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string) {
  const match = DATE.exec(value);
  if (!match) throw new RankError("Dates must be YYYY-MM-DD.", "invalid_date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RankError("Dates must be real calendar dates in YYYY-MM-DD.", "invalid_date");
  }
  return date;
}

export function formatIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function assertRange(startDate: string, endDate: string) {
  if (parseIsoDate(startDate).getTime() > parseIsoDate(endDate).getTime()) {
    throw new RankError("startDate must be on or before endDate.", "invalid_date");
  }
}

/** 28-day window ending three UTC days ago. The response echoes the dates that were sent. */
export function defaultRecentRange(now: Date) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: formatIsoDate(start), endDate: formatIsoDate(end), dateRangeDefaulted: true as const };
}

export function previousWindow(startDate: string, endDate: string) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const compareEnd = new Date(start);
  compareEnd.setUTCDate(compareEnd.getUTCDate() - 1);
  const compareStart = new Date(compareEnd);
  compareStart.setUTCDate(compareStart.getUTCDate() - (days - 1));
  return {
    compareStartDate: formatIsoDate(compareStart),
    compareEndDate: formatIsoDate(compareEnd),
    comparisonRangeDefaulted: true as const
  };
}

export function resolveRange(now: Date, startDate?: string, endDate?: string) {
  if (!startDate && !endDate) return defaultRecentRange(now);
  if (!startDate || !endDate) throw new RankError("Pass both startDate and endDate, or neither to use the default window.", "invalid_date");
  assertRange(startDate, endDate);
  return { startDate, endDate, dateRangeDefaulted: false as const };
}
