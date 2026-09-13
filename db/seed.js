"use strict";

const bcrypt = require("bcryptjs");

const { transaction, migrate, closePool } = require("../src/db");
const { config } = require("../src/config");
const { createShowtimesForMovie } = require("../src/services/scheduling");

const DAYS_OF_SHOWTIMES = 5;

const MOVIES = [
  {
    slug: "eternal-sunshine",
    title: "Eternal Sunshine of the Spotless Mind",
    genre: "Romance, Drama",
    length_text: "1h 48m",
    rating: "PG-13",
    price_centavos: 22000,
    poster_url: "/photo/eternal-sunshine.jpg",
    status: "now_showing",
    status_note: "Until Oct 30, 2026",
  },
  {
    slug: "pieces-of-us",
    title: "Pieces of Us",
    genre: "Romance, Drama",
    length_text: "1h 52m",
    rating: "PG-13",
    price_centavos: 22000,
    poster_url: "/photo/Pieces-of-us.jpg",
    status: "now_showing",
    status_note: "Until Nov 14, 2026",
  },
  {
    slug: "joker",
    title: "Joker",
    genre: "Crime, Thriller",
    length_text: "2h 2m",
    rating: "R-16",
    price_centavos: 22000,
    poster_url: "/photo/Joker.jpg",
    status: "now_showing",
    status_note: "Until Nov 28, 2026",
  },
  {
    slug: "the-reckoning",
    title: "The Reckoning",
    genre: "Action, Thriller",
    length_text: "1h 58m",
    rating: "R-16",
    price_centavos: 25000,
    poster_url: "/photo/The-Reckoning.jpg",
    status: "now_showing",
    status_note: "Until Dec 12, 2026",
  },
  {
    slug: "hush",
    title: "Hush",
    genre: "Horror, Thriller",
    length_text: "1h 22m",
    rating: "R-16",
    price_centavos: 22000,
    poster_url: "/photo/Hush.jpg",
    status: "upcoming",
    status_note: "Opens Sep 26",
  },
  {
    slug: "broken-of-love",
    title: "Broken [of] Love",
    genre: "Romance, Drama",
    length_text: "1h 45m",
    rating: "PG-13",
    price_centavos: 22000,
    poster_url: "/photo/Broken-%5Bof%5D-Love.jpg",
    status: "upcoming",
    status_note: "Opens Oct 17",
  },
];

const SNACKS = [
  { category: "Popcorn", name: "Popcorn, Regular", price_centavos: 12000 },
  { category: "Popcorn", name: "Popcorn, Large", price_centavos: 16000 },
  { category: "Drinks", name: "Soda, Regular", price_centavos: 7000 },
  { category: "Drinks", name: "Soda, Large", price_centavos: 9500 },
  { category: "Candy", name: "Chocolate Bar", price_centavos: 6000 },
  { category: "Candy", name: "Gummy Candy", price_centavos: 5500 },
  { category: "Combos", name: "Solo Combo", price_centavos: 18000 },
  { category: "Combos", name: "Barkada Combo", price_centavos: 48000 },
];

// Development accounts. The scanner account is deliberately separate from the
// staff account: whoever works the door signs in as this one and never sees
// the dashboard or the takings.
const ACCOUNTS = [
  { name: "Cinemax Manager", email: "staff@cinemax.test", password: "staff1234", role: "staff" },
  { name: "Door Scanner", email: "scanner@cinemax.test", password: "scan1234", role: "scanner" },
  { name: "Juan Dela Cruz", email: "juan@example.test", password: "juan1234", role: "customer" },
];

async function seedAccounts(client) {
  const existingResult = await client.query("SELECT email FROM users");
  const existing = existingResult.rows.map((row) => row.email);

  for (const account of ACCOUNTS) {
    if (existing.includes(account.email)) {
      continue;
    }

    await client.query(
      "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [account.name, account.email, null, bcrypt.hashSync(account.password, 12), account.role, Date.now()]
    );

    console.log(`  account  ${account.role.padEnd(8)} ${account.email}  (password: ${account.password})`);
  }
}

async function seedSnacks(client) {
  const existingResult = await client.query("SELECT name FROM snack_items");
  const existing = existingResult.rows.map((row) => row.name);

  let index = 0;

  for (const snack of SNACKS) {
    if (!existing.includes(snack.name)) {
      await client.query(
        "INSERT INTO snack_items (category, name, price_centavos, sort_order) VALUES ($1, $2, $3, $4)",
        [snack.category, snack.name, snack.price_centavos, index]
      );
    }

    index += 1;
  }
}

async function seedMovies(client) {
  const existingResult = await client.query("SELECT slug FROM movies");
  const existing = existingResult.rows.map((row) => row.slug);

  for (const movie of MOVIES) {
    if (existing.includes(movie.slug)) {
      continue;
    }

    await client.query(
      `INSERT INTO movies (slug, title, genre, length_text, rating, price_centavos,
                           poster_url, status, status_note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        movie.slug,
        movie.title,
        movie.genre,
        movie.length_text,
        movie.rating,
        movie.price_centavos,
        movie.poster_url,
        movie.status,
        movie.status_note,
        Date.now(),
      ]
    );
  }
}

async function seedShowtimesAndSeats(client) {
  const moviesResult = await client.query(
    "SELECT id, slug FROM movies WHERE status = 'now_showing' AND archived_at IS NULL"
  );

  let showtimesCreated = 0;
  let seatsCreated = 0;

  for (const movie of moviesResult.rows) {
    const countResult = await client.query("SELECT COUNT(*)::int AS n FROM showtimes WHERE movie_id = $1", [
      movie.id,
    ]);

    if (countResult.rows[0].n > 0) {
      continue;
    }

    const { showtimesCreated: created, seatsCreated: seats } = await createShowtimesForMovie(
      client,
      movie.id,
      { days: DAYS_OF_SHOWTIMES }
    );

    showtimesCreated += created;
    seatsCreated += seats;
  }

  if (showtimesCreated > 0) {
    console.log(`  showtimes ${showtimesCreated} created, ${seatsCreated} seats`);
  }
}

async function main() {
  if (config.databaseUrl === null) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  await migrate();

  console.log(`Seeding ${config.databaseUrl.replace(/:[^:@]+@/, ":****@")}`);

  await transaction(async (client) => {
    await seedAccounts(client);
    await seedSnacks(client);
    await seedMovies(client);
    await seedShowtimesAndSeats(client);
  });

  const { query } = require("../src/db");
  const counts = {
    users: (await query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n,
    movies: (await query("SELECT COUNT(*)::int AS n FROM movies")).rows[0].n,
    showtimes: (await query("SELECT COUNT(*)::int AS n FROM showtimes")).rows[0].n,
    seats: (await query("SELECT COUNT(*)::int AS n FROM seats")).rows[0].n,
    snacks: (await query("SELECT COUNT(*)::int AS n FROM snack_items")).rows[0].n,
  };

  console.log("Done:", JSON.stringify(counts));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
