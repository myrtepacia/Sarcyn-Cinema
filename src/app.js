"use strict";

const path = require("node:path");

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const { config } = require("./config");
const { pool } = require("./db");
const { attachUser, requirePageCapability } = require("./middleware/guards");

const authRoutes = require("./routes/auth");
const catalogRoutes = require("./routes/catalog");
const bookingRoutes = require("./routes/bookings");
const staffRoutes = require("./routes/staff");
const webhookRoutes = require("./routes/webhooks");
const internalRoutes = require("./routes/internal");

const PUBLIC_DIR = path.join(config.root, "public");

// Pages that must never be served as static files — see the guarded
// routes below. Kept out of PUBLIC_DIR so express.static cannot reach them.
const VIEWS_DIR = path.join(config.root, "views");

function createApp() {
  const app = express();

  app.disable("x-powered-by");

  // Trusts Vercel's (and any other reverse proxy's) X-Forwarded-* headers, so
  // Secure cookies and req.ip work correctly behind it.
  app.set("trust proxy", 1);

  /*
   * The webhook is mounted before the JSON parser and keeps its body as raw
   * bytes. Its signature is computed over exactly those bytes, and parsing
   * then re-serialising the JSON would change them enough to break the check.
   */
  app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }), webhookRoutes);

  /*
   * The stylesheet, the scripts and the seeded posters are served here, above
   * the session middleware, on purpose.
   *
   * None of them look at who is asking, and everything below this point
   * charges a signed-in visitor three Postgres round trips per file:
   * connect-pg-simple reads the session row, `rolling: true` writes it back,
   * and attachUser looks the user up. One home page is nine asset requests, so
   * that was around thirty queries to serve files that are the same for
   * everyone. Mounted up here they cost none.
   *
   * It also makes them cacheable at all. `rolling: true` means express-session
   * sets a cookie on every request that carries one, and neither Vercel's edge
   * nor any other shared cache will store a response that comes with a
   * Set-Cookie header.
   *
   * These must stay ABOVE the express.static(PUBLIC_DIR) mount further down,
   * which also covers /css and /js and would otherwise answer first with no
   * cache headers at all.
   */
  const cacheFor = (seconds, why) => ({
    setHeaders(res) {
      // s-maxage as well as max-age, because Vercel's edge takes its
      // instruction from s-maxage and every request here is a function
      // invocation (see vercel.json) — an edge hit is a whole invocation
      // saved, not just a round trip.
      res.setHeader("Cache-Control", `public, max-age=${seconds}, s-maxage=${seconds}`);
      res.setHeader("X-Cache-Reason", why);
    },
  });

  /*
   * Five minutes, not a year, and deliberately not `immutable`.
   *
   * There is no build step here, so cinemax.css and common.js keep their names
   * across every deploy. A long lifetime would strand a returning visitor on
   * last week's script with no way to shake it loose, because there is no
   * fingerprint in the filename to change. Five minutes covers the handful of
   * pages someone clicks through in one sitting — which is where nearly all
   * the repeat requests are — without outliving a deploy by much.
   */
  const CODE_SECONDS = 5 * 60;
  app.use("/css", express.static(path.join(PUBLIC_DIR, "css"), cacheFor(CODE_SECONDS, "code")));
  app.use("/js", express.static(path.join(PUBLIC_DIR, "js"), cacheFor(CODE_SECONDS, "code")));

  /*
   * The seeded posters live outside public/ because new posters uploaded
   * through the admin page go to Supabase Storage instead (see
   * services/storage.js) — Vercel's filesystem does not keep local writes
   * between requests, so there is nowhere here to write them.
   *
   * Thirty days rather than a year, and again not `immutable`: nothing in the
   * app can overwrite these six files, but a person can, and one just did —
   * they were re-encoded in place from 21.7MB down to 955KB. `immutable` would
   * have held browsers on the old copies for the full year with no way out.
   */
  const POSTER_SECONDS = 30 * 24 * 60 * 60;
  app.use(
    "/photo",
    express.static(path.join(config.root, "photo"), cacheFor(POSTER_SECONDS, "poster"))
  );

  app.use(express.json({ limit: "100kb" }));

  app.use(
    session({
      name: "cinemax.sid",
      // Backed by Postgres (the `session` table in schema.sql), not memory —
      // a serverless function has no memory of its own to keep a session in
      // from one invocation to the next, and even on a long-running server an
      // in-memory store forgets everyone on every restart.
      store: new pgSession({ pool, tableName: "session", createTableIfMissing: false }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProduction,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  app.use(attachUser);

  app.use("/api/internal", internalRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api", catalogRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/staff", staffRoutes);

  /*
   * Addresses have no .html on the end. Anything still asking for one is sent
   * to the extensionless address instead, permanently — old bookmarks, links
   * already shared, and anything a search engine picked up keep working, and
   * there is only ever one address for a page rather than two that both
   * answer.
   *
   * This has to run before express.static below, which would otherwise hand
   * the .html file straight over and leave both addresses live.
   */
  // Case-insensitive on purpose: a case-sensitive test let /ADMIN.HTML slip
  // past this and reach express.static, which on a case-insensitive
  // filesystem served the file happily.
  app.get(/\.html$/i, (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }

    const clean =
      req.path.toLowerCase() === "/index.html" ? "/" : req.path.slice(0, -".html".length);
    const query = req.originalUrl.slice(req.path.length);

    res.redirect(301, clean + query);
  });

  const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));

  /*
   * Back-office pages, served out of views/ rather than public/.
   *
   * That directory is deliberately NOT behind express.static. Declaring these
   * routes before the static handler is not enough on its own: while the
   * files sat in public/, both /ADMIN.HTML and /admin%2Ehtml walked straight
   * past the route and had the page handed over by express.static with no
   * role check at all. Only the API is guarded well enough that no data
   * leaked, but the page guard is meant to hold too, and chasing path
   * spellings one at a time is a losing game. A file that is not in the
   * static root cannot be served by accident, whatever the address looks like.
   */
  const guardedPage = (file) => (req, res) => res.sendFile(path.join(VIEWS_DIR, file));

  app.get("/admin", requirePageCapability("dashboard"), guardedPage("admin.html"));
  app.get("/admin-movies", requirePageCapability("movies"), guardedPage("admin-movies.html"));
  app.get("/admin-scanner", requirePageCapability("scanner"), guardedPage("admin-scanner.html"));

  // Pretty addresses that all serve one template and fetch their own data.
  app.get("/book/:slug", page("book.html"));
  app.get("/ticket/:reference", page("ticket.html"));
  app.get("/booking/:reference/confirming", page("confirming.html"));
  app.get("/booking/:reference/cancelled", page("cancelled.html"));

  // The pages themselves, which keep revalidating: they are small, and a
  // stale one would pin a visitor to an old shell around fresh data. /css,
  // /js and /photo never reach here — they are mounted above the session
  // middleware near the top of this function.
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "Not found." });
    }

    res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
  });

  // eslint-disable-next-line no-unused-vars -- Express needs all four arguments
  app.use((error, req, res, next) => {
    console.error(`[${req.method} ${req.originalUrl}]`, error);

    if (res.headersSent) {
      return;
    }

    if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/")) {
      return res.status(500).json({ error: "Something went wrong on our side." });
    }

    res.status(500).sendFile(path.join(PUBLIC_DIR, "500.html"));
  });

  return app;
}

module.exports = { createApp };
