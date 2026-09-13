"use strict";

const { transaction, placeholders } = require("../db");

/**
 * Releases seats whose hold ran out without a payment arriving, and marks the
 * bookings they belonged to as expired.
 *
 * Called lazily before every seat-map read and every draft creation (so a
 * customer never sees a seat as taken when its hold lapsed a moment ago),
 * and on a timer in a long-running process. On Vercel there is no long-running
 * process to time from, so a Cron job hits /api/internal/sweep-holds instead
 * — see api/index.js and vercel.json.
 */
async function releaseExpiredHolds(now = Date.now()) {
  return transaction(async (client) => {
    const expired = await client.query(
      `SELECT id FROM bookings
        WHERE status = 'pending_payment'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at < $1`,
      [now]
    );

    if (expired.rows.length === 0) {
      return 0;
    }

    // A list of scalar placeholders rather than an array parameter, so that
    // seats.booking_id and bookings.id stay bare and their indexes are used.
    // An earlier version wrote `booking_id::text = ANY($1::text[])`, which was
    // correct but cast the indexed column on every row — a btree on
    // booking_id cannot answer a question about booking_id::text, so both of
    // these updates were sequential scans of seats (10,500+ rows) and
    // bookings. See placeholders() in db.js for why the obvious array forms
    // are not usable here.
    const ids = expired.rows.map((row) => row.id);
    const list = placeholders(ids);

    await client.query(
      `UPDATE seats SET status = 'available', held_until = NULL, booking_id = NULL
        WHERE booking_id IN (${list}) AND status = 'held'`,
      ids
    );

    await client.query(
      `UPDATE bookings SET status = 'expired', hold_expires_at = NULL WHERE id IN (${list})`,
      ids
    );

    return ids.length;
  });
}

/**
 * Starts the background sweep for a long-running process (local dev, or any
 * traditional host). Returns a stop function; unref keeps it from holding the
 * process open on its own. Never call this on Vercel — see config.isServerless.
 */
function startHoldSweeper(intervalMs = 60 * 1000) {
  const timer = setInterval(() => {
    releaseExpiredHolds()
      .then((released) => {
        if (released > 0) {
          console.log(`[holds] released ${released} expired booking(s)`);
        }
      })
      .catch((error) => console.error("[holds] sweep failed:", error.message));
  }, intervalMs);

  timer.unref();

  return () => clearInterval(timer);
}

module.exports = { releaseExpiredHolds, startHoldSweeper };
