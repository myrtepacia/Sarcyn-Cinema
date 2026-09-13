-- Cinemax database schema — PostgreSQL (Supabase).
--
-- Every timestamp column is a BIGINT holding epoch milliseconds, the same
-- Date.now() shape the whole application already uses, so comparisons like
-- "hold_expires_at < ?" work identically to before. This is a deliberate
-- choice, not a shortcut: it means only the database layer changed when we
-- moved off SQLite, not the date arithmetic threaded through every service.
--
-- Every money column is an INTEGER holding centavos, never pesos and never a
-- float. PayMongo works in centavos too, so amounts pass straight through
-- without conversion: PHP 220.00 is 22000. A 4-byte integer tops out around
-- 21 million pesos per line item, comfortably above PayMongo's own ₱10M card
-- ceiling, so INTEGER (not BIGINT) is enough here.

-- People. One table for customers and staff, separated by role.
--
--   customer - can book and see their own tickets
--   staff    - the dashboard, the movie list, and the scanner
--   scanner  - the door scanner only, nothing else
--
-- The scanner role exists so the person checking tickets at the door signs in
-- with an account that cannot open the dashboard or the takings figures.
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT   NOT NULL,
  email         TEXT   NOT NULL UNIQUE,   -- always stored lowercased
  phone         TEXT,
  password_hash TEXT   NOT NULL,
  role          TEXT   NOT NULL DEFAULT 'customer'
                       CHECK (role IN ('customer', 'staff', 'scanner')),
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS movies (
  id             BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug           TEXT    NOT NULL UNIQUE,  -- used in the /book/<slug> address
  title          TEXT    NOT NULL,
  genre          TEXT    NOT NULL,
  length_text    TEXT    NOT NULL,         -- shown as typed, e.g. "1h 48m"
  rating         TEXT    NOT NULL
                         CHECK (rating IN ('G', 'PG', 'PG-13', 'R-13', 'R-16', 'R-18')),
  price_centavos INTEGER NOT NULL CHECK (price_centavos > 0),
  poster_url     TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('now_showing', 'upcoming')),
  status_note    TEXT,                     -- "Until Oct 30, 2026" / "Opens Sep 26"
  archived_at    BIGINT,                   -- set instead of deleting, see staff routes
  created_at     BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_movies_status ON movies (status, archived_at);

