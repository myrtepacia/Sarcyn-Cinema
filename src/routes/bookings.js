"use strict";

const express = require("express");

const { query } = require("../db");
const { requireAuth, can } = require("../middleware/guards");
const bookings = require("../services/bookings");
const paymongo = require("../services/paymongo");
const { toQrPayload } = require("../services/reference");

const router = express.Router();

/** Owner, or a staff member who needs it for the counter or the door. */
function mayView(user, booking) {
  if (user === null) {
    return false;
  }

  return Number(booking.user_id) === user.id || can(user.role, "dashboard") || can(user.role, "scanner");
}

router.post("/draft", requireAuth, async (req, res, next) => {
  try {
    const draft = await bookings.createDraft({
      userId: req.user.id,
      showtimeId: Number.parseInt(req.body?.showtimeId, 10),
      seatCodes: req.body?.seats,
      snacks: req.body?.snacks,
    });

    const booking = await bookings.loadBooking(draft.reference);

    res.status(201).json({ booking: bookings.publicBooking(booking) });
  } catch (error) {
    if (error instanceof bookings.BookingError) {
      return res
        .status(error.status)
        .json({ error: error.message, unavailableSeats: error.unavailableSeats });
    }

    next(error);
  }
});

/**
 * Opens a PayMongo hosted checkout for a booking and hands back the address
 * to send the customer to.
 */
router.post("/:reference/checkout", requireAuth, async (req, res, next) => {
  try {
    const booking = await bookings.loadBooking(req.params.reference);

    if (booking === null || Number(booking.user_id) !== req.user.id) {
      return res.status(404).json({ error: "Booking not found." });
    }

    if (booking.status === "paid") {
      return res.status(409).json({ error: "That booking is already paid for." });
    }

    if (booking.status !== "pending_payment") {
      return res.status(409).json({ error: "That booking is no longer waiting for payment." });
    }

    if (booking.hold_expires_at !== null && Number(booking.hold_expires_at) < Date.now()) {
      return res.status(409).json({ error: "Your seats were released. Please choose them again." });
    }

    const lineItems = [
      {
        name: `${booking.movie_title} — ticket`,
        amountCentavos: booking.ticket_price_centavos,
        quantity: booking.seats.length,
      },
      ...booking.snacks.map((snack) => ({
        name: snack.name,
        amountCentavos: snack.unit_price_centavos,
        quantity: snack.quantity,
      })),
    ];

    const session = await paymongo.createCheckoutSession({
      lineItems,
      reference: booking.reference,
      description: `${booking.movie_title} · ${booking.seats.join(", ")}`,
      customerEmail: booking.customer_email,
    });

    await query("UPDATE bookings SET paymongo_checkout_session_id = $1 WHERE id = $2", [
      session.id,
      booking.id,
    ]);

    res.json({ checkoutUrl: session.checkoutUrl });
  } catch (error) {
    if (error instanceof paymongo.PayMongoError) {
      console.error(`[checkout ${req.params.reference}]`, error.message);

      return res.status(502).json({
        error: "The payment page could not be opened. Please try again in a moment.",
      });
    }

    next(error);
  }
});

/**
 * One booking. When it is still waiting on payment, this also asks PayMongo
 * whether it has in fact been paid — which is how the confirming page finishes
 * on a machine no webhook can reach.
 */
router.get("/:reference", requireAuth, async (req, res, next) => {
  try {
    let booking = await bookings.loadBooking(req.params.reference);

    if (booking === null || !mayView(req.user, booking)) {
      return res.status(404).json({ error: "Booking not found." });
    }

    if (booking.status === "pending_payment" && booking.paymongo_checkout_session_id !== null) {
      const result = await bookings.reconcileWithPayMongo(booking);

      if (result.reconciled) {
        booking = await bookings.loadBooking(req.params.reference);
      }
    }

    res.json({ booking: bookings.publicBooking(booking) });
  } catch (error) {
    next(error);
  }
});

/** The QR image for a paid ticket, drawn on demand rather than stored. */
router.get("/:reference/qr.png", requireAuth, async (req, res, next) => {
  try {
    const booking = await bookings.loadBooking(req.params.reference);

    if (booking === null || !mayView(req.user, booking)) {
      return res.status(404).json({ error: "Booking not found." });
    }

    if (booking.status !== "paid") {
      return res.status(409).json({ error: "This booking has not been paid for yet." });
    }

    // Required here rather than at the top of the file: qrcode pulls in 148KB
    // across 58 files, and this one endpoint — a ticket's QR image — is the
    // only thing in the app that draws a code. At module scope it was parsed
    // on every cold start whether or not anyone opened a ticket.
    const QRCode = require("qrcode");

    const png = await QRCode.toBuffer(toQrPayload(booking.reference), {
      type: "png",
      width: 420,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#101828ff", light: "#ffffffff" },
    });

    res.type("png").set("Cache-Control", "private, max-age=3600").send(png);
  } catch (error) {
    next(error);
  }
});

router.post("/:reference/cancel", requireAuth, async (req, res, next) => {
  try {
    await bookings.cancelDraft(req.params.reference, req.user.id);
    res.status(204).end();
  } catch (error) {
    if (error instanceof bookings.BookingError) {
      return res.status(error.status).json({ error: error.message });
    }

    next(error);
  }
});

module.exports = router;
