import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyStripeEvent, buildCheckoutParams, verifyStripeEvent } from "../src/billing.js";
import { loadConfig } from "../src/config.js";
import { newTrial, type UserRecord } from "../src/users.js";

const now = new Date("2026-04-01T00:00:00.000Z");

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
          metadata: { rank_user_id: "user-1" }
        }
      }
    });
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const event = verifyStripeEvent(Buffer.from(payload), `t=${timestamp},v1=${signature}`, secret, now.getTime());
    const updated = applyStripeEvent(user(), event, now);
    expect(updated?.subscriptionStatus).toBe("active");
    expect(updated?.stripeCustomerId).toBe("cus_123");
    expect(updated?.stripeSubscriptionId).toBe("sub_123");
    expect(() => verifyStripeEvent(Buffer.from(payload), `t=${timestamp},v1=${"0".repeat(signature.length)}`, secret, now.getTime())).toThrow(/Invalid Stripe signature/);
  });
});
