import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyStripeEvent, buildCheckoutParams, stripeEventUserId, verifyStripeEvent } from "../src/billing.js";
import { loadConfig } from "../src/config.js";
import { newTrial, type UserRecord } from "../src/users.js";

const now = new Date("2026-04-01T00:00:00.000Z");
const BASE = "https://rank.example.test";
const scope = { appBaseUrl: BASE, stripePriceMonthly: "price_month", stripePriceYearly: "price_year" };
const rankItems = { data: [{ price: { id: "price_month" } }] };

function user(): UserRecord {
  const trial = newTrial(now);
  return {
    id: "user-1",
    email: "owner@example.com",
    googleSubject: "user-1",
    encryptedRefreshToken: "ciphertext",
    trialStartedAt: trial.trialStartedAt,
    trialEndsAt: trial.trialEndsAt,
    subscriptionStatus: trial.subscriptionStatus,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

describe("billing", () => {
  it("sends a Stripe price id and the remaining trial days, never an amount", () => {
    const config = loadConfig({
      APP_BASE_URL: "http://127.0.0.1:44721",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PRICE_MONTHLY: "price_month",
      STRIPE_PRICE_YEARLY: "price_year"
    });
    const params = buildCheckoutParams(config, user(), "monthly", now);
    const body = params.toString();
    expect(params.get("line_items[0][price]")).toBe("price_month");
    expect(params.get("subscription_data[trial_period_days]")).toBe("14");
    expect(params.get("client_reference_id")).toBe("user-1");
    expect(params.get("metadata[app]")).toBe("rank");
    expect(params.get("metadata[rank_user_id]")).toBe("user-1");
    expect(params.get("subscription_data[metadata][app]")).toBe("rank");
    expect(params.get("subscription_data[metadata][rank_user_id]")).toBe("user-1");
    expect(params.get("success_url")?.startsWith("http://127.0.0.1:44721/account")).toBe(true);
    expect(body).not.toMatch(/\$\d/);
    expect(buildCheckoutParams(config, { ...user(), stripeSubscriptionId: "sub_123" }, "yearly", now).has("subscription_data[trial_period_days]")).toBe(false);
  });

  it("verifies a Stripe signature and activates the matching user", () => {
    const secret = "whsec_test";
    const payload = JSON.stringify({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          status: "active",
          current_period_end: 1_800_000_000,
          cancel_at_period_end: false,
          items: rankItems,
          metadata: { rank_user_id: "user-1" }
        }
      }
    });
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const event = verifyStripeEvent(Buffer.from(payload), `t=${timestamp},v1=${signature}`, secret, now.getTime());
    const updated = applyStripeEvent(user(), event, now, scope);
    expect(updated?.subscriptionStatus).toBe("active");
    expect(updated?.stripeCustomerId).toBe("cus_123");
    expect(updated?.stripeSubscriptionId).toBe("sub_123");
    expect(() => verifyStripeEvent(Buffer.from(payload), `t=${timestamp},v1=${"0".repeat(signature.length)}`, secret, now.getTime())).toThrow(/Invalid Stripe signature/);
  });

  it("ignores a Papers-style checkout that carries the same user id", () => {
    const papers = {
      type: "checkout.session.completed",
      data: { object: {
        client_reference_id: "user-1",
        customer: "cus_papers",
        subscription: "sub_papers",
        status: "complete",
        payment_status: "paid",
        success_url: "https://papers-mcp.vercel.app/account?checkout=success",
        metadata: { papers_user_id: "user-1" }
      } }
    };
    expect(stripeEventUserId(papers, scope)).toBeNull();
    expect(applyStripeEvent(user(), papers, now, scope)).toBeNull();
    // Even if another app copied rank_user_id or app=rank, its success_url is not ours.
    const spoofed = { ...papers, data: { object: { ...papers.data.object, metadata: { app: "rank", rank_user_id: "user-1" } } } };
    expect(applyStripeEvent(user(), spoofed, now, scope)).toBeNull();
  });

  it("requires app=rank, our success_url and rank_user_id on checkout; client_reference_id is not enough", () => {
    const base = {
      client_reference_id: "user-1", customer: "cus_1", subscription: "sub_1", status: "complete", payment_status: "paid",
      success_url: `${BASE}/account?checkout=success`
    };
    const event = (object: Record<string, unknown>) => ({ type: "checkout.session.completed", data: { object } });
    expect(applyStripeEvent(user(), event({ ...base, metadata: { rank_user_id: "user-1" } }), now, scope)).toBeNull();
    expect(applyStripeEvent(user(), event({ ...base, metadata: { app: "rank" } }), now, scope)).toBeNull();
    expect(applyStripeEvent(user(), event({ ...base, success_url: `${BASE}/accountant`, metadata: { app: "rank", rank_user_id: "user-1" } }), now, scope)).toBeNull();
    expect(applyStripeEvent(user(), event({ ...base, success_url: `https://evil.test/?u=${BASE}/account`, metadata: { app: "rank", rank_user_id: "user-1" } }), now, scope)).toBeNull();
    const ok = applyStripeEvent(user(), event({ ...base, metadata: { app: "rank", rank_user_id: "user-1" } }), now, scope);
    expect(ok?.subscriptionStatus).toBe("active");
    expect(ok?.stripeCustomerId).toBe("cus_1");
    expect(ok?.stripeSubscriptionId).toBe("sub_1");
  });

  it("ignores subscription events without Rank prices, including another app's delete", () => {
    const paid = { ...user(), subscriptionStatus: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" };
    const sub = (object: Record<string, unknown>) => ({ type: "customer.subscription.deleted", data: { object: { id: "sub_x", customer: "cus_1", status: "canceled", ...object } } });
    expect(applyStripeEvent(paid, sub({ items: { data: [{ price: { id: "price_papers" } }] }, metadata: { app: "papers", rank_user_id: "user-1" } }), now, scope)).toBeNull();
    expect(applyStripeEvent(paid, sub({ metadata: { app: "rank", rank_user_id: "user-1" } }), now, scope)).toBeNull();
    expect(applyStripeEvent(paid, sub({ items: { data: [{ price: "price_month" }, { price: "price_other" }] }, metadata: { app: "rank", rank_user_id: "user-1" } }), now, scope)).toBeNull();
    expect(applyStripeEvent(paid, sub({ items: rankItems, metadata: { app: "rank", rank_user_id: "user-2" } }), now, scope)).toBeNull();
    expect(applyStripeEvent(paid, sub({ items: rankItems, metadata: { user_id: "user-1" } }), now, scope)).toBeNull();
  });

  it("keeps pre-marker subscriptions working via rank_user_id, Rank price and the stored customer", () => {
    const paid = { ...user(), subscriptionStatus: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" };
    const legacy = (customer: string, status: string) => ({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer, status, items: { data: [{ price: "price_year" }] }, metadata: { rank_user_id: "user-1" } } }
    });
    expect(applyStripeEvent(paid, legacy("cus_1", "past_due"), now, scope)?.subscriptionStatus).toBe("past_due");
    expect(applyStripeEvent(paid, legacy("cus_other", "canceled"), now, scope)).toBeNull();
    // No stored customer yet (checkout event not seen): the Rank price plus rank_user_id still applies.
    expect(applyStripeEvent(user(), legacy("cus_9", "trialing"), now, scope)?.stripeCustomerId).toBe("cus_9");
    // Marked subscriptions may move to a new customer.
    const marked = { type: "customer.subscription.created", data: { object: { id: "sub_2", customer: "cus_2", status: "active", items: rankItems, metadata: { app: "rank", rank_user_id: "user-1" } } } };
    expect(applyStripeEvent(paid, marked, now, scope)?.stripeCustomerId).toBe("cus_2");
  });

  it("ignores events when Rank prices are not configured", () => {
    const sub = { type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", items: rankItems, metadata: { app: "rank", rank_user_id: "user-1" } } } };
    expect(applyStripeEvent(user(), sub, now, { appBaseUrl: BASE, stripePriceMonthly: "", stripePriceYearly: "" })).toBeNull();
  });
});
