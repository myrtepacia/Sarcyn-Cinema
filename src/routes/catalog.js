"use strict";

const express = require("express");

const { query } = require("../db");
const { releaseExpiredHolds } = require("../services/holds");

const router = express.Router();

/** Rows as the browser wants them: money in centavos, times in epoch ms. */
function publicMovie(row) {
  return {
    slug: row.slug,
    title: row.title,
    genre: row.genre,
    lengthText: row.length_text,
    rating: row.rating,
    priceCentavos: row.price_centavos,
    posterUrl: row.poster_url,
    status: row.status,
    statusNote: row.status_note,
  };
}

router.get("/movies", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM movies
        WHERE archived_at IS NULL
        ORDER BY CASE status WHEN 'now_showing' THEN 0 ELSE 1 END, id`
    );

    const movies = result.rows.map(publicMovie);

    res.json({
      movies,
      counts: {
        nowShowing: movies.filter((movie) => movie.status === "now_showing").length,
        upcoming: movies.filter((movie) => movie.status === "upcoming").length,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/movies/:slug", async (req, res, next) => {
  try {
    const result = await query(
      "SELECT * FROM movies WHERE slug = $1 AND archived_at IS NULL",
      [req.params.slug]
    );
    const movie = result.rows[0];

    if (movie === undefined) {
      return res.status(404).json({ error: "That movie is not on the listings." });
    }

    res.json({ movie: publicMovie(movie) });
  } catch (error) {
    next(error);
  }
});

/**
 * Showtimes for a movie, with how many seats are still free in each.
 *
 * Only future showtimes are offered — the old site let you pick a date that
 * had already passed.
 */
router.get("/movies/:slug/showtimes", async (req, res, next) => {
  try {
    const movieResult = await query(
      "SELECT * FROM movies WHERE slug = $1 AND archived_at IS NULL",
      [req.params.slug]
    );
    const movie = movieResult.rows[0];

    if (movie === undefined) {
      return res.status(404).json({ error: "That movie is not on the listings." });
    }

    await releaseExpiredHolds();

    const showtimesResult = await query(
      `SELECT s.id, s.starts_at, s.screen_label,
              COUNT(seat.id)::int AS total_seats,
              COALESCE(SUM(CASE WHEN seat.status = 'available' THEN 1 ELSE 0 END), 0)::int AS free_seats
         FROM showtimes s
         LEFT JOIN seats seat ON seat.showtime_id = s.id
        WHERE s.movie_id = $1 AND s.starts_at > $2
        GROUP BY s.id
        ORDER BY s.starts_at`,
      [movie.id, Date.now()]
    );

    res.json({
      movie: publicMovie(movie),
      showtimes: showtimesResult.rows.map((row) => ({
        id: row.id,
        startsAt: Number(row.starts_at),
        screenLabel: row.screen_label,
        totalSeats: row.total_seats,
        freeSeats: row.free_seats,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/** The seat map for one showtime, as it stands right now. */
router.get("/showtimes/:id/seats", async (req, res, next) => {
  try {
    const showtimeId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(showtimeId)) {
      return res.status(400).json({ error: "Unknown showtime." });
    }

    const showtimeResult = await query(
      `SELECT s.id, s.starts_at, s.screen_label, m.slug, m.title, m.price_centavos
         FROM showtimes s
         JOIN movies m ON m.id = s.movie_id
        WHERE s.id = $1`,
      [showtimeId]
    );
    const showtime = showtimeResult.rows[0];

    if (showtime === undefined) {
      return res.status(404).json({ error: "Unknown showtime." });
    }

    // A seat whose hold has just lapsed should show as free, not as taken.
    await releaseExpiredHolds();

    const seatsResult = await query(
      `SELECT row_letter, seat_number, status
         FROM seats WHERE showtime_id = $1
        ORDER BY row_letter, seat_number`,
      [showtimeId]
    );

    res.json({
      showtime: {
        id: showtime.id,
        startsAt: Number(showtime.starts_at),
        screenLabel: showtime.screen_label,
        movieSlug: showtime.slug,
        movieTitle: showtime.title,
        priceCentavos: showtime.price_centavos,
      },
      // "held" is reported as taken. Whose hold it is is nobody else's business,
      // and either way the seat cannot be picked right now.
      seats: seatsResult.rows.map((seat) => ({
        code: `${seat.row_letter}${seat.seat_number}`,
        row: seat.row_letter,
        number: seat.seat_number,
        taken: seat.status !== "available",
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/snacks", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, category, name, price_centavos FROM snack_items
        WHERE archived_at IS NULL ORDER BY sort_order, id`
    );

    // Grouped the way the booking page lays them out: Popcorn, Drinks, Candy, Combos.
    const groups = [];

    for (const row of result.rows) {
      let group = groups.find((candidate) => candidate.category === row.category);

      if (group === undefined) {
        group = { category: row.category, items: [] };
        groups.push(group);
      }

      group.items.push({ id: row.id, name: row.name, priceCentavos: row.price_centavos });
    }

    res.json({ groups });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
