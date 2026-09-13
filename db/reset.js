"use strict";

const { pool, migrate, closePool } = require("../src/db");
const { config } = require("../src/config");

const TABLES = [
  "webhook_events",
  "booking_snacks",
  "seats",
  "bookings",
  "showtimes",
  "movies",
  "snack_items",
  "session",
  "users",
];

async function main() {
  if (config.isProduction) {
    console.error("Refusing to reset the database while NODE_ENV=production.");
    process.exit(1);
  }

  if (config.databaseUrl === null) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  await migrate();

  // RESTART IDENTITY also resets the id counters, so a fresh seed looks the
  // same as it would on a brand new database. CASCADE follows every foreign
  // key, so the tables don't need to be listed in dependency order.
  await pool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  console.log("Tables emptied.");

  require("./seed.js");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  closePool();
});
