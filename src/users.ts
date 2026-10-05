import type { KvStore } from "./storage.js";
import { TRIAL_MS } from "./config.js";

export type UserRecord = {
  id: string;
  email: string;
  googleSubject: string;
  encryptedRefreshToken: string | null;
  trialStartedAt: string;
  trialEndsAt: string;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
};

export function isUserRecord(value: Record<string, unknown> | null): value is UserRecord {
  return Boolean(value && typeof value.id === "string" && typeof value.email === "string");
}

export async function getUser(store: KvStore, id: string) {
  const row = await store.get("users", id);
  return isUserRecord(row) ? row : null;
}

export function isEntitled(user: UserRecord, now: Date) {
  const time = now.getTime();
  if (user.stripeSubscriptionId) {
    if (user.subscriptionStatus === "active") return true;
    if (user.subscriptionStatus === "trialing") {
      const end = user.currentPeriodEnd ?? user.trialEndsAt;
      return new Date(end).getTime() > time;
    }
    return false;
  }
  return user.subscriptionStatus === "trialing" && new Date(user.trialEndsAt).getTime() > time;
}

export function newTrial(now: Date) {
  return {
    trialStartedAt: now.toISOString(),
    trialEndsAt: new Date(now.getTime() + TRIAL_MS).toISOString(),
    subscriptionStatus: "trialing"
  };
}

/** Whole days of local trial still left. Stripe rejects 0, so callers omit the field when this is null. */
export function remainingTrialDays(user: UserRecord, now: Date) {
  if (user.stripeSubscriptionId) return null;
  const days = Math.floor((new Date(user.trialEndsAt).getTime() - now.getTime()) / 86_400_000);
  return days >= 1 ? days : null;
}
