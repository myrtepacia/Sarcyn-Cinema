"use strict";

const express = require("express");

const { query, isUniqueViolation } = require("../db");
const paymongo = require("../services/paymongo");
const bookings = require("../services/bookings");

const router = express.Router();

/**
 * Records that we have seen this event, and says whether it is new.
 *
 * The UNIQUE constraint on paymongo_event_id is what actually makes this
 * safe — two deliveries racing each other cannot both be treated as new,
 * because the second insert fails with a unique-violation.
 */
async function claimEvent(eventId, type, rawBody) {
  try {
    await query(
      "INSERT INTO webhook_events (paymongo_event_id, type, received_at, payload) VALUES ($1, $2, $3, $4)",
      [eventId, type, Date.now(), rawBody.slice(0, 20000)]
    );

    return true;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return false;
    }

    throw error;
  }
}

async function markProcessed(eventId) {
  await query("UPDATE webhook_events SET processed_at = $1 WHERE paymongo_event_id = $2", [
    Date.now(),
    eventId,
  ]);
}

/**
 * PayMongo posts here when a payment succeeds or fails.
 *
 * This is a public address that anyone can send anything to, so nothing in
 * the body is believed until the signature over the raw bytes checks out.
 * req.body is a Buffer, not parsed JSON, precisely so those bytes survive
 * unchanged — see the express.raw mount in app.js.
 */
router.post("/paymongo", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

  const verdict = paymongo.verifyWebhookSignature(rawBody, req.get("Paymongo-Signature"));

  if (!verdict.valid) {
    console.warn(`[webhook] rejected: ${verdict.reason}`);
    return res.status(401).json({ error: "Invalid signature." });
  }

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Body is not JSON." });
  }

  const eventId = event?.data?.id;
  const eventType = event?.data?.attributes?.type;

  if (typeof eventId !== "string" || typeof eventType !== "string") {
    return res.status(400).json({ error: "Not a PayMongo event." });
  }

  let isNew;

  try {
    isNew = await claimEvent(eventId, eventType, rawBody);
  } catch (error) {
    console.error("[webhook] could not record event:", error.message);
    return res.status(500).json({ error: "Could not record event." });
  }

  if (!isNew) {
    // A redelivery of something already handled. Say yes so PayMongo stops.
    return res.status(200).json({ received: true, duplicate: true });
  }

  // Answer PayMongo before doing anything that could be slow — everything
  // below is quick local work, but the order still matters: a handler that
  // works first and replies later is the one PayMongo retries.
  try {
    await handleEvent(eventType, event);
    await markProcessed(eventId);
  } catch (error) {
    console.error(`[webhook ${eventType}] handling failed:`, error.message);
  }

  // Unrecognised event types still get a 200, otherwise PayMongo retries
  // them twelve times for no reason.
  res.status(200).json({ received: true });
});

async function handleEvent(type, event) {
  const resource = event?.data?.attributes?.data;

  if (type === "checkout_session.payment.paid") {
    const reference = resource?.attributes?.reference_number;
    const payment = (resource?.attributes?.payments ?? []).find(
      (candidate) => candidate?.attributes?.status === "paid"
    );

    if (typeof reference !== "string") {
      console.warn("[webhook] paid session carried no reference_number");
      return;
    }

    const result = await bookings.confirmPaid(reference, { paymentId: payment?.id ?? null });

    console.log(
      result.changed
        ? `[webhook] booking ${reference} marked paid`
        : `[webhook] booking ${reference} not changed (${result.reason})`
    );

    return;
  }

  if (type === "payment.failed") {
    console.warn(`[webhook] payment failed for ${resource?.attributes?.description ?? "unknown booking"}`);
    return;
  }

  console.log(`[webhook] ignoring ${type}`);
}

module.exports = router;
