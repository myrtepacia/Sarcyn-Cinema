"use strict";

const crypto = require("node:crypto");

const { config } = require("../config");

let client = null;

/**
 * Lazily creates the Supabase client. Lazy on purpose: a site with no
 * Supabase keys configured yet should still start and serve every page that
 * isn't a poster upload, and throw only when the upload is actually attempted.
 *
 * The require is inside the function for the same reason it is cheap to be
 * strict about here: @supabase/supabase-js is 8.5MB on disk and nearly a
 * megabyte of JavaScript to parse, and the only thing in this whole app that
 * needs it is the poster upload below. Required at the top of the file it was
 * parsed on every cold start — on every request to the home page, the seat
 * map, the scanner — to serve a route almost nobody calls.
 */
function getClient() {
  if (client !== null) {
    return client;
  }

  const { createClient } = require("@supabase/supabase-js");

  if (config.supabase.url === null || config.supabase.serviceRoleKey === null) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to upload a poster."
    );
  }

  // The service role key bypasses row-level security, which is correct here:
  // this client only ever runs on the server, from a staff-only route already
  // gated by requireCapability("movies"), and it only ever writes to the one
  // poster bucket below.
  client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });

  return client;
}

const EXTENSION_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Uploads a poster image and returns the public URL to store on the movie.
 *
 * Local disk was the previous approach; it does not survive a Vercel
 * deployment, whose filesystem is read-only outside /tmp and is not shared
 * between function instances, let alone between deploys. Supabase Storage
 * gives a URL that keeps working across all of that.
 */
async function uploadPoster(movieId, buffer, contentType) {
  const extension = EXTENSION_BY_TYPE[contentType];

  if (extension === undefined) {
    throw new Error("Posters must be a JPEG, PNG or WebP image.");
  }

  const filename = `poster-${movieId}-${crypto.randomBytes(6).toString("hex")}.${extension}`;

  const { error } = await getClient()
    .storage.from(config.supabase.posterBucket)
    .upload(filename, buffer, {
      contentType,
      upsert: false,
      // A year, rather than Supabase Storage's one-hour default. These bytes
      // are immutable: the filename above carries six random bytes and the
      // upload refuses to overwrite, so changing a movie's poster always
      // writes a new file at a new URL and updates poster_url to match. There
      // is no version of this URL a browser could be holding that is wrong.
      // Anyone switching this to upsert: true, or to a filename derived from
      // the movie id alone, has to shorten this at the same time.
      cacheControl: "31536000",
    });

  if (error) {
    throw new Error(`Could not upload the poster: ${error.message}`);
  }

  const { data } = getClient().storage.from(config.supabase.posterBucket).getPublicUrl(filename);

  return data.publicUrl;
}

module.exports = { uploadPoster, EXTENSION_BY_TYPE };
