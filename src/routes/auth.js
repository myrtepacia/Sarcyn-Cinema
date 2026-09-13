"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");

const { query } = require("../db");
const { menuFor, requireAuth } = require("../middleware/guards");

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;

// Deliberately permissive: the real test of an address is whether mail to it
// arrives, and over-strict patterns reject valid addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Philippine mobile numbers, written any of the usual ways. */
function normalizePhone(raw) {
  const digits = String(raw).replace(/[\s()-]/g, "");

  if (!/^(\+?63|0)9\d{9}$/.test(digits)) {
    return null;
  }

  return digits.startsWith("0") ? "+63" + digits.slice(1) : digits.replace(/^63/, "+63");
}

/** What the browser is told about the signed-in user. Never includes the hash. */
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
    menu: menuFor(user.role),
  };
}

/**
 * Signs the user in by writing their id to the session.
 *
 * The session id is regenerated first so a session fixed by an attacker
 * before sign-in cannot be reused afterwards.
 */
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        return reject(error);
      }

      req.session.userId = user.id;
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

router.post("/signup", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const confirmPassword = String(body.confirmPassword ?? "");
    const rawPhone = String(body.phone ?? "").trim();

    const fields = {};

    if (name.length < 2) {
      fields.name = "Please enter your full name.";
    }

    if (!EMAIL_PATTERN.test(email)) {
      fields.email = "Please enter a valid email address.";
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      fields.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }

    // Checked here as well as in the browser, because the browser's copy can
    // simply be skipped by posting to this endpoint directly.
    if (password !== confirmPassword) {
      fields.confirmPassword = "The two passwords do not match.";
    }

    let phone = null;

    if (rawPhone !== "") {
      phone = normalizePhone(rawPhone);

      if (phone === null) {
        fields.phone = "Enter a Philippine mobile number, such as 0917 123 4567.";
      }
    }

    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ error: "Please check the form.", fields });
    }

    const taken = await query("SELECT 1 FROM users WHERE email = $1", [email]);

    if (taken.rows.length > 0) {
      return res.status(409).json({
        error: "That email already has an account.",
        fields: { email: "That email already has an account. Try signing in instead." },
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const inserted = await query(
      `INSERT INTO users (name, email, phone, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, 'customer', $5)
       RETURNING id, name, email, phone, role`,
      [name, email, phone, passwordHash, Date.now()]
    );

    const user = inserted.rows[0];

    await startSession(req, user);

    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");

    if (email === "" || password === "") {
      return res.status(400).json({ error: "Enter your email and password." });
    }

    const result = await query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];

    // Hash even when the account does not exist, so the response takes about
    // the same time either way and cannot be used to discover which emails
    // are registered.
    const hash = user?.password_hash ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";
    const matches = await bcrypt.compare(password, hash);

    if (user === undefined || !matches) {
      return res.status(401).json({ error: "That email and password do not match an account." });
    }

    await startSession(req, user);

    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (req, res, next) => {
  if (req.session === undefined) {
    return res.status(204).end();
  }

  req.session.destroy((error) => {
    if (error) {
      return next(error);
    }

    res.clearCookie("cinemax.sid");
    res.status(204).end();
  });
});

/** Who am I? Used by every page to render the header and the staff menu. */
router.get("/me", (req, res) => {
  res.json({ user: req.user === null ? null : publicUser(req.user) });
});

router.get("/account", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT b.reference, b.status, b.total_centavos, b.created_at,
              m.title, m.poster_url, m.slug, s.starts_at
         FROM bookings b
         JOIN movies m ON m.id = b.movie_id
         JOIN showtimes s ON s.id = b.showtime_id
        WHERE b.user_id = $1 AND b.status = 'paid'
        ORDER BY b.created_at DESC`,
      [req.user.id]
    );

    const bookings = result.rows.map((row) => ({
      reference: row.reference,
      status: row.status,
      total_centavos: row.total_centavos,
      created_at: Number(row.created_at),
      title: row.title,
      poster_url: row.poster_url,
      slug: row.slug,
      starts_at: Number(row.starts_at),
    }));

    res.json({ user: publicUser(req.user), bookings });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
