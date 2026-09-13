"use strict";

/*
 * The single entry point Vercel calls for every request — see vercel.json,
 * which routes everything here rather than letting Vercel's own static-file
 * layer serve anything from public/ directly. That matters: three of the
 * pages in public/ (admin.html, admin-movies.html, admin-scanner.html) are
 * only safe to hand out after the role check in src/app.js runs, and a
 * request that reached them as a plain static file would skip that check
 * entirely.
 *
 * An Express app is itself a valid (req, res) handler, which is what Vercel's
 * Node.js runtime expects — no adapter package needed.
 */

const { config, checkConfig } = require("../src/config");
const { migrate } = require("../src/db");
const { createApp } = require("../src/app");

/*
 * The schema is NOT applied from here any more.
 *
 * It used to run on every cold start, and a cold start is frequent on
 * Vercel — each one replayed all 33 statements in db/schema.sql and, because
 * nine of them are `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, took an
 * ACCESS EXCLUSIVE lock on all nine tables against the live database before
 * the first request could be answered. Every statement is IF NOT EXISTS so
 * nothing was corrupted, but it put a Postgres connection and about thirty
 * DDL statements in front of a page load for no gain: the schema only changes
 * when db/schema.sql changes, which is a deploy, not a request.
 *
 * Applying it is now a deliberate step — `npm run migrate` — run once against
 * a new database. Set RUN_MIGRATION_ON_BOOT=1 to get the old behaviour back
 * temporarily, for bootstrapping a fresh deployment when there is no
 * convenient way to run the script by hand.
 */
const MIGRATE_ON_BOOT = process.env.RUN_MIGRATION_ON_BOOT === "1";

let ready = null;

async function prepare() {
  for (const problem of checkConfig()) {
    console.warn(`[config] ${problem}`);
  }

  // Skipped rather than attempted-and-caught when DATABASE_URL isn't set at
  // all (an unconfigured preview deployment, most likely) — checkConfig()
  // already said so above; there's nothing migrate() would add but a raw
  // connection error for a host that was never going to exist.
  if (MIGRATE_ON_BOOT && config.databaseUrl !== null) {
    console.warn("[startup] RUN_MIGRATION_ON_BOOT is set — applying db/schema.sql");
    await migrate();
  }
}

function ensureReady() {
  if (ready === null) {
    ready = prepare();
  }

  return ready;
}

const app = createApp();

module.exports = async (req, res) => {
  try {
    await ensureReady();
  } catch (error) {
    console.error("[startup] migration failed:", error);
    res.statusCode = 500;
    res.end("Database is not reachable.");
    return;
  }

  app(req, res);
};
