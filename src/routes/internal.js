"use strict";

const express = require("express");

const { config } = require("../config");
const { releaseExpiredHolds } = require("../services/holds");

const router = express.Router();

/**
 * Releases seat holds that ran out. Called by Vercel Cron (see vercel.json),
 * which is how the sweep still happens on a serverless deploy where nothing
 * runs continuously enough for a setInterval to mean anything.
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically once that
 * environment variable is set, which is what this checks — without it,
 * anyone who finds this address could trigger it for no reason. That's a
 * low-stakes endpoint either way (every route that reads seats already
 * sweeps lazily), but there's no reason to leave it open.
 */
router.get("/sweep-holds", async (req, res, next) => {
  try {
    if (config.cronSecret !== null) {
      const provided = req.get("Authorization");

      if (provided !== `Bearer ${config.cronSecret}`) {
        return res.status(401).json({ error: "Not authorized." });
      }
    }

    const released = await releaseExpiredHolds();

    res.json({ released });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
