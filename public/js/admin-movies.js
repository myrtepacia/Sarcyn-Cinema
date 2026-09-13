/*
 * Movie management.
 *
 * The table and the four counts are both drawn from the same response, so a
 * count can never disagree with the rows underneath it.
 */

var pageMessage = document.getElementById("page-message");
var addMessage = document.getElementById("add-message");
var moviesLoading = document.getElementById("movies-loading");
var movieTable = document.getElementById("movie-table");
var movieRows = document.getElementById("movie-rows");
var addForm = document.getElementById("add-form");
var addButton = document.getElementById("add-button");

// The same size the seeded posters were cut to. A poster is drawn about 400
// CSS pixels wide at its largest (the booking page), so this is already
// generous on a 2x screen.
var POSTER_MAX_W = 900;
var POSTER_MAX_H = 1200;

/**
 * Shrinks a chosen poster before it is uploaded.
 *
 * Staff pick whatever file they have, and a press-kit poster is routinely
 * 20 megapixels and several megabytes. Sent up as-is it is stored as-is and
 * then served to every visitor on the home page, where the cost is not really
 * the download but the decode: a phone unpacking a 20MP image into memory to
 * draw it 200 pixels wide. The six seeded posters were 21.7MB between them
 * for exactly this reason.
 *
 * Doing it here rather than on the server also keeps the upload small on
 * whatever connection the counter happens to have.
 *
 * Falls back to the original file on any failure — a poster that uploads at
 * full size is a slow page, but a poster that does not upload is a broken one.
 */
async function shrinkPoster(file) {
  try {
    // from-image so a photo carrying EXIF rotation is not stored sideways.
    var bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

    // Only ever shrink. Math.min with 1 is what stops a small poster being
    // blown up to 900x1200 and re-encoded — which would be blurrier than the
    // original and usually larger too.
    var scale = Math.min(POSTER_MAX_W / bitmap.width, POSTER_MAX_H / bitmap.height, 1);

    if (scale === 1) {
      bitmap.close();
      return file;
    }

    var canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    var blob = await new Promise(function (resolve) {
      // toBlob hands back null if it cannot encode, so the caller below has to
      // check rather than assume.
      canvas.toBlob(resolve, "image/jpeg", 0.82);
    });

    if (blob === null || blob.size >= file.size) {
      return file;
    }

    return blob;
  } catch (error) {
    return file;
  }
}

var FIELD_INPUTS = {
  title: "new-title",
  genre: "new-genre",
  lengthText: "new-length",
  rating: "new-rating",
  pricePesos: "new-price",
  status: "new-status",
};

function movieRow(movie) {
  var row = document.createElement("tr");

  var titleCell = document.createElement("td");
  var wrap = document.createElement("span");
  wrap.className = "cell-with-poster";

  var poster = document.createElement("img");
  poster.className = "table-poster";
  poster.src = movie.posterUrl;
  poster.alt = movie.title + " poster";
  // A thumbnail this small, in a table that can run well past one screen.
  poster.width = 40;
  poster.height = 54;
  poster.loading = "lazy";
  poster.decoding = "async";

  var text = document.createElement("span");

  var name = document.createElement("span");
  name.className = "movie-name";
  name.textContent = movie.title;

  var sub = document.createElement("span");
  sub.className = "movie-sub";
  sub.textContent = movie.genre + ", " + movie.lengthText + ", " + movie.rating;

  text.appendChild(name);
  text.appendChild(sub);
  wrap.appendChild(poster);
  wrap.appendChild(text);
  titleCell.appendChild(wrap);

  var statusCell = document.createElement("td");
  statusCell.className = "hide-small";
  var pill = document.createElement("span");
  pill.className = movie.status === "now_showing" ? "label-showing" : "label-soon";
  pill.textContent = movie.status === "now_showing" ? "Now Showing" : "Upcoming";
  statusCell.appendChild(pill);

  var priceCell = document.createElement("td");
  priceCell.className = "right hide-small";
  priceCell.textContent = peso(movie.priceCentavos);

  var soldCell = document.createElement("td");
  soldCell.className = "right";
  soldCell.textContent = String(movie.ticketsSold);

  var actionCell = document.createElement("td");
  actionCell.className = "right";

  var remove = document.createElement("button");
  remove.className = "remove-button";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.onclick = function () {
    removeMovie(movie, remove);
  };

  actionCell.appendChild(remove);

  row.appendChild(titleCell);
  row.appendChild(statusCell);
  row.appendChild(priceCell);
  row.appendChild(soldCell);
  row.appendChild(actionCell);

  return row;
}

