"use strict";

const { config, checkConfig } = require("../src/config");
const { migrate } = require("../src/db");
const { createApp } = require("../src/app");

const MIGRATE_ON_BOOT = process.env.RUN_MIGRATION_ON_BOOT === "1";

let ready = null;

async function prepare() {
  for (const problem of checkConfig()) {
    console.warn(`[config] ${problem}`);
  }
  
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
