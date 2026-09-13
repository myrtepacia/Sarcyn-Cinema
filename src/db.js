"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { Pool, types } = require("pg");

const { config } = require("./config");

/*
 * By default node-postgres returns a BIGINT (OID 20) column as a JS string,
 * not a number — a 64-bit value can exceed what a JS number can represent
 * exactly, so the driver plays it safe. Every id and every epoch-millisecond
 * timestamp in this schema is BIGINT, and none of them ever approach that
 * limit (ids are small auto-increment counters; the largest timestamp this
 * app will ever see is still four orders of magnitude under
 * Number.MAX_SAFE_INTEGER), so parsing them as numbers is safe here — and
 * necessary: req.user.id, session userId, and every booking/showtime/seat id
 * get compared with ===/!== all over the codebase, and a string on one side
 * of that comparison against a number on the other (Number(x) !== rawId) is
 * silently always true. That exact bug existed in the checkout-ownership and
 * cancel-draft checks until this fix — caught only by reasoning about pg's
 * documented default, not by the pg-mem test harness, which returns plain
 * numbers regardless of this setting and so cannot exercise it either way.
 */
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

/*
 * One pool per process, reused across requests (and, on Vercel, across warm
 * invocations of the same function instance) rather than opening a
 * connection per query. `max` is kept small deliberately: Supabase's pooled
 * connection string already fans this out through PgBouncer, and a
 * serverless function can end up with many instances running at once, each
 * holding its own small pool — a large `max` per instance multiplies into a
 * connection count PgBouncer's own pool was sized for.
 */
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.isServerless ? 3 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.databaseUrl && config.databaseUrl.includes("supabase.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on("error", (error) => {
  // Fired for a connection that failed while sitting idle in the pool, not
  // for a query error — those reject the query's own promise. Left
  // unhandled, this event crashes the whole process.
  console.error("[db] idle connection error:", error.message);
});

/** Runs one query against the pool. Most call sites only need this. */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Runs `work` inside a transaction on a single dedicated connection, and
 * commits or rolls back around it.
 *
 * This must be used — not pool.query() — for anything that needs more than
 * one statement to succeed or fail together, because pool.query() may hand
 * different statements to different connections. `work` receives a client
 * whose .query() participates in the transaction; use it, not the pool's.
 */
async function transaction(work) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("[db] rollback failed:", rollbackError.message);
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Builds the `$1, $2, $3` placeholder list for an `IN (...)` clause over
 * `values`, numbered from `from`.
 *
 * This exists because matching a BIGINT column against a list of ids has no
 * good array form here. `= ANY($1)` leaves pg to pick an array type on its
 * own and it does not reliably pick one that compares against bigint.
 * `= ANY($1::bigint[])` fixes that and uses the index on real Postgres, but
 * pg-mem — which the test suite falls back to when DATABASE_URL is unset —
 * cannot cast arrays at all and silently matches zero rows, which is a far
 * worse failure than an error. And `column::text = ANY($1::text[])` works
 * everywhere but casts the indexed column on every row, so the index goes
 * unused and the query becomes a sequential scan.
 *
 * A list of plain scalar placeholders sidesteps all three: Postgres infers
 * each one's type from the column it is compared against, so the column stays
 * bare and the index is used (verified with EXPLAIN: `Index Scan using
 * idx_seats_booking`), and pg-mem handles it too.
 *
 * Only the placeholder tokens are ever put into the SQL string — the values
 * themselves stay parameters, so there is nothing here to inject through.
 */
function placeholders(values, from = 1) {
  return values.map((_, index) => `$${index + from}`).join(", ");
}

/** True when a query() error is a Postgres unique-violation (code 23505). */
function isUniqueViolation(error) {
  return error && error.code === "23505";
}

/** Applies schema.sql. Every statement is IF NOT EXISTS, so safe to re-run. */
async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(schema);
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  transaction,
  placeholders,
  isUniqueViolation,
  migrate,
  closePool,
};
