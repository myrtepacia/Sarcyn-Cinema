"use strict";

const crypto = require("node:crypto");

const { config } = require("../config");

const API_ROOT = "https://api.paymongo.com";

/**
 * Raised when PayMongo answers with an error. Carries the HTTP status and the
 * first error detail so routes can log something useful instead of "failed".
 */
class PayMongoError extends Error {
  constructor(message, { status, detail, code } = {}) {
    super(message);
    this.name = "PayMongoError";
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

function requireSecretKey() {
  if (config.paymongo.secretKey === null) {
    throw new PayMongoError(
      "PAYMONGO_SECRET_KEY is not set, so no payment can be started. Add a test key to .env."
    );
  }

  return config.paymongo.secretKey;
}

/** PayMongo authenticates with HTTP Basic, the key as the username and no password. */
function authorizationHeader(key) {
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

async function request(method, endpoint, { body, idempotencyKey } = {}) {
  const headers = {
    Authorization: authorizationHeader(requireSecretKey()),
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Makes a retry of the same logical action safe: PayMongo returns the
  // original result instead of creating a second checkout session.
  if (idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  let response;

  try {
    response = await fetch(API_ROOT + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new PayMongoError(`Could not reach PayMongo: ${cause.message}`);
  }

  const text = await response.text();
  let payload = null;

  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const first = payload?.errors?.[0];

    throw new PayMongoError(first?.detail ?? `PayMongo returned HTTP ${response.status}`, {
      status: response.status,
      detail: first?.detail,
      code: first?.code,
    });
  }

  return payload;
}

/**
 * Creates the hosted checkout page the customer is sent to.
 *
 * `lineItems` amounts are per-unit and in centavos, the same unit the rest of
 * the app stores money in, so nothing is converted on the way out.
 */
async function createCheckoutSession({ lineItems, reference, description, customerEmail }) {
  const payload = {
    data: {
      attributes: {
        line_items: lineItems.map((item) => ({
          name: item.name,
          amount: item.amountCentavos,
          currency: "PHP",
          quantity: item.quantity,
        })),
        payment_method_types: config.paymongo.paymentMethods,
        reference_number: reference,
        description,
        success_url: `${config.baseUrl}/booking/${reference}/confirming`,
        cancel_url: `${config.baseUrl}/booking/${reference}/cancelled`,
        send_email_receipt: false,
      },
    },
  };

  if (customerEmail) {
    payload.data.attributes.billing = { email: customerEmail };
  }

  // Keyed by our booking reference, so a double-clicked Pay button reuses the
  // first session rather than opening a second one for the same booking.
  const body = await request("POST", "/v2/checkout_sessions", {
    body: payload,
    idempotencyKey: `checkout-${reference}`,
  });

  return {
    id: body.data.id,
    checkoutUrl: body.data.attributes.checkout_url,
  };
}

/**
 * Reads back a checkout session, to find out whether it was actually paid.
 *
 * Note the version: sessions are CREATED on /v2 (which is what supports
 * pass_on_fees and the newer line-item fields), but reading one back is only
 * served on /v1 — /v2/checkout_sessions/{id} answers "The requested route
 * does not exist". A session created on v2 reads back fine on v1.
 *
 * This mattered a great deal: the retrieve is the fallback that confirms a
 * payment when no webhook arrives, so with the wrong version every poll from
 * the confirming page 404'd, the error was swallowed as "not paid yet", and
 * customers who had genuinely paid sat watching a spinner forever.
 */
async function retrieveCheckoutSession(id) {
  const body = await request("GET", `/v1/checkout_sessions/${encodeURIComponent(id)}`);
  return body.data;
}

/**
 * Confirms an incoming webhook really came from PayMongo.
 *
 * The header looks like `t=<unix seconds>,te=<test signature>,li=<live signature>`.
 * The signed value is `<timestamp>.<raw body>`, hashed with HMAC-SHA256 using
 * the webhook's own secret. It must be the raw body: re-serialising the parsed
 * JSON changes the bytes and the signature stops matching.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = config.paymongo.webhookSecret;

  if (secret === null) {
    return { valid: false, reason: "PAYMONGO_WEBHOOK_SECRET is not set" };
  }

  if (typeof signatureHeader !== "string" || signatureHeader === "") {
    return { valid: false, reason: "missing Paymongo-Signature header" };
  }

  const parts = {};

  for (const piece of signatureHeader.split(",")) {
    const at = piece.indexOf("=");

    if (at > 0) {
      parts[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
    }
  }

  if (!parts.t) {
    return { valid: false, reason: "signature header has no timestamp" };
  }

  // Test-mode webhooks sign into `te`, live-mode ones into `li`. Which one we
  // trust follows the key we are running with, so a test-mode signature can
  // never be replayed against a live deployment.
  const usingLiveKey = String(config.paymongo.secretKey).startsWith("sk_live_");
  const expectedField = usingLiveKey ? "li" : "te";
  const provided = parts[expectedField];

  if (!provided) {
    return { valid: false, reason: `signature header has no ${expectedField} value` };
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");

  const providedBuffer = Buffer.from(provided, "utf8");
  const digestBuffer = Buffer.from(digest, "utf8");

  // Compare in constant time. A plain === leaks, through how long it takes to
  // fail, how much of a guessed signature was right.
  if (
    providedBuffer.length !== digestBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, digestBuffer)
  ) {
    return { valid: false, reason: "signature does not match" };
  }

  return { valid: true };
}

module.exports = {
  PayMongoError,
  createCheckoutSession,
  retrieveCheckoutSession,
  verifyWebhookSignature,
};
