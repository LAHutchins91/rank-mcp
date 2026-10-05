import crypto from "node:crypto";
import type { AppConfig } from "./config.js";
import { RankError } from "./errors.js";
import { remainingTrialDays, type UserRecord } from "./users.js";

type Json = Record<string, unknown>;

export function verifyStripeEvent(rawBody: Buffer, signatureHeader: string, secret: string, now = Date.now()) {
  if (!secret) throw new RankError("Stripe webhooks are not configured.", "billing_not_configured", 503);
  const fields = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) throw new RankError("Malformed Stripe signature.", "invalid_signature");
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) throw new RankError("Expired Stripe signature.", "invalid_signature");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  const valid = signatures.some((signature) => signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)));
  if (!valid) throw new RankError("Invalid Stripe signature.", "invalid_signature");
  return JSON.parse(rawBody.toString("utf8")) as { type?: string; data?: { object?: Json } };
}

function stringField(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function periodEndIso(object: Json) {
  if (typeof object.current_period_end === "number") return new Date(object.current_period_end * 1000).toISOString();
  const items = object.items as { data?: Array<{ current_period_end?: number }> } | undefined;
  const end = items?.data?.[0]?.current_period_end;
  if (typeof end === "number") return new Date(end * 1000).toISOString();
  return null;
}

export function stripeEventUserId(event: { type?: string; data?: { object?: Json } }) {
  const object = event.data?.object;
  if (!object || !event.type) return null;
  if (event.type === "checkout.session.completed") {
    return stringField(object.client_reference_id) ?? stringField((object.metadata as Json | undefined)?.rank_user_id);
  }
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    return stringField(((object.metadata ?? {}) as Json).rank_user_id);
  }
  return null;
}

export function applyStripeEvent(user: UserRecord, event: { type?: string; data?: { object?: Json } }, now: Date): UserRecord | null {
  const object = event.data?.object;
  if (!object || !event.type) return null;
  const next: UserRecord = { ...user, updatedAt: now.toISOString() };
  if (event.type === "checkout.session.completed") {
    const userId = stringField(object.client_reference_id) ?? stringField((object.metadata as Json | undefined)?.rank_user_id);
    if (userId !== user.id) return null;
    const customer = stringField(object.customer);
    const subscription = stringField(object.subscription);
    if (customer) next.stripeCustomerId = customer;
    if (subscription) next.stripeSubscriptionId = subscription;
    if (object.status === "complete" && (object.payment_status === "paid" || object.payment_status === "no_payment_required")) {
      next.subscriptionStatus = "active";
    }
    return next;
  }
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const metadata = (object.metadata ?? {}) as Json;
    const userId = stringField(metadata.rank_user_id);
    if (userId !== user.id) return null;
    const customer = stringField(object.customer);
    if (customer) next.stripeCustomerId = customer;
    if (typeof object.id === "string") next.stripeSubscriptionId = object.id;
    if (typeof object.status === "string") next.subscriptionStatus = object.status;
    const periodEnd = periodEndIso(object);
    if (periodEnd) next.currentPeriodEnd = periodEnd;
    next.cancelAtPeriodEnd = Boolean(object.cancel_at_period_end);
    return next;
  }
  return null;
}

export function buildCheckoutParams(config: AppConfig, user: UserRecord, plan: "monthly" | "yearly", now: Date) {
  const price = plan === "yearly" ? config.stripePriceYearly : config.stripePriceMonthly;
  if (!config.stripeSecretKey || !price) throw new RankError("Billing is not configured on this server.", "billing_not_configured", 503);
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", price);
  params.set("line_items[0][quantity]", "1");
  params.set("client_reference_id", user.id);
  params.set("metadata[rank_user_id]", user.id);
  params.set("subscription_data[metadata][rank_user_id]", user.id);
  params.set("success_url", `${config.appBaseUrl}/account?checkout=success`);
  params.set("cancel_url", `${config.appBaseUrl}/account?checkout=cancelled`);
  const trialDays = remainingTrialDays(user, now);
  if (trialDays) params.set("subscription_data[trial_period_days]", String(trialDays));
  if (user.stripeCustomerId) params.set("customer", user.stripeCustomerId);
  else if (user.email) params.set("customer_email", user.email);
  return params;
}

export async function stripePost<T>(config: AppConfig, path: string, params: URLSearchParams, fetchImpl: typeof fetch): Promise<T> {
  if (!config.stripeSecretKey) throw new RankError("Billing is not configured on this server.", "billing_not_configured", 503);
  const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const text = await response.text();
  if (!response.ok) throw new RankError("Stripe could not complete that request.", "stripe_error", 502);
  return JSON.parse(text) as T;
}
