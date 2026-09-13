"use strict";

const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/**
 * Reads a setting, falling back to a default. Blank counts as missing so a
 * half-filled .env behaves the same as an absent one.
 */
function read(name, fallback) {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return value.trim();
}

function readInt(name, fallback) {
  const raw = read(name, null);

  if (raw === null) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }

  return parsed;
}

// Vercel sets NODE_ENV=production for BOTH its production and preview
// deployments (they're built the same way), so it can't tell them apart on
// its own — a preview branch legitimately using PayMongo test keys would
// otherwise trip the "live site, test key" warning below. Vercel's own
// VERCEL_ENV ("production" | "preview" | "development") is the accurate
// signal when it's present; NODE_ENV is the fallback for every other host.
const isProduction = read("VERCEL_ENV", read("NODE_ENV", "development")) === "production";

// Vercel sets this on every function invocation. Used to turn off things that
// only make sense on a long-running process, such as the setInterval hold
// sweeper — a serverless instance is not guaranteed to stay alive between
// requests, so a timer started in one invocation may never fire again.
const isServerless = read("VERCEL", null) !== null;

// Placeholder values ship in .env.example. Treat them as "not configured"
// rather than letting them reach PayMongo or Postgres and fail with a
// confusing low-level error.
function isPlaceholder(value) {
  return (
    value === null ||
    value.includes("replace_me") ||
    value.includes("change-me") ||
    value.includes("your-project")
  );
}

/**
 * Where this site is reachable from — used to build the success, cancel and
 * webhook URLs handed to PayMongo.
 *
 * Getting this wrong is not a quiet failure: PayMongo sends the customer to
 * whatever it was told, so a deployed site that fell back to the development
 * default sent people who had just paid to http://localhost:3000, on their
 * own machine, where nothing is running. That is exactly what happened before
 * this fallback chain existed and APP_BASE_URL simply hadn't been set on
 * Vercel.
 *
 * APP_BASE_URL still wins when set, because it is the only one that can point
 * at a custom domain. Failing that, Vercel itself supplies the answer:
 * VERCEL_PROJECT_PRODUCTION_URL is the stable production hostname, and
 * VERCEL_URL is this specific deployment's own hostname — a preview build's
 * URL changes every deploy, which is why it comes last, but it is still
 * infinitely better than localhost. Both arrive without a scheme.
 */
function resolveBaseUrl() {
  const explicit = read("APP_BASE_URL", null);

  if (explicit !== null) {
    return explicit;
  }

  const vercelHost = read("VERCEL_PROJECT_PRODUCTION_URL", read("VERCEL_URL", null));

  if (vercelHost !== null) {
    return `https://${vercelHost}`;
  }

  return "http://localhost:3000";
}

const databaseUrl = read("DATABASE_URL", null);
const paymongoSecretKey = read("PAYMONGO_SECRET_KEY", null);
const paymongoPublicKey = read("PAYMONGO_PUBLIC_KEY", null);
const paymongoWebhookSecret = read("PAYMONGO_WEBHOOK_SECRET", null);
const sessionSecret = read("SESSION_SECRET", null);
const supabaseUrl = read("SUPABASE_URL", null);
const supabaseServiceRoleKey = read("SUPABASE_SERVICE_ROLE_KEY", null);
const cronSecret = read("CRON_SECRET", null);

const config = {
  isProduction,
  isServerless,
  port: readInt("PORT", 3000),
  baseUrl: resolveBaseUrl().replace(/\/+$/, ""),
  root: ROOT,

  databaseUrl: isPlaceholder(databaseUrl) ? null : databaseUrl,

  sessionSecret: isPlaceholder(sessionSecret)
    ? "cinemax-development-only-secret"
    : sessionSecret,

  seatHoldMs: readInt("SEAT_HOLD_MINUTES", 10) * 60 * 1000,

  // A shared secret Vercel Cron sends as a header when it calls the sweep
  // endpoint, so that address cannot be used by anyone who finds the URL to
  // force a sweep or probe whether the endpoint exists.
  cronSecret: isPlaceholder(cronSecret) ? null : cronSecret,

  supabase: {
    url: isPlaceholder(supabaseUrl) ? null : supabaseUrl,
    serviceRoleKey: isPlaceholder(supabaseServiceRoleKey) ? null : supabaseServiceRoleKey,
    posterBucket: read("SUPABASE_POSTER_BUCKET", "posters"),
  },

  paymongo: {
    secretKey: isPlaceholder(paymongoSecretKey) ? null : paymongoSecretKey,
    publicKey: isPlaceholder(paymongoPublicKey) ? null : paymongoPublicKey,
    webhookSecret: isPlaceholder(paymongoWebhookSecret) ? null : paymongoWebhookSecret,

    // Which methods the hosted checkout page offers. PayMongo only settles
    // in PHP, so there is no currency setting to make configurable.
    paymentMethods: ["card", "gcash", "paymaya", "grab_pay", "qrph"],
  },
};

/**
 * Anything that would let the site run but behave wrongly or unsafely.
 * Refuse to start in production; warn loudly in development so the site is
 * still usable up to the point where a real value is genuinely needed.
 */
function checkConfig() {
  const problems = [];

  if (config.databaseUrl === null) {
    problems.push(
      "DATABASE_URL is not set. Get it from Supabase: Project Settings > Database > " +
        "Connection string > Transaction pooler, and use that pooled URL, not the direct one."
    );
  }

  if (isPlaceholder(sessionSecret)) {
    problems.push(
      "SESSION_SECRET is not set. Session cookies are signed with a known " +
        'development value, so anyone could forge one. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (config.paymongo.secretKey === null) {
    problems.push("PAYMONGO_SECRET_KEY is not set. Checkout will refuse to start a payment.");
  } else if (isProduction && config.paymongo.secretKey.startsWith("sk_test_")) {
    problems.push("PAYMONGO_SECRET_KEY is a test key but NODE_ENV is production. Real payments would not be taken.");
  }

  if (config.paymongo.webhookSecret === null) {
    problems.push("PAYMONGO_WEBHOOK_SECRET is not set. Incoming webhooks cannot be verified and will be rejected.");
  }

  if (isProduction && !config.baseUrl.startsWith("https://")) {
    problems.push(
      `APP_BASE_URL is "${config.baseUrl}". PayMongo only delivers webhooks to https, ` +
        "and the scanner's camera only works on https or localhost."
    );
  }

  if (isProduction && config.supabase.url === null) {
    problems.push("SUPABASE_URL is not set. Poster uploads will fail.");
  }

  if (isProduction && config.supabase.serviceRoleKey === null) {
    problems.push("SUPABASE_SERVICE_ROLE_KEY is not set. Poster uploads will fail.");
  }

  if (isServerless && config.cronSecret === null) {
    problems.push(
      "CRON_SECRET is not set. The seat-hold sweep endpoint has no way to tell a real " +
        "Vercel Cron call apart from anyone who finds its address."
    );
  }

  return problems;
}

module.exports = { config, checkConfig };
