"use strict";

/*
 * End-to-end tests against a real server and a real database.
 *
 * These cover the parts where being wrong costs money or lets someone in:
 * role separation, the seat race, single-use check-in, and webhook forgery.
 *
 * Two modes, chosen automatically:
 *
 *   - DATABASE_URL set (a real Postgres — Supabase or otherwise): tests run
 *     against it directly. This is the only mode that can actually prove the
 *     seat-hold race is safe, because that guarantee rests on real row-level
 *     locking (SELECT ... FOR UPDATE) blocking a second connection until the
 *     first commits — something only a real database does.
 *
 *   - DATABASE_URL unset: falls back to pg-mem, an in-memory Postgres-
 *     compatible engine, so `npm test` works with nothing configured. This
 *     verifies the schema applies, every query is valid Postgres SQL, and
 *     every non-concurrency-dependent behavior is correct. It CANNOT verify
 *     the seat race, because pg-mem does not implement lock blocking — a
 *     `SELECT ... FOR UPDATE` against an already-locked row returns
 *     immediately under pg-mem instead of waiting, which was confirmed by
 *     hand before writing this file. The seat-race test below detects which
 *     mode it's in and only makes the strict concurrency assertion against a
 *     real database; under pg-mem it logs why it's skipping that assertion
 *     rather than silently passing something it did not check.
 *
 * Run with: npm test
 * Run against real Postgres: DATABASE_URL=postgresql://... npm test
 */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

/*
 * Same placeholder heuristic src/config.js uses to decide DATABASE_URL isn't
 * really configured — duplicated rather than imported, because requiring
 * src/config here would eagerly read process.env.DATABASE_URL into a cached
 * value before this file gets a chance to patch 'pg' and repoint it at
 * pg-mem, and by then it's too late to change what src/db.js connects to.
 */
function isPlaceholder(value) {
  return (
    value === undefined ||
    value.trim() === "" ||
    value.includes("replace_me") ||
    value.includes("change-me") ||
    value.includes("your-project")
  );
}

const HAS_REAL_DATABASE = !isPlaceholder(process.env.DATABASE_URL);

if (!HAS_REAL_DATABASE) {
  console.log(
    "\n[test] No DATABASE_URL set — running against pg-mem (in-memory Postgres).\n" +
      "[test] This verifies schema and logic, but pg-mem cannot enforce real row\n" +
      "[test] locking, so the seat-hold race guarantee is not fully proven this way.\n" +
      "[test] Run again with a real DATABASE_URL before trusting that guarantee.\n"
  );

  const { installPgMem } = require("./pg-mem-setup");
  installPgMem();

  process.env.DATABASE_URL = "postgresql://pgmem/pgmem";
}

process.env.SESSION_SECRET = "test-secret-not-used-anywhere-real";
process.env.PAYMONGO_SECRET_KEY = "sk_test_fake_key_for_tests";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsk_test_webhook_secret";
process.env.NODE_ENV = "test";

const bcrypt = require("bcryptjs");

const { query, transaction, migrate, closePool } = require("../src/db");
const { createApp } = require("../src/app");
const { createShowtimesForMovie } = require("../src/services/scheduling");

let baseUrl;
let server;
let testMovieId;

// Distinguishes this run's fixtures from anything already in the database —
// real seed data when run against a real, already-seeded Supabase project
// (exactly what happened the first time this ran against one: a hardcoded
// "test-film" slug and "@test.local" emails happened to be unique that time,
// but nothing guaranteed it, and a leftover row from a prior run that crashed
// mid-test would have collided on a second run regardless). Doesn't touch
// Date.now() semantics anywhere the app itself cares about — this is only
// ever used to name test fixtures.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const testEmail = (name) => `${name}-${RUN_ID}@test.local`;

/** Signs in and returns something that can be passed back as a Cookie header. */
async function signIn(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  assert.equal(response.status, 200, `sign in failed for ${email}`);

  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function asUser(cookie, options = {}) {
  return {
    ...options,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(options.headers ?? {}) },
  };
}

