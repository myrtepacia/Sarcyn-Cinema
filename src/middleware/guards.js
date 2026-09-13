"use strict";

const { query } = require("../db");

/**
 * What each role is allowed to open.
 *
 *   staff   - the whole back office
 *   scanner - the door scanner and nothing else. Whoever checks tickets at
 *             the door signs in as one of these, so they never see takings,
 *             snack orders, or the movie list.
 *   customer- the public site only
 *
 * These three functions are the single source of truth: the page guards, the
 * API guards and the admin menu the browser renders all read from them, so a
 * link can never appear for a page the server would refuse.
 */
const CAPABILITIES = {
  dashboard: (role) => role === "staff",
  movies: (role) => role === "staff",
  scanner: (role) => role === "staff" || role === "scanner",
};

function can(role, capability) {
  const check = CAPABILITIES[capability];

  if (check === undefined) {
    throw new Error(`Unknown capability "${capability}"`);
  }

  return check(role);
}

/** The back-office links this role should see, in menu order. */
function menuFor(role) {
  const menu = [];

  if (can(role, "dashboard")) {
    menu.push({ label: "Staff Dashboard", href: "/admin" });
  }

  if (can(role, "movies")) {
    menu.push({ label: "Movies", href: "/admin-movies" });
  }

  if (can(role, "scanner")) {
    menu.push({ label: "Ticket Scanner", href: "/admin-scanner" });
  }

  return menu;
}

/** Loads the signed-in user onto req.user, or leaves it null. */
async function attachUser(req, res, next) {
  req.user = null;

  const userId = req.session?.userId;

  if (userId !== undefined) {
    try {
      const result = await query(
        "SELECT id, name, email, phone, role FROM users WHERE id = $1",
        [userId]
      );
      const user = result.rows[0];

      if (user === undefined) {
        // The account was removed while its session was still alive.
        req.session.destroy(() => {});
      } else {
        req.user = user;
      }
    } catch (error) {
      return next(error);
    }
  }

  next();
}

/** JSON guard: the caller must be signed in. */
function requireAuth(req, res, next) {
  if (req.user === null) {
    return res.status(401).json({ error: "Please sign in to continue." });
  }

  next();
}

/** JSON guard: the caller must be signed in and hold the capability. */
function requireCapability(capability) {
  return function guard(req, res, next) {
    if (req.user === null) {
      return res.status(401).json({ error: "Please sign in to continue." });
    }

    if (!can(req.user.role, capability)) {
      return res.status(403).json({ error: "Your account does not have access to this." });
    }

    next();
  };
}

/**
 * Page guard: same rule, but sends a browser somewhere useful instead of
 * returning JSON it would just display as text.
 *
 * A signed-in user who lacks the capability is sent to the first page they
 * can open rather than to a dead end — so a scanner account that types the
 * dashboard address lands on the scanner.
 */
function requirePageCapability(capability) {
  return function guard(req, res, next) {
    if (req.user === null) {
      const next = encodeURIComponent(req.originalUrl);
      return res.redirect(`/signin?next=${next}`);
    }

    if (!can(req.user.role, capability)) {
      const menu = menuFor(req.user.role);
      return res.redirect(menu.length > 0 ? menu[0].href : "/");
    }

    next();
  };
}

module.exports = {
  can,
  menuFor,
  attachUser,
  requireAuth,
  requireCapability,
  requirePageCapability,
};
