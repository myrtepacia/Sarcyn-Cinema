CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT   NOT NULL,
  email         TEXT   NOT NULL UNIQUE, 
  phone         TEXT,
  password_hash TEXT   NOT NULL,
  role          TEXT   NOT NULL DEFAULT 'customer'
                       CHECK (role IN ('customer', 'staff', 'scanner')),
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS movies (
  id             BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug           TEXT    NOT NULL UNIQUE,  
  title          TEXT    NOT NULL,
  genre          TEXT    NOT NULL,
  length_text    TEXT    NOT NULL,     
  rating         TEXT    NOT NULL
                         CHECK (rating IN ('G', 'PG', 'PG-13', 'R-13', 'R-16', 'R-18')),
  price_centavos INTEGER NOT NULL CHECK (price_centavos > 0),
  poster_url     TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('now_showing', 'upcoming')),
  status_note    TEXT,                   
  archived_at    BIGINT,                  
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
  reference   TEXT   NOT NULL UNIQUE,     
  user_id     BIGINT NOT NULL REFERENCES users (id),
  movie_id    BIGINT NOT NULL REFERENCES movies (id),
  showtime_id BIGINT NOT NULL REFERENCES showtimes (id),

  total_centavos INTEGER NOT NULL CHECK (total_centavos > 0),

  status TEXT NOT NULL DEFAULT 'pending_payment'
              CHECK (status IN ('pending_payment', 'paid', 'expired', 'cancelled')),

  concession_status TEXT NOT NULL DEFAULT 'none'
                    CHECK (concession_status IN ('none', 'preparing', 'ready', 'sold')),

  paymongo_checkout_session_id TEXT,
  paymongo_payment_id          TEXT,
  hold_expires_at BIGINT,
  checked_in_at   BIGINT,
  checked_in_by   BIGINT REFERENCES users (id),
  created_at      BIGINT NOT NULL,
  paid_at         BIGINT
);

CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_concession ON bookings (concession_status);
CREATE INDEX IF NOT EXISTS idx_bookings_expiry ON bookings (status, hold_expires_at);
CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings (paymongo_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_bookings_movie ON bookings (movie_id);
CREATE INDEX IF NOT EXISTS idx_bookings_showtime ON bookings (showtime_id);
CREATE INDEX IF NOT EXISTS idx_bookings_checked_in_by ON bookings (checked_in_by);
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

  unit_price_centavos INTEGER NOT NULL CHECK (unit_price_centavos > 0)
);

CREATE INDEX IF NOT EXISTS idx_booking_snacks_booking ON booking_snacks (booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_snacks_snack_item ON booking_snacks (snack_item_id);
CREATE TABLE IF NOT EXISTS webhook_events (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paymongo_event_id TEXT   NOT NULL UNIQUE,
  type              TEXT   NOT NULL,
  received_at       BIGINT NOT NULL,
  processed_at      BIGINT,
  payload           TEXT
);

CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR   NOT NULL PRIMARY KEY,
  sess   TEXT      NOT NULL,
  expire TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE movies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE showtimes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE seats          ENABLE ROW LEVEL SECURITY;
ALTER TABLE snack_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_snacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE session        ENABLE ROW LEVEL SECURITY;