test.before(async () => {
  await migrate();

  const now = Date.now();
  const hash = bcrypt.hashSync("password123", 4); // low cost: these are throwaway

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO users (name, email, phone, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["Staff Person", testEmail("staff"), null, hash, "staff", now]
    );
    await client.query(
      `INSERT INTO users (name, email, phone, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["Door Person", testEmail("scanner"), null, hash, "scanner", now]
    );
    await client.query(
      `INSERT INTO users (name, email, phone, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["Customer One", testEmail("one"), null, hash, "customer", now]
    );
    await client.query(
      `INSERT INTO users (name, email, phone, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["Customer Two", testEmail("two"), null, hash, "customer", now]
    );

    const movie = await client.query(
      `INSERT INTO movies (slug, title, genre, length_text, rating, price_centavos,
                           poster_url, status, status_note, created_at)
       VALUES ($1, 'Test Film', 'Drama', '1h 30m', 'PG', 25000,
               '/photo/The-Reckoning.jpg', 'now_showing', NULL, $2)
       RETURNING id`,
      [`test-film-${RUN_ID}`, now]
    );
    testMovieId = movie.rows[0].id;

    await createShowtimesForMovie(client, testMovieId, { days: 1 });
  });

  const app = createApp();

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));

  // Runnable more than once against a persistent real database (a shared
  // Supabase project, not just pg-mem, which is thrown away every time
  // anyway) — everything this run created is scoped to testMovieId or this
  // run's own emails, so a fresh run's RUN_ID never collides with what's left
  // behind here, but there's no reason to leave it behind regardless.
  await transaction(async (client) => {
    await client.query(
      "DELETE FROM seats WHERE showtime_id IN (SELECT id FROM showtimes WHERE movie_id = $1)",
      [testMovieId]
    );
    await client.query("DELETE FROM bookings WHERE movie_id = $1", [testMovieId]);
    await client.query("DELETE FROM showtimes WHERE movie_id = $1", [testMovieId]);
    await client.query("DELETE FROM movies WHERE id = $1", [testMovieId]);
    await client.query("DELETE FROM users WHERE email LIKE $1", [`%-${RUN_ID}@test.local`]);

    // The webhook test's own events. They never collide across runs (the
    // event id is a fresh UUID each time) so nothing breaks without this —
    // but left alone they pile up in whatever database the suite was pointed
    // at, which is a real production one often enough to be worth sweeping.
    await client.query("DELETE FROM webhook_events WHERE payload LIKE $1", ["%pay_test_123%"]);
  });

  await closePool();
});

/** A showtime id to book against, scoped to this run's own test movie —
 * never one from real catalogue data that happens to also be in the future,
 * which is exactly what an unscoped query picked when this suite first ran
 * against an already-seeded real Supabase database. */
async function futureShowtimeId() {
  const result = await query(
    "SELECT id FROM showtimes WHERE movie_id = $1 AND starts_at > $2 ORDER BY starts_at LIMIT 1",
    [testMovieId, Date.now()]
  );
  return result.rows[0].id;
}

test("signup rejects a password that does not match its confirmation", async () => {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Mismatch Person",
      email: testEmail("mismatch"),
      password: "password123",
      confirmPassword: "password124",
    }),
  });

  assert.equal(response.status, 400);

  const body = await response.json();
  assert.ok(body.fields.confirmPassword, "expected a confirmPassword field error");

  // The account must not exist despite the browser being able to skip its own check.
  const created = await query("SELECT 1 FROM users WHERE email = $1", [testEmail("mismatch")]);
  assert.equal(created.rows.length, 0);
});

test("signing in with the wrong password is refused", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail("one"), password: "wrong-password" }),
  });

  assert.equal(response.status, 401);
});

test("a scanner account cannot reach the dashboard, only the scanner", async () => {
  const cookie = await signIn(testEmail("scanner"), "password123");

  const summary = await fetch(`${baseUrl}/api/staff/summary`, asUser(cookie));
  assert.equal(summary.status, 403, "scanner must not read takings");

  const orders = await fetch(`${baseUrl}/api/staff/orders`, asUser(cookie));
  assert.equal(orders.status, 403, "scanner must not read the snack queue");

  const movies = await fetch(`${baseUrl}/api/staff/movies`, asUser(cookie));
  assert.equal(movies.status, 403, "scanner must not manage movies");

  // But the door lookup is allowed — 404 here means "no such ticket", not "denied".
  const scan = await fetch(`${baseUrl}/api/staff/scan/CX-AAAAAAAA`, asUser(cookie));
  assert.equal(scan.status, 404);

  // And the menu it is told to draw contains only the scanner.
  const me = await (await fetch(`${baseUrl}/api/auth/me`, asUser(cookie))).json();
  assert.deepEqual(
    me.user.menu.map((entry) => entry.label),
    ["Ticket Scanner"]
  );
});

test("ids come back as numbers, not strings, from the session and the API", async () => {
  // pg returns a BIGINT column as a string by default; src/db.js's
  // types.setTypeParser(20, Number) is what turns every id back into a plain
  // JS number. Get this wrong and req.user.id no longer === a Number()'d
  // value read from a booking row, which silently broke the checkout and
  // cancel-draft ownership checks until it was fixed — see the comment in
  // src/db.js. pg-mem returns numbers regardless of that setting, so this
  // assertion holds either way and does not by itself prove the setting
  // works — only a real database does that.
  const cookie = await signIn(testEmail("one"), "password123");
  const me = await (await fetch(`${baseUrl}/api/auth/me`, asUser(cookie))).json();

  assert.equal(typeof me.user.id, "number");
});

test("a staff account sees the whole back office", async () => {
  const cookie = await signIn(testEmail("staff"), "password123");

  assert.equal((await fetch(`${baseUrl}/api/staff/summary`, asUser(cookie))).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/staff/movies`, asUser(cookie))).status, 200);

  const me = await (await fetch(`${baseUrl}/api/auth/me`, asUser(cookie))).json();
  assert.deepEqual(
    me.user.menu.map((entry) => entry.label),
    ["Staff Dashboard", "Movies", "Ticket Scanner"]
  );
});

