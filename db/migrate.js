"use strict";

/** Applies schema.sql against DATABASE_URL. Safe to re-run. */

const { migrate, closePool } = require("../src/db");
const { config } = require("../src/config");

async function main() {
  if (config.databaseUrl === null) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  await migrate();
  console.log("Schema applied.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