CREATE TABLE IF NOT EXISTS showtimes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movie_id     BIGINT NOT NULL REFERENCES movies (id),
  starts_at    BIGINT NOT NULL,
  screen_label TEXT,
  UNIQUE (movie_id, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_showtimes_movie ON showtimes (movie_id, starts_at);

CREATE TABLE IF NOT EXISTS bookings (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference   TEXT   NOT NULL UNIQUE,      -- "CX-" + 8 chars, see services/reference.js
  user_id     BIGINT NOT NULL REFERENCES users (id),
  movie_id    BIGINT NOT NULL REFERENCES movies (id),
  showtime_id BIGINT NOT NULL REFERENCES showtimes (id),

  -- Recomputed on the server from the movies and snack_items tables at
  -- checkout time. A total sent by the browser is never trusted.
  total_centavos INTEGER NOT NULL CHECK (total_centavos > 0),

  status TEXT NOT NULL DEFAULT 'pending_payment'
              CHECK (status IN ('pending_payment', 'paid', 'expired', 'cancelled')),

  -- The snack counter queue on the staff dashboard. 'none' means this
  -- booking had no snacks, so it never appears in that queue.
  concession_status TEXT NOT NULL DEFAULT 'none'
                    CHECK (concession_status IN ('none', 'preparing', 'ready', 'sold')),

  paymongo_checkout_session_id TEXT,
  paymongo_payment_id          TEXT,

  hold_expires_at BIGINT,                  -- while pending_payment
  checked_in_at   BIGINT,                  -- the door scanner's "used" flag
  checked_in_by   BIGINT REFERENCES users (id),
  created_at      BIGINT NOT NULL,
  paid_at         BIGINT
);

CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_concession ON bookings (concession_status);
CREATE INDEX IF NOT EXISTS idx_bookings_expiry ON bookings (status, hold_expires_at);
CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings (paymongo_checkout_session_id);

-- Postgres never indexes a foreign key column on its own — only the side
-- being referenced gets one automatically, via its primary key. Without
-- these, a join or filter on any of the three columns below scans every
-- booking, and so does the row-lock Postgres takes on this table's matching
-- rows whenever a referenced movie, showtime, or user is updated or deleted.
CREATE INDEX IF NOT EXISTS idx_bookings_movie ON bookings (movie_id);
CREATE INDEX IF NOT EXISTS idx_bookings_showtime ON bookings (showtime_id);
CREATE INDEX IF NOT EXISTS idx_bookings_checked_in_by ON bookings (checked_in_by);

-- One row per physical seat per showtime. This is what makes availability
-- genuinely per-showtime: booking D5 for the 7pm screening leaves D5 free at
-- 10pm, which a hardcoded seat map could not express. bookings is created
-- above this table so the foreign key can point at it.
CREATE TABLE IF NOT EXISTS seats (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  showtime_id BIGINT NOT NULL REFERENCES showtimes (id),
  row_letter  TEXT   NOT NULL,
  seat_number INTEGER NOT NULL,
  status      TEXT   NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available', 'held', 'sold')),
  held_until  BIGINT,                      -- only set while status = 'held'
  booking_id  BIGINT REFERENCES bookings (id),
  UNIQUE (showtime_id, row_letter, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_seats_showtime ON seats (showtime_id);
CREATE INDEX IF NOT EXISTS idx_seats_booking ON seats (booking_id);

CREATE TABLE IF NOT EXISTS snack_items (
  id             BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category       TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  price_centavos INTEGER NOT NULL CHECK (price_centavos > 0),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  archived_at    BIGINT
);

CREATE TABLE IF NOT EXISTS booking_snacks (
  id             BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id     BIGINT  NOT NULL REFERENCES bookings (id),
  snack_item_id  BIGINT  NOT NULL REFERENCES snack_items (id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),

  -- Frozen at purchase time so raising a snack price later never rewrites
  -- what an old ticket says the customer paid.
  unit_price_centavos INTEGER NOT NULL CHECK (unit_price_centavos > 0)
);

CREATE INDEX IF NOT EXISTS idx_booking_snacks_booking ON booking_snacks (booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_snacks_snack_item ON booking_snacks (snack_item_id);

-- PayMongo retries a webhook it thinks failed, and will sometimes deliver an
-- event twice even when the first attempt succeeded. Recording every event id
-- we have already handled is what stops a retry from being processed twice.
-- The UNIQUE constraint is what actually enforces this — two requests racing
-- to insert the same event id can both try, but only one insert succeeds.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paymongo_event_id TEXT   NOT NULL UNIQUE,
  type              TEXT   NOT NULL,
  received_at       BIGINT NOT NULL,
  processed_at      BIGINT,
  payload           TEXT                   -- a raw snippet, kept for debugging only
);

-- Session storage for express-session, via connect-pg-simple. Adapted from
-- that package's own documented table shape
-- (https://github.com/voxpelli/node-connect-pg-simple) with two changes:
--
--   - No `COLLATE "default"` on sid — that name isn't a real collation on
--     every Postgres install, including some managed ones, and dropping it
--     changes nothing here: session ids are opaque random strings with no
--     locale-sensitive comparison to get right.
--   - `sess` is TEXT, not JSON. connect-pg-simple's own read path
--     (`typeof data.sess === 'string' ? JSON.parse(data.sess) : data.sess`)
--     already handles a plain string, so JSON added an implicit text->json
--     cast on every write with no behavior it was actually needed for.
--
-- Created here rather than left to runtime auto-create so the schema is
-- reproducible from one file like everything else, and so it survives being
-- pointed at a Supabase role that cannot CREATE TABLE at runtime.
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR   NOT NULL PRIMARY KEY,
  sess   TEXT      NOT NULL,
  -- Plain TIMESTAMP, not TIMESTAMP(6): Postgres already defaults to
  -- microsecond (6-digit) precision, so the explicit (6) was a no-op against
  -- real Postgres — dropping it also sidesteps a pg-mem quirk that otherwise
  -- rejects comparing this column against to_timestamp()'s result with a
  -- spurious "cannot cast type timestamp to timestamp".
  expire TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);

-- @pg-mem:skip-from-here — see test/pg-mem-setup.js. pg-mem does not
-- implement ENABLE ROW LEVEL SECURITY at all (a parse error that would roll
-- back this whole file, since it's sent as one multi-statement query); real
-- Postgres always supports it. The marker lets the test-only shim strip
-- everything below before handing this file to pg-mem, without schema.sql
-- itself knowing or caring that a test engine exists.
--
-- Row Level Security — locks every table below to its owner only.
--
-- This app never talks to Postgres through Supabase's PostgREST API (the
-- "Data API") — it holds a direct connection string and issues plain SQL, the
-- same as it would against any other Postgres host. But these tables still
-- live in the public schema of a Supabase project, and Supabase's own docs
-- are explicit that a table created via raw SQL is NOT protected the way a
-- Dashboard-created one is: "RLS *must* always be enabled on any tables
-- stored in an exposed schema... If you create one in raw SQL... remember to
-- enable RLS yourself." Left off, anyone holding this project's publishable
-- key could read password hashes, session rows, and PayMongo payment ids
-- straight out of the REST API, bypassing every check this app's own routes
-- perform.
--
-- Enabling RLS with zero policies denies every role by default — exactly
-- what's wanted, since no role except the table owner should touch these
-- tables at all. It does not affect this app: the owning role (whatever
-- DATABASE_URL connects as) bypasses RLS on tables it owns unless FORCE ROW
-- LEVEL SECURITY is also set, which is deliberately not done here. On a
-- non-Supabase Postgres this block is a harmless no-op — there's no anon or
-- authenticated role for it to matter to, but tables are still no worse off
-- with RLS on and no policies than with it off.
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE movies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE showtimes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE seats          ENABLE ROW LEVEL SECURITY;
ALTER TABLE snack_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_snacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE session        ENABLE ROW LEVEL SECURITY;