test("a signed-out visitor cannot open the staff pages or APIs", async () => {
  assert.equal((await fetch(`${baseUrl}/api/staff/summary`)).status, 401);

  const page = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
  assert.equal(page.status, 302);
  assert.match(page.headers.get("location"), /^\/signin\?next=/);
});

test("booking a seat holds it, and a second attempt at the same seat is refused", async () => {
  const showtimeId = await futureShowtimeId();
  const first = await signIn(testEmail("one"), "password123");
  const second = await signIn(testEmail("two"), "password123");

  const draft = await fetch(
    `${baseUrl}/api/bookings/draft`,
    asUser(first, { method: "POST", body: JSON.stringify({ showtimeId, seats: ["B5", "B6"] }) })
  );
  assert.equal(draft.status, 201);

  // The first booking has definitely committed by now, so this must be
  // refused under any database — real or pg-mem.
  const conflict = await fetch(
    `${baseUrl}/api/bookings/draft`,
    asUser(second, { method: "POST", body: JSON.stringify({ showtimeId, seats: ["B6", "B7"] }) })
  );

  assert.equal(conflict.status, 409, "the overlapping seat must be refused");

  const body = await conflict.json();
  assert.deepEqual(body.unavailableSeats, ["B6"]);

  // B7 was never taken, because the whole request was refused together.
  const seats = await (await fetch(`${baseUrl}/api/showtimes/${showtimeId}/seats`)).json();
  const b7 = seats.seats.find((seat) => seat.code === "B7");
  assert.equal(b7.taken, false);
});

test("two requests racing for the same seat cannot both win it", async () => {
  const showtimeId = await futureShowtimeId();
  const first = await signIn(testEmail("one"), "password123");
  const second = await signIn(testEmail("two"), "password123");

  const [a, b] = await Promise.all([
    fetch(
      `${baseUrl}/api/bookings/draft`,
      asUser(first, { method: "POST", body: JSON.stringify({ showtimeId, seats: ["C5"] }) })
    ),
    fetch(
      `${baseUrl}/api/bookings/draft`,
      asUser(second, { method: "POST", body: JSON.stringify({ showtimeId, seats: ["C5"] }) })
    ),
  ]);

  const statuses = [a.status, b.status].sort();

  if (!HAS_REAL_DATABASE) {
    // pg-mem does not block a second SELECT ... FOR UPDATE against a row a
    // still-open transaction already holds — confirmed directly before this
    // file was written. Both requests can therefore see the seat as
    // available and both can succeed here, which is expected under pg-mem
    // and is not evidence of an application bug. Real Postgres blocks the
    // second connection at that SELECT until the first transaction commits,
    // which is what the assertion below checks for when it's available.
    console.log(
      `[test] seat-race under pg-mem: statuses were [${statuses.join(", ")}] — ` +
        "not asserted strictly; rerun with a real DATABASE_URL to check this for real."
    );
    return;
  }

  assert.deepEqual(statuses, [201, 409], "exactly one of the two requests should have won the seat");

  const seats = await (await fetch(`${baseUrl}/api/showtimes/${showtimeId}/seats`)).json();
  const c5 = seats.seats.find((seat) => seat.code === "C5");
  assert.equal(c5.taken, true, "the seat that was won must show as taken");
});

test("the browser cannot dictate the price", async () => {
  const showtimeId = await futureShowtimeId();
  const cookie = await signIn(testEmail("one"), "password123");

  const response = await fetch(
    `${baseUrl}/api/bookings/draft`,
    asUser(cookie, {
      method: "POST",
      body: JSON.stringify({
        showtimeId,
        seats: ["A1", "A2"],
        totalCentavos: 1, // ignored: the server prices the booking itself
      }),
    })
  );

  assert.equal(response.status, 201);

  const { booking } = await response.json();
  assert.equal(booking.totalCentavos, 50000, "two ₱250 seats must cost ₱500");
});

