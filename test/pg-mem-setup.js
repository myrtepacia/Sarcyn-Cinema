"use strict";

/*
 * Makes `require("pg")` resolve to an in-memory, Postgres-compatible engine
 * (pg-mem) instead of opening a real network connection — so `npm test` works
 * with no database configured at all.
 *
 * This exists for two different moments:
 *
 *   - Day to day, running tests without a Supabase project handy.
 *   - It is NOT a substitute for testing against real Postgres before a
 *     deploy that matters. pg-mem runs single-threaded in this same process,
 *     so it cannot reproduce genuine two-connection lock contention — the
 *     seat-race test in api.test.js still exercises the SELECT ... FOR UPDATE
 *     code path and confirms the *logic* is right (lock, check, decide,
 *     release), but only a real Postgres proves two requests actually block
 *     each other rather than racing. Once DATABASE_URL points at a real
 *     database (Supabase or otherwise), api.test.js uses it instead and this
 *     file is not loaded — see the top of api.test.js.
 *
 * Only used by tests. Nothing in src/ knows this file exists.
 */

const fs = require("node:fs");
const Module = require("node:module");
const { newDb, DataType } = require("pg-mem");

const SKIP_MARKER = "-- @pg-mem:skip-from-here";

function installPgMem() {
  const db = newDb({ autoCreateForeignKeyIndices: true });

  // Postgres has these built in; pg-mem does not, and our own dependencies'
  // queries reference them — current_database() from somewhere in the
  // stack, and to_timestamp() from connect-pg-simple's own session upsert.
  db.public.registerFunction({ name: "current_database", implementation: () => "cinemax_test" });
  db.public.registerFunction({
    name: "to_timestamp",
    args: [DataType.text],
    returns: DataType.timestamp,
    implementation: (seconds) => new Date(Number(seconds) * 1000),
  });

  const pgAdapter = db.adapters.createPg();

  // pg-mem's fake `pg` module only exports { Pool, Client } — the real one
  // also exports `types`, which src/db.js calls setTypeParser on at require
  // time. A no-op stub is enough here: pg-mem already returns bigint columns
  // as plain JS numbers on its own, so there's nothing for a type parser to
  // fix under this engine (see the comment in src/db.js and in the id-type
  // regression test for what this setting is actually for, and why pg-mem
  // can't be used to verify it).
  pgAdapter.types = { setTypeParser: () => {} };

  const originalLoad = Module._load;
  const originalReadFileSync = fs.readFileSync;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "pg") {
      return pgAdapter;
    }

    return originalLoad.call(Module, request, parent, isMain);
  };

  // src/db.js reads db/schema.sql fresh off disk on every migrate() call —
  // intercepting it here, rather than parsing pg-mem's error and retrying,
  // keeps the production file itself with no knowledge that a test engine
  // exists. Every other file read passes through unchanged.
  fs.readFileSync = function patchedReadFileSync(filePath, ...rest) {
    const content = originalReadFileSync.call(fs, filePath, ...rest);

    if (typeof content === "string" && String(filePath).endsWith("schema.sql")) {
      const cut = content.indexOf(SKIP_MARKER);
      return cut === -1 ? content : content.slice(0, cut);
    }

    return content;
  };

  return {
    db,
    restore: () => {
      Module._load = originalLoad;
      fs.readFileSync = originalReadFileSync;
    },
  };
}

module.exports = { installPgMem };
