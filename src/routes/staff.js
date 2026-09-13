"use strict";

const express = require("express");

const { query, transaction, placeholders } = require("../db");
const { requireCapability } = require("../middleware/guards");
const { createShowtimesForMovie } = require("../services/scheduling");
const { normalizeScannedCode, looksLikeReference } = require("../services/reference");
const { uploadPoster, EXTENSION_BY_TYPE } = require("../services/storage");
const bookings = require("../services/bookings");

const router = express.Router();

const RATINGS = ["G", "PG", "PG-13", "R-13", "R-16", "R-18"];
const MAX_POSTER_BYTES = 5 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Dashboard — staff only
 * ------------------------------------------------------------------ */

router.get("/summary", requireCapability("dashboard"), async (req, res, next) => {
  try {
    // Every figure here is counted from paid bookings. Nothing is typed in.
    const ticketsResult = await query(
      `SELECT COALESCE(SUM(m.price_centavos * seat_counts.n), 0)::bigint AS revenue,
              COALESCE(SUM(seat_counts.n), 0)::int AS sold
         FROM bookings b
         JOIN movies m ON m.id = b.movie_id
         JOIN (SELECT booking_id, COUNT(*)::int AS n FROM seats WHERE booking_id IS NOT NULL
                GROUP BY booking_id) seat_counts ON seat_counts.booking_id = b.id
        WHERE b.status = 'paid'`
    );

    const snacksResult = await query(
      `SELECT COALESCE(SUM(bs.unit_price_centavos * bs.quantity), 0)::bigint AS revenue,
              COALESCE(SUM(bs.quantity), 0)::int AS sold
         FROM booking_snacks bs
         JOIN bookings b ON b.id = bs.booking_id
        WHERE b.status = 'paid'`
    );

    const tickets = ticketsResult.rows[0];
    const snacks = snacksResult.rows[0];

    res.json({
      ticketRevenueCentavos: Number(tickets.revenue),
      ticketsSold: tickets.sold,
      snackRevenueCentavos: Number(snacks.revenue),
      snacksSold: snacks.sold,
      totalRevenueCentavos: Number(tickets.revenue) + Number(snacks.revenue),
    });
  } catch (error) {
    next(error);
  }
});

/** The snack counter queue, grouped the way the dashboard lays it out. */
router.get("/orders", requireCapability("dashboard"), async (req, res, next) => {
  try {
    const ordersResult = await query(
      `SELECT b.id, b.reference, b.concession_status, u.name AS customer_name
         FROM bookings b
         JOIN users u ON u.id = b.user_id
        WHERE b.status = 'paid' AND b.concession_status <> 'none'
        ORDER BY b.paid_at`
    );

    /*
     * The snacks for every order in one query, not one query per order.
     *
     * This endpoint is polled every twenty seconds by each open dashboard
     * (see public/js/admin.js) and the order list is unbounded, so the old
     * loop-and-query cost 1+N round trips on every tick — at a hundred
     * pending orders that was a hundred and one queries every twenty seconds,
     * per till.
     */
    const bookingIds = ordersResult.rows.map((row) => row.id);

    const itemsByBooking = new Map();

    if (bookingIds.length > 0) {
      // Scalar placeholders rather than an array parameter, so bs.booking_id
      // stays bare and its index is used — see placeholders() in db.js.
      const itemsResult = await query(
        `SELECT bs.booking_id, si.name, bs.quantity, bs.unit_price_centavos
           FROM booking_snacks bs
           JOIN snack_items si ON si.id = bs.snack_item_id
          WHERE bs.booking_id IN (${placeholders(bookingIds)})
          ORDER BY bs.id`,
        bookingIds
      );

      for (const item of itemsResult.rows) {
        const key = String(item.booking_id);

        if (!itemsByBooking.has(key)) {
          itemsByBooking.set(key, []);
        }

        itemsByBooking.get(key).push(item);
      }
    }

    const orders = [];

    for (const row of ordersResult.rows) {
      const items = itemsByBooking.get(String(row.id)) ?? [];

      orders.push({
        id: row.id,
        reference: row.reference,
        customerName: row.customer_name,
        status: row.concession_status,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        totalCentavos: items.reduce((sum, item) => sum + item.unit_price_centavos * item.quantity, 0),
        items: items.map((item) => ({ name: item.name, quantity: item.quantity })),
      });
    }

    res.json({ orders });
  } catch (error) {
    next(error);
  }
});