test("a webhook without a valid signature is rejected", async () => {
  const body = JSON.stringify({ data: { id: "evt_fake", attributes: { type: "checkout_session.payment.paid" } } });

  const unsigned = await fetch(`${baseUrl}/webhooks/paymongo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.equal(unsigned.status, 401, "an unsigned webhook must not be trusted");

  const wrongly = await fetch(`${baseUrl}/webhooks/paymongo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Paymongo-Signature": "t=1,te=deadbeef,li=" },
    body,
  });
  assert.equal(wrongly.status, 401, "a wrong signature must not be trusted");
});

test("a correctly signed webhook marks the booking paid, and a repeat is ignored", async () => {
  const showtimeId = await futureShowtimeId();
  const cookie = await signIn(testEmail("two"), "password123");

  const draft = await (
    await fetch(
      `${baseUrl}/api/bookings/draft`,
      asUser(cookie, { method: "POST", body: JSON.stringify({ showtimeId, seats: ["G9", "G10"] }) })
    )
  ).json();

  const reference = draft.booking.reference;

  const event = {
    data: {
      id: "evt_" + crypto.randomUUID(),
      attributes: {
        type: "checkout_session.payment.paid",
        data: {
          attributes: {
            reference_number: reference,
            payments: [{ id: "pay_test_123", attributes: { status: "paid" } }],
          },
        },
      },
    },
  };

  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const send = () =>
    fetch(`${baseUrl}/webhooks/paymongo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Paymongo-Signature": `t=${timestamp},te=${signature},li=`,
      },
      body,
    });

  const first = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, undefined);

  const paidResult = await query(
    "SELECT status, paymongo_payment_id FROM bookings WHERE reference = $1",
    [reference]
  );
  const paid = paidResult.rows[0];
  assert.equal(paid.status, "paid");
  assert.equal(paid.paymongo_payment_id, "pay_test_123");

  const seatsResult = await query(
    "SELECT status FROM seats WHERE booking_id = (SELECT id FROM bookings WHERE reference = $1)",
    [reference]
  );
  assert.ok(seatsResult.rows.every((seat) => seat.status === "sold"), "paid seats must become sold");

  // PayMongo redelivers events. The second one must change nothing.
  const second = await send();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);

  const eventsResult = await query(
    "SELECT COUNT(*)::int AS n FROM webhook_events WHERE paymongo_event_id = $1",
    [event.data.id]
  );
  assert.equal(eventsResult.rows[0].n, 1);
});

test("a ticket can only be checked in once, whichever scanner gets there first", async () => {
  // Scoped to this run's own movie — an unscoped "any paid booking" query
  // can pick up a leftover row from an earlier run against a real, shared
  // database (exactly what happened here the first time: a prior run's
  // already-checked-in booking got selected instead of this run's own).
  const referenceResult = await query(
    "SELECT reference FROM bookings WHERE status = 'paid' AND movie_id = $1 ORDER BY id DESC LIMIT 1",
    [testMovieId]
  );
  const reference = referenceResult.rows[0].reference;

  const scanner = await signIn(testEmail("scanner"), "password123");
  const staff = await signIn(testEmail("staff"), "password123");

  const lookup = await (await fetch(`${baseUrl}/api/staff/scan/CINEMAX:${reference}`, asUser(scanner))).json();
  assert.equal(lookup.result, "valid", "the CINEMAX: prefix must be accepted");

  const first = await (
    await fetch(`${baseUrl}/api/staff/scan/${reference}/check-in`, asUser(scanner, { method: "POST" }))
  ).json();
  assert.equal(first.result, "checked-in");

  // A different device, a different account, the same ticket.
  const second = await (
    await fetch(`${baseUrl}/api/staff/scan/${reference}/check-in`, asUser(staff, { method: "POST" }))
  ).json();
  assert.equal(second.result, "already-used");

  const after = await (await fetch(`${baseUrl}/api/staff/scan/${reference}`, asUser(scanner))).json();
  assert.equal(after.result, "already-used");
});

test("an expired hold releases its seats", async () => {
  const showtimeId = await futureShowtimeId();
  const cookie = await signIn(testEmail("one"), "password123");

  const draft = await (
    await fetch(
      `${baseUrl}/api/bookings/draft`,
      asUser(cookie, { method: "POST", body: JSON.stringify({ showtimeId, seats: ["F1"] }) })
    )
  ).json();

  // Push the hold into the past rather than waiting ten minutes for it.
  await query("UPDATE bookings SET hold_expires_at = $1 WHERE reference = $2", [
    Date.now() - 1000,
    draft.booking.reference,
  ]);

  const seats = await (await fetch(`${baseUrl}/api/showtimes/${showtimeId}/seats`)).json();
  const f1 = seats.seats.find((seat) => seat.code === "F1");

  assert.equal(f1.taken, false, "a lapsed hold must free the seat");

  const bookingResult = await query("SELECT status FROM bookings WHERE reference = $1", [
    draft.booking.reference,
  ]);
  assert.equal(bookingResult.rows[0].status, "expired");
});