async function removeMovie(movie, button) {
  var warning = movie.ticketsSold > 0
    ? 'Take "' + movie.title + '" off the listings? It has ' + movie.ticketsSold +
      " ticket(s) sold — those bookings are kept and stay valid."
    : 'Take "' + movie.title + '" off the listings?';

  if (!window.confirm(warning)) {
    return;
  }

  setBusy(button, true, "Removing…");

  try {
    await api("/api/staff/movies/" + movie.id, { method: "DELETE" });
    showMessage(pageMessage, '"' + movie.title + '" is no longer listed.', "success");
    await loadMovies();
  } catch (error) {
    setBusy(button, false);
    showMessage(pageMessage, "That movie could not be removed: " + error.message, "error");
  }
}

async function loadMovies() {
  try {
    var result = await api("/api/staff/movies");

    moviesLoading.classList.add("hidden");
    movieTable.classList.remove("hidden");

    movieRows.innerHTML = "";
    result.movies.forEach(function (movie) {
      movieRows.appendChild(movieRow(movie));
    });

    document.getElementById("count-total").textContent = String(result.counts.total);
    document.getElementById("count-showing").textContent = String(result.counts.nowShowing);
    document.getElementById("count-upcoming").textContent = String(result.counts.upcoming);
    document.getElementById("count-tickets").textContent = String(result.counts.ticketsSold);
    document.getElementById("count-showing-note").textContent =
      result.counts.nowShowing + " showing now";
  } catch (error) {
    moviesLoading.classList.add("hidden");
    showMessage(pageMessage, "The movie list could not be loaded: " + error.message, "error");
  }
}

function clearFieldErrors() {
  document.querySelectorAll(".field-error").forEach(function (note) {
    note.remove();
  });
  document.querySelectorAll(".invalid").forEach(function (input) {
    input.classList.remove("invalid");
  });
}

function showFieldError(field, text) {
  var input = document.getElementById(FIELD_INPUTS[field]);

  if (!input) {
    return false;
  }

  input.classList.add("invalid");

  var note = document.createElement("span");
  note.className = "field-error";
  note.textContent = text;
  input.parentNode.appendChild(note);

  return true;
}

addForm.onsubmit = async function (event) {
  // The old form was a GET that reloaded the page with the values in the
  // address bar and saved nothing. This one posts and stays put.
  event.preventDefault();

  clearFieldErrors();
  showMessage(addMessage, "");

  var payload = {
    title: document.getElementById("new-title").value.trim(),
    genre: document.getElementById("new-genre").value.trim(),
    lengthText: document.getElementById("new-length").value.trim(),
    rating: document.getElementById("new-rating").value,
    pricePesos: document.getElementById("new-price").value,
    status: document.getElementById("new-status").value,
    statusNote: document.getElementById("new-note").value.trim(),
  };

  setBusy(addButton, true, "Adding…");

  try {
    var created = await api("/api/staff/movies", { method: "POST", body: payload });

    // The poster goes up as its own request, sent as the raw file so there is
    // no multipart form to parse on the other end.
    var file = document.getElementById("new-poster").files[0];

    if (file !== undefined) {
      setBusy(addButton, true, "Uploading poster…");

      var poster = await shrinkPoster(file);

      await api("/api/staff/movies/" + created.id + "/poster", {
        method: "POST",
        headers: { "Content-Type": poster.type },
        body: poster,
      });
    }

    showMessage(addMessage, '"' + payload.title + '" was added to the listings.', "success");
    addForm.reset();
    await loadMovies();
  } catch (error) {
    Object.keys(error.fields || {}).forEach(function (field) {
      showFieldError(field, error.fields[field]);
    });

    showMessage(addMessage, error.message, "error");
  } finally {
    setBusy(addButton, false);
  }
};

(async function () {
  // Same as the dashboard: reaching this page already proved the role, so the
  // movie list does not wait on the session lookup to confirm it.
  var moviesLoaded = loadMovies();

  await loadUser();
  renderTopBar();
  renderAdminMenu("/admin-movies");

  await moviesLoaded;
})();
