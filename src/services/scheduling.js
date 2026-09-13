"use strict";

const SEAT_ROWS = ["A", "B", "C", "D", "E", "F", "G"];
const SEATS_PER_ROW = 10;

/** The five daily screenings, as [hour, minute] in 24-hour time. */
const SHOW_TIMES = [
  [10, 0],
  [13, 0],
  [16, 0],
  [19, 0],
  [22, 0],
];

const DEFAULT_DAYS = 5;

function startOfToday() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight;
}

/**
 * Gives a movie a run of showtimes, each with its own full seat map.
 *
 * A seat row per showtime is what makes availability real: selling D5 at 7pm
 * leaves D5 free at 10pm. `client` must be a transaction client (see db.js) —
 * this writes several hundred rows and should not be half-applied.
 */
async function createShowtimesForMovie(client, movieId, { days = DEFAULT_DAYS, screenLabel = "Cinema 1" } = {}) {
  const midnight = startOfToday();
  let showtimesCreated = 0;
  let seatsCreated = 0;

  for (let day = 0; day < days; day += 1) {
    for (const [hour, minute] of SHOW_TIMES) {
      const starts = new Date(midnight);
      starts.setDate(starts.getDate() + day);
      starts.setHours(hour, minute, 0, 0);

      const result = await client.query(
        "INSERT INTO showtimes (movie_id, starts_at, screen_label) VALUES ($1, $2, $3) RETURNING id",
        [movieId, starts.getTime(), screenLabel]
      );
      const showtimeId = result.rows[0].id;
      showtimesCreated += 1;

      // One INSERT for the whole seat map, rather than 70 round trips.
      const values = [];
      const placeholders = [];
      let i = 1;

      for (const row of SEAT_ROWS) {
        for (let seat = 1; seat <= SEATS_PER_ROW; seat += 1) {
          placeholders.push(`($${i}, $${i + 1}, $${i + 2})`);
          values.push(showtimeId, row, seat);
          i += 3;
        }
      }

      await client.query(
        `INSERT INTO seats (showtime_id, row_letter, seat_number) VALUES ${placeholders.join(", ")}`,
        values
      );
      seatsCreated += values.length / 3;
    }
  }

  return { showtimesCreated, seatsCreated };
}

// The row/seat/time constants above stay private to this file — nothing else
// needs them, and exporting them only invited a second copy of the seat
// layout to drift out of step with the one that actually builds the rows.
module.exports = { createShowtimesForMovie };
