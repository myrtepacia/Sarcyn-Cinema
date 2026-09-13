"use strict";

const { query, transaction } = require("../db");
const { config } = require("../config");
const { generateReference } = require("./reference");
const { releaseExpiredHolds } = require("./holds");
const paymongo = require("./paymongo");

const MAX_SEATS_PER_BOOKING = 10;

/** An expected, explainable failure — turned into a 4xx by the route. */
class BookingError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = "BookingError";
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Holds seats and opens a booking that is waiting to be paid for.
 *
 * The seat check and the seat write happen in one transaction using
 * SELECT ... FOR UPDATE, which locks exactly the seat rows being requested
 * until the transaction ends. A second request for one of the same seats
 * blocks at that SELECT until the first commits or rolls back, and then sees
 * the row as it now stands — so two people cannot both win the same seat.
 */
async function createDraft({ userId, showtimeId, seatCodes, snacks }) {
  if (!Array.isArray(seatCodes) || seatCodes.length === 0) {
    throw new BookingError("Choose at least one seat.");
  }

  if (seatCodes.length > MAX_SEATS_PER_BOOKING) {
    throw new BookingError(`You can book at most ${MAX_SEATS_PER_BOOKING} seats at a time.`);
  }

  if (new Set(seatCodes).size !== seatCodes.length) {
    throw new BookingError("The same seat was chosen twice.");
  }

  // Done before the transaction: this opens one of its own.
  await releaseExpiredHolds();

  return transaction(async (client) => {
    const showtimeResult = await client.query(
      `SELECT s.id, s.starts_at, s.movie_id, m.price_centavos, m.title, m.slug
         FROM showtimes s
         JOIN movies m ON m.id = s.movie_id
        WHERE s.id = $1 AND m.archived_at IS NULL`,
      [showtimeId]
    );
    const showtime = showtimeResult.rows[0];

    if (showtime === undefined) {
      throw new BookingError("That showing is no longer available.", 404);
    }

    if (Number(showtime.starts_at) <= Date.now()) {
      throw new BookingError("That showing has already started.");
    }

    // Release anything this person was already holding, so going back and
    // choosing different seats does not quietly hold both sets.
    const staleResult = await client.query(
      "SELECT id FROM bookings WHERE user_id = $1 AND status = 'pending_payment'",
      [userId]
    );

    for (const stale of staleResult.rows) {
      await client.query(
        `UPDATE seats SET status = 'available', held_until = NULL, booking_id = NULL
          WHERE booking_id = $1 AND status = 'held'`,
        [stale.id]
      );
      await client.query(
        "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = $1",
        [stale.id]
      );
    }

    // Parse and validate seat codes before taking any locks.
    const parsedSeats = seatCodes.map((code) => {
      const match = /^([A-Z])(\d{1,2})$/.exec(String(code).trim().toUpperCase());

      if (match === null) {
        throw new BookingError(`"${code}" is not a seat number.`);
      }

      return { code, row: match[1], number: Number.parseInt(match[2], 10) };
    });

    // Lock every requested seat row in one statement, in a fixed order
    // (by id) — locking several rows in id order every time is what keeps
    // two overlapping bookings from deadlocking against each other instead
    // of one simply waiting for the other.
    const rowConditions = parsedSeats
      .map((_, i) => `(row_letter = $${i * 2 + 2} AND seat_number = $${i * 2 + 3})`)
      .join(" OR ");
    const rowParams = parsedSeats.flatMap((seat) => [seat.row, seat.number]);

    const lockedResult = await client.query(
      `SELECT id, row_letter, seat_number, status
         FROM seats
        WHERE showtime_id = $1 AND (${rowConditions})
        ORDER BY id
        FOR UPDATE`,
      [showtime.id, ...rowParams]
    );

    const seatByCode = new Map(
      lockedResult.rows.map((row) => [`${row.row_letter}${row.seat_number}`, row])
    );

    const unavailable = [];
    const seatIds = [];

    for (const seat of parsedSeats) {
      const row = seatByCode.get(seat.code.toUpperCase());

      if (row === undefined) {
        throw new BookingError(`Seat ${seat.code} is not in this cinema.`);
      }

      if (row.status !== "available") {
        unavailable.push(seat.code);
      } else {
        seatIds.push(row.id);
      }
    }

    if (unavailable.length > 0) {
      throw new BookingError(
        unavailable.length === 1
          ? `Seat ${unavailable[0]} was taken while you were choosing. Please pick another.`
          : `Seats ${unavailable.join(", ")} were taken while you were choosing. Please pick others.`,
        409,
        { unavailableSeats: unavailable }
      );
    }

    // Prices always come from the database, never from the browser, so a
    // tampered request cannot buy a ₱250 ticket for ₱1.
    let total = showtime.price_centavos * seatIds.length;

    const chosenSnacks = [];

    for (const entry of snacks ?? []) {
      const quantity = Number.parseInt(entry?.quantity ?? 1, 10);

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        throw new BookingError("Snack quantities must be between 1 and 20.");
      }

      const snackResult = await client.query(
        "SELECT id, name, price_centavos FROM snack_items WHERE id = $1 AND archived_at IS NULL",
        [entry?.itemId]
      );
      const snack = snackResult.rows[0];

      if (snack === undefined) {
        throw new BookingError("One of the snacks chosen is no longer on the menu.");
      }

      chosenSnacks.push({ ...snack, quantity });
      total += snack.price_centavos * quantity;
    }

    const now = Date.now();
    const reference = await generateReference(client);

    const bookingResult = await client.query(
      `INSERT INTO bookings
         (reference, user_id, movie_id, showtime_id, total_centavos, status,
          concession_status, hold_expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending_payment', $6, $7, $8)
       RETURNING id`,
      [
        reference,
        userId,
        showtime.movie_id,
        showtime.id,
        total,
        chosenSnacks.length > 0 ? "preparing" : "none",
        now + config.seatHoldMs,
        now,
      ]
    );
    const bookingId = bookingResult.rows[0].id;

    for (const seatId of seatIds) {
      await client.query(
        "UPDATE seats SET status = 'held', held_until = $1, booking_id = $2 WHERE id = $3",
        [now + config.seatHoldMs, bookingId, seatId]
      );
    }

    for (const snack of chosenSnacks) {
      await client.query(
        `INSERT INTO booking_snacks (booking_id, snack_item_id, quantity, unit_price_centavos)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, snack.id, snack.quantity, snack.price_centavos]
      );
    }

    return { id: bookingId, reference };
  });
}

/** Everything a ticket or a scanner needs about one booking. */
async function loadBooking(reference) {
  const bookingResult = await query(
    `SELECT b.*, m.title AS movie_title, m.poster_url, m.slug AS movie_slug,
            m.price_centavos AS ticket_price_centavos,
            s.starts_at, s.screen_label,
            u.name AS customer_name, u.email AS customer_email
       FROM bookings b
       JOIN movies m ON m.id = b.movie_id
       JOIN showtimes s ON s.id = b.showtime_id
       JOIN users u ON u.id = b.user_id
      WHERE b.reference = $1`,
    [reference]
  );

  const booking = bookingResult.rows[0];

  if (booking === undefined) {
    return null;
  }

  const seatsResult = await query(
    `SELECT row_letter, seat_number FROM seats
      WHERE booking_id = $1 ORDER BY row_letter, seat_number`,
    [booking.id]
  );
  booking.seats = seatsResult.rows.map((seat) => `${seat.row_letter}${seat.seat_number}`);

  const snacksResult = await query(
    `SELECT si.name, bs.quantity, bs.unit_price_centavos
       FROM booking_snacks bs
       JOIN snack_items si ON si.id = bs.snack_item_id
      WHERE bs.booking_id = $1
      ORDER BY bs.id`,
    [booking.id]
  );
  booking.snacks = snacksResult.rows;

  return booking;
}

/** The JSON shape sent to the browser. */
function publicBooking(booking) {
  return {
    reference: booking.reference,
    status: booking.status,
    concessionStatus: booking.concession_status,
    totalCentavos: booking.total_centavos,
    ticketPriceCentavos: booking.ticket_price_centavos,
    movie: {
      slug: booking.movie_slug,
      title: booking.movie_title,
      posterUrl: booking.poster_url,
    },
    showtime: {
      startsAt: Number(booking.starts_at),
      screenLabel: booking.screen_label,
    },
    seats: booking.seats,
    snacks: booking.snacks.map((snack) => ({
      name: snack.name,
      quantity: snack.quantity,
      unitPriceCentavos: snack.unit_price_centavos,
    })),
    customerName: booking.customer_name,
    holdExpiresAt: booking.hold_expires_at === null ? null : Number(booking.hold_expires_at),
    checkedInAt: booking.checked_in_at === null ? null : Number(booking.checked_in_at),
    createdAt: Number(booking.created_at),
    paidAt: booking.paid_at === null ? null : Number(booking.paid_at),
  };
}

/**
 * Marks a booking paid and turns its held seats into sold ones.
 *
 * Safe to call more than once with the same booking: a booking that is already
 * paid is left exactly as it is. That matters because PayMongo can deliver the
 * same webhook twice, and the confirming page may reconcile the booking at the
 * same moment the webhook arrives.
 */
async function confirmPaid(reference, { paymentId = null } = {}) {
  return transaction(async (client) => {
    const bookingResult = await client.query(
      "SELECT * FROM bookings WHERE reference = $1 FOR UPDATE",
      [reference]
    );
    const booking = bookingResult.rows[0];

    if (booking === undefined) {
      return { changed: false, reason: "unknown-booking" };
    }

    if (booking.status === "paid") {
      return { changed: false, reason: "already-paid", bookingId: booking.id };
    }

    if (booking.status === "cancelled") {
      return { changed: false, reason: "cancelled", bookingId: booking.id };
    }

    // An expired booking whose payment then lands is still honoured, but only
    // if nobody else has taken its seats in the meantime.
    if (booking.status === "expired") {
      const stillOursResult = await client.query(
        "SELECT COUNT(*)::int AS n FROM seats WHERE booking_id = $1 AND status = 'held'",
        [booking.id]
      );

      if (stillOursResult.rows[0].n === 0) {
        return { changed: false, reason: "seats-released", bookingId: booking.id };
      }
    }

    const now = Date.now();

    await client.query(
      `UPDATE bookings
          SET status = 'paid', paid_at = $1, hold_expires_at = NULL,
              paymongo_payment_id = COALESCE($2, paymongo_payment_id)
        WHERE id = $3`,
      [now, paymentId, booking.id]
    );

    await client.query(
      "UPDATE seats SET status = 'sold', held_until = NULL WHERE booking_id = $1",
      [booking.id]
    );

    return { changed: true, bookingId: booking.id };
  });
}

/**
 * Asks PayMongo directly whether a pending booking was in fact paid.
 *
 * The webhook is the reliable signal, but it cannot reach a machine that has
 * no public address — which is every development machine. This fallback is
 * what makes the flow testable locally, and it also covers a webhook that is
 * simply late. PayMongo's own docs recommend it as the backstop.
 */
async function reconcileWithPayMongo(booking) {
  if (booking.status !== "pending_payment" || booking.paymongo_checkout_session_id === null) {
    return { reconciled: false };
  }

  let session;

  try {
    session = await paymongo.retrieveCheckoutSession(booking.paymongo_checkout_session_id);
  } catch (error) {
    // Deliberately loud, and deliberately distinct from "not paid yet" below.
    // These two used to be indistinguishable in the logs, which is how a
    // wrong API version went unnoticed while every customer who paid was
    // left staring at the confirming page: the request 404'd, the failure
    // was recorded as an ordinary "still waiting", and nothing ever said so.
    console.error(
      `[booking ${booking.reference}] COULD NOT ASK PAYMONGO whether this was paid ` +
        `(session ${booking.paymongo_checkout_session_id}): ${error.message}. ` +
        "The customer may have paid and be waiting; this is not the same as an unpaid booking."
    );
    return { reconciled: false, error: error.message };
  }

  const payments = session?.attributes?.payments ?? [];
  const paid = payments.find((payment) => payment?.attributes?.status === "paid");

  if (paid === undefined) {
    return { reconciled: false };
  }

  const result = await confirmPaid(booking.reference, { paymentId: paid.id });

  return { reconciled: result.changed };
}

/** Gives up a booking that has not been paid for and frees its seats. */
async function cancelDraft(reference, userId) {
  return transaction(async (client) => {
    const bookingResult = await client.query("SELECT * FROM bookings WHERE reference = $1", [reference]);
    const booking = bookingResult.rows[0];

    if (booking === undefined || Number(booking.user_id) !== userId) {
      throw new BookingError("Booking not found.", 404);
    }

    if (booking.status !== "pending_payment") {
      throw new BookingError("That booking can no longer be cancelled.", 409);
    }

    await client.query(
      `UPDATE seats SET status = 'available', held_until = NULL, booking_id = NULL
        WHERE booking_id = $1 AND status = 'held'`,
      [booking.id]
    );

    await client.query(
      "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = $1",
      [booking.id]
    );

    return true;
  });
}

module.exports = {
  BookingError,
  MAX_SEATS_PER_BOOKING,
  createDraft,
  loadBooking,
  publicBooking,
  confirmPaid,
  reconcileWithPayMongo,
  cancelDraft,
};
