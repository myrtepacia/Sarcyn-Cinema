/* Home page: the movie listings, drawn from whatever the catalogue holds. */

var showingGrid = document.getElementById("showing-grid");
var soonGrid = document.getElementById("soon-grid");
var loadingNote = document.getElementById("showing-loading");

// The widest a poster is ever drawn is about 400px, so the files are 900x1200
// and the browser scales them down. Stating that size on the tag lets it work
// out the space the picture will take before the picture arrives.
var POSTER_W = 900;
var POSTER_H = 1200;

// Roughly one screenful. These load straight away; everything below is fetched
// only once the reader scrolls towards it, which on a phone showing two cards
// at a time is most of the page's weight left undownloaded.
var ABOVE_THE_FOLD = 4;

/** One card. Upcoming movies show their opening date instead of a Book button. */
function movieCard(movie, position) {
  var card = document.createElement("div");
  card.className = "movie-card";

  var showing = movie.status === "now_showing";
  var eager = position < ABOVE_THE_FOLD;

  card.innerHTML =
    '<div class="movie-poster">' +
      '<img src="' + escapeHtml(movie.posterUrl) + '"' +
        ' alt="' + escapeHtml(movie.title) + ' poster"' +
        ' width="' + POSTER_W + '" height="' + POSTER_H + '"' +
        ' decoding="async"' +
        (eager ? ' fetchpriority="high"' : ' loading="lazy"') + ">" +
      '<span class="tag-status ' + (showing ? "tag-showing" : "tag-soon") + '">' +
        (showing ? "Showing" : "Soon") +
      "</span>" +
      '<span class="tag-rated">' + escapeHtml(movie.rating) + "</span>" +
    "</div>" +
    '<div class="movie-info">' +
      '<h3 class="movie-title">' + escapeHtml(movie.title) + "</h3>" +
      '<p class="movie-genre">' + escapeHtml(movie.genre + ", " + movie.lengthText) + "</p>" +
      (showing && movie.statusNote
        ? '<p class="movie-last-day">' + escapeHtml(movie.statusNote) + "</p>"
        : "") +
      (showing ? '<p class="movie-price">' + peso(movie.priceCentavos) + "</p>" : "") +
      (showing
        ? '<a class="button button-red button-wide" href="/book/' + encodeURIComponent(movie.slug) + '">Book Now</a>'
        : '<span class="button button-grey button-wide">' + escapeHtml(movie.statusNote || "Coming soon") + "</span>") +
    "</div>";

  return card;
}

function filmCount(total) {
  return total === 1 ? "1 Film" : total + " Films";
}

async function loadMovies() {
  try {
    var result = await api("/api/movies");

    loadingNote.classList.add("hidden");

    var showing = result.movies.filter(function (movie) {
      return movie.status === "now_showing";
    });
    var soon = result.movies.filter(function (movie) {
      return movie.status === "upcoming";
    });

    // The counts beside each heading are the real list lengths, so they can
    // never drift from what is actually on the page.
    document.getElementById("showing-count").textContent = filmCount(result.counts.nowShowing);
    document.getElementById("soon-count").textContent = filmCount(result.counts.upcoming);

    showing.forEach(function (movie, position) {
      showingGrid.appendChild(movieCard(movie, position));
    });

    // Upcoming shows sit below Now Showing, so none of them are on screen when
    // the page opens however short the list above happens to be.
    soon.forEach(function (movie) {
      soonGrid.appendChild(movieCard(movie, ABOVE_THE_FOLD));
    });

    if (showing.length === 0) {
      showingGrid.innerHTML =
        '<p class="empty-state"><strong>Nothing showing right now</strong>Please check back soon.</p>';
    }

    if (soon.length === 0) {
      soonGrid.innerHTML =
        '<p class="empty-state"><strong>Nothing announced yet</strong>New titles appear here first.</p>';
    }
  } catch (error) {
    loadingNote.className = "form-message form-message-error";
    loadingNote.textContent = "The listings could not be loaded: " + error.message;
  }
}

/** Highlights whichever section the reader has scrolled to. */
function highlightMenu() {
  var soon = document.getElementById("coming-soon");
  // Only the two section anchors are in this race. The bar also holds links to
  // other pages — My Bookings for a customer, the back office for staff — and
  // matching every .menu a marked one of those "current" whenever the reader
  // was at the top of the page, which read as though they were already on it.
  var links = document.querySelectorAll('.menu a[href^="#"]');
  var atSoon = soon.getBoundingClientRect().top <= 120;

  links.forEach(function (link) {
    var isSoonLink = link.getAttribute("href") === "#coming-soon";
    link.classList.toggle("current", isSoonLink === atSoon);
  });
}

/*
 * Scroll fires far more often than the screen is redrawn, and highlightMenu
 * both reads a layout value (getBoundingClientRect forces the browser to
 * settle pending layout) and allocates a fresh NodeList each time. Coalescing
 * onto an animation frame does that work once per frame at most, which is the
 * most often it could ever be visible.
 */
var scrollPending = false;

window.addEventListener(
  "scroll",
  function () {
    if (scrollPending) {
      return;
    }

    scrollPending = true;

    window.requestAnimationFrame(function () {
      scrollPending = false;
      highlightMenu();
    });
  },
  { passive: true }
);

(async function () {
  // The listings are the same for everyone, so the catalogue request goes out
  // alongside the session lookup instead of queueing behind a round trip it
  // has no use for. Every loader on the site handles its own errors and never
  // rethrows, so starting one early and awaiting it later cannot produce an
  // unhandled rejection.
  var movies = loadMovies();

  await loadUser();
  renderTopBar();

  await movies;
  highlightMenu();
})();