router.patch("/orders/:id/status", requireCapability("dashboard"), async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const status = String(req.body?.status ?? "");

    // Only the two forward moves are targets. "preparing" is where an order
    // starts, never somewhere it can be sent back to.
    if (!["ready", "sold"].includes(status)) {
      return res.status(400).json({ error: "A snack order can only be moved to Ready or Sold." });
    }

    /*
     * A snack order only moves forward: preparing -> ready -> sold. The
     * dropdown on the dashboard only offers the one next step, but that is
     * just what staff can reach — the rule is enforced here, where a crafted
     * request cannot get round it. Naming the current status in the WHERE is
     * also what makes this safe against two tills pressing at once: the
     * second one matches no row and is told the order already moved on.
     */
    const cameFrom = { ready: "preparing", sold: "ready" }[status];

    const result = await query(
      `UPDATE bookings SET concession_status = $1
        WHERE id = $2 AND status = 'paid' AND concession_status = $3`,
      [status, id, cameFrom]
    );

    if (result.rowCount === 0) {
      const current = await query(
        "SELECT concession_status FROM bookings WHERE id = $1 AND status = 'paid'",
        [id]
      );

      if (current.rows.length === 0 || current.rows[0].concession_status === "none") {
        return res.status(404).json({ error: "That order was not found." });
      }

      return res.status(409).json({
        error: `That order is already ${current.rows[0].concession_status}, so it cannot be moved to ${status}.`,
      });
    }

    res.json({ id, status });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ *
 * Movies — staff only
 * ------------------------------------------------------------------ */

router.get("/movies", requireCapability("movies"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT m.*, COALESCE(ticket_counts.n, 0) AS tickets_sold
         FROM movies m
         LEFT JOIN (
           SELECT b.movie_id, COUNT(*)::int AS n
             FROM seats s
             JOIN bookings b ON b.id = s.booking_id
            WHERE b.status = 'paid'
            GROUP BY b.movie_id
         ) ticket_counts ON ticket_counts.movie_id = m.id
        WHERE m.archived_at IS NULL
        ORDER BY CASE m.status WHEN 'now_showing' THEN 0 ELSE 1 END, m.id`
    );

    const movies = result.rows.map((movie) => ({
      id: movie.id,
      slug: movie.slug,
      title: movie.title,
      genre: movie.genre,
      lengthText: movie.length_text,
      rating: movie.rating,
      priceCentavos: movie.price_centavos,
      posterUrl: movie.poster_url,
      status: movie.status,
      statusNote: movie.status_note,
      ticketsSold: movie.tickets_sold,
    }));

    res.json({
      movies,
      counts: {
        total: movies.length,
        nowShowing: movies.filter((movie) => movie.status === "now_showing").length,
        upcoming: movies.filter((movie) => movie.status === "upcoming").length,
        ticketsSold: movies.reduce((sum, movie) => sum + movie.ticketsSold, 0),
      },
    });
  } catch (error) {
    next(error);
  }
});

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

router.post("/movies", requireCapability("movies"), async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const title = String(body.title ?? "").trim();
    const genre = String(body.genre ?? "").trim();
    const lengthText = String(body.lengthText ?? "").trim();
    const rating = String(body.rating ?? "").trim();
    const status = String(body.status ?? "now_showing").trim();
    const statusNote = String(body.statusNote ?? "").trim();
    const pricePesos = Number.parseFloat(body.pricePesos);

    const fields = {};

    if (title.length < 1) {
      fields.title = "Enter the movie title.";
    }

    if (genre.length < 1) {
      fields.genre = "Enter at least one genre.";
    }

    if (lengthText.length < 1) {
      fields.lengthText = "Enter the running time, such as 1h 58m.";
    }

    if (!RATINGS.includes(rating)) {
      fields.rating = "Choose a rating.";
    }

    if (!Number.isFinite(pricePesos) || pricePesos <= 0 || pricePesos > 100000) {
      fields.pricePesos = "Enter a ticket price in pesos.";
    }

    if (!["now_showing", "upcoming"].includes(status)) {
      fields.status = "Choose where the movie goes.";
    }

    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ error: "Please check the form.", fields });
    }

    let slug = slugify(title);

    if (slug === "") {
      slug = "movie";
    }

    // Titles can repeat; addresses cannot.
    let candidate = slug;
    let counter = 2;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const taken = await query("SELECT 1 FROM movies WHERE slug = $1", [candidate]);

      if (taken.rows.length === 0) {
        break;
      }

      candidate = `${slug}-${counter}`;
      counter += 1;
    }

    const result = await transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO movies (slug, title, genre, length_text, rating, price_centavos,
                             poster_url, status, status_note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          candidate,
          title,
          genre,
          lengthText,
          rating,
          Math.round(pricePesos * 100),
          String(body.posterUrl ?? "/photo/The-Reckoning.jpg"),
          status,
          statusNote === "" ? null : statusNote,
          Date.now(),
        ]
      );
      const movieId = inserted.rows[0].id;

      // Only a showing movie gets showtimes; an upcoming one is deliberately
      // not bookable until staff move it across.
      if (status === "now_showing") {
        await createShowtimesForMovie(client, movieId);
      }

      return movieId;
    });

    res.status(201).json({ id: result, slug: candidate });
  } catch (error) {
    next(error);
  }
});

/**
 * Takes a movie off the listings without destroying it.
 *
 * A hard delete would orphan every paid booking that points at it, so the row
 * stays and is filtered out everywhere by archived_at IS NULL.
 */
router.delete("/movies/:id", requireCapability("movies"), async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);

    const result = await query(
      "UPDATE movies SET archived_at = $1 WHERE id = $2 AND archived_at IS NULL",
      [Date.now(), id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "That movie was not found." });
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/**
 * Poster upload. The image is sent as the raw request body rather than as a
 * multipart form, which keeps this to one small endpoint with no extra
 * dependency and nothing to parse. It goes to Supabase Storage, not local
 * disk — Vercel's filesystem is read-only outside /tmp and is not shared
 * between function instances, so a file written there would vanish the
 * moment a different instance served the next request.
 */
router.post(
  "/movies/:id/poster",
  requireCapability("movies"),
  express.raw({ type: Object.keys(EXTENSION_BY_TYPE), limit: MAX_POSTER_BYTES }),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      const movie = await query("SELECT id FROM movies WHERE id = $1", [id]);

      if (movie.rows.length === 0) {
        return res.status(404).json({ error: "That movie was not found." });
      }

      const contentType = req.get("Content-Type");

      if (EXTENSION_BY_TYPE[contentType] === undefined) {
        return res.status(415).json({ error: "Posters must be a JPEG, PNG or WebP image." });
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "No image was received." });
      }

      const posterUrl = await uploadPoster(id, req.body, contentType);

      await query("UPDATE movies SET poster_url = $1 WHERE id = $2", [posterUrl, id]);

      res.json({ posterUrl });
    } catch (error) {
      if (error.message.startsWith("SUPABASE_URL") || error.message.startsWith("Could not upload")) {
        return res.status(502).json({ error: error.message });
      }

      next(error);
    }
  }
);

/* ------------------------------------------------------------------ *
 * Door scanner — staff and scanner accounts
 * ------------------------------------------------------------------ */

/** Looks up whatever the camera decoded, without changing anything. */
router.get("/scan/:code", requireCapability("scanner"), async (req, res, next) => {
  try {
    const reference = normalizeScannedCode(req.params.code);

    if (!looksLikeReference(reference)) {
      return res.status(404).json({ result: "unknown", error: "That code is not a Cinemax ticket." });
    }

    const booking = await bookings.loadBooking(reference);

    if (booking === null) {
      return res.status(404).json({ result: "unknown", error: "That code is not a Cinemax ticket." });
    }

    if (booking.status !== "paid") {
      return res.status(409).json({
        result: "unpaid",
        error: "That booking was never paid for.",
        booking: bookings.publicBooking(booking),
      });
    }

    res.json({
      result: booking.checked_in_at === null ? "valid" : "already-used",
      booking: bookings.publicBooking(booking),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The door staff's Confirm booking tap.
 *
 * The UPDATE only matches while checked_in_at is still null, so two scanners
 * confirming the same ticket at the same moment cannot both succeed — the
 * second one changes no rows and is told the ticket is already used. This is
 * naturally race-safe under Postgres's own row-level locking during an
 * UPDATE; no explicit FOR UPDATE is needed for a single conditional write.
 */
router.post("/scan/:code/check-in", requireCapability("scanner"), async (req, res, next) => {
  try {
    const reference = normalizeScannedCode(req.params.code);

    if (!looksLikeReference(reference)) {
      return res.status(404).json({ result: "unknown", error: "That code is not a Cinemax ticket." });
    }

    const outcome = await transaction(async (client) => {
      const bookingResult = await client.query("SELECT * FROM bookings WHERE reference = $1", [reference]);
      const booking = bookingResult.rows[0];

      if (booking === undefined) {
        return { result: "unknown" };
      }

      if (booking.status !== "paid") {
        return { result: "unpaid" };
      }

      const update = await client.query(
        "UPDATE bookings SET checked_in_at = $1, checked_in_by = $2 WHERE id = $3 AND checked_in_at IS NULL",
        [Date.now(), req.user.id, booking.id]
      );

      return { result: update.rowCount === 1 ? "checked-in" : "already-used" };
    });

    if (outcome.result === "unknown") {
      return res.status(404).json({ result: "unknown", error: "That code is not a Cinemax ticket." });
    }

    if (outcome.result === "unpaid") {
      return res.status(409).json({ result: "unpaid", error: "That booking was never paid for." });
    }

    const booking = await bookings.loadBooking(reference);

    res.json({ result: outcome.result, booking: bookings.publicBooking(booking) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
