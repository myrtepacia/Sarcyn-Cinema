"use strict";

const { config, checkConfig } = require("./config");
const { migrate, closePool } = require("./db");
const { createApp } = require("./app");
const { startHoldSweeper } = require("./services/holds");

async function main() {
  // Checked before touching the database, so a missing DATABASE_URL gets our
  // own clear message instead of a raw connection error from `pg` — and, in
  // development, so the server can still come up and serve the pages that
  // don't need a database rather than failing to start at all.
  const problems = checkConfig();

  if (problems.length > 0) {
    const heading = config.isProduction
      ? "Refusing to start. Fix these first:"
      : "Starting anyway, but note:";

    console.warn(`\n${heading}`);

    for (const problem of problems) {
      console.warn(`  - ${problem}`);
    }

    console.warn("");

    if (config.isProduction) {
      process.exit(1);
    }
  }

  if (config.databaseUrl !== null) {
    try {
      await migrate();
    } catch (error) {
      console.warn(`Could not reach the database: ${error.message}`);
      console.warn("Pages that need it will show an error until DATABASE_URL is reachable.\n");
    }
  }

  // Only meaningful for a process that stays running between requests. On
  // Vercel this file is never even loaded — see api/index.js — but the guard
  // stays here too in case this app is ever run on Vercel some other way.
  let stopSweeper = null;

  if (!config.isServerless) {
    stopSweeper = startHoldSweeper();
  }

  const app = createApp();

  const server = app.listen(config.port, () => {
    console.log(`Cinemax listening on ${config.baseUrl}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      console.log(`\n${signal} received, shutting down.`);

      if (stopSweeper !== null) {
        stopSweeper();
      }

      server.close(async () => {
        await closePool();
        process.exit(0);
      });
    });
  }
}

main().catch((error) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
