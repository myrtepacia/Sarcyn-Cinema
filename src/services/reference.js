"use strict";

const crypto = require("node:crypto");

const { query } = require("../db");

// No 0, O, 1 or I. Staff read these codes off a phone screen and type them
// into the scanner by hand when a camera will not focus, and those four are
// the characters people get wrong.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const PREFIX = "CX-";

/** The shape the QR code carries and the scanner expects to read back. */
const QR_PREFIX = "CINEMAX:";

function randomCode() {
  let code = "";

  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }

  return PREFIX + code;
}

/**
 * A booking reference that is not already taken.
 *
 * Call this with the transaction client that will insert the booking, so the
 * uniqueness check and the insert cannot be separated by another writer. The
 * UNIQUE constraint on bookings.reference is the real guarantee; this loop
 * just avoids hitting it in practice.
 */
async function generateReference(client = { query }) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const reference = randomCode();
    const existing = await client.query("SELECT 1 FROM bookings WHERE reference = $1", [reference]);

    if (existing.rows.length === 0) {
      return reference;
    }
  }

  throw new Error("Could not find an unused booking reference after 10 tries");
}

/** "CX-8F3K92LM" -> "CINEMAX:CX-8F3K92LM", which is what the QR encodes. */
function toQrPayload(reference) {
  return QR_PREFIX + reference;
}

/**
 * Accepts what a scanner decoded and returns a bare reference.
 * Tolerates the CINEMAX: prefix, lower case, and stray whitespace, because
 * all three turn up in practice.
 */
function normalizeScannedCode(text) {
  let code = String(text ?? "").trim().toUpperCase();

  if (code.startsWith(QR_PREFIX)) {
    code = code.slice(QR_PREFIX.length);
  }

  return code.trim();
}

/** Whether a string could be one of our references at all. */
function looksLikeReference(code) {
  return new RegExp(`^CX-[${ALPHABET}]{${CODE_LENGTH}}$`).test(code);
}

module.exports = {
  generateReference,
  toQrPayload,
  normalizeScannedCode,
  looksLikeReference,
  QR_PREFIX,
};
