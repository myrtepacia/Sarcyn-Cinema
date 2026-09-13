/*
 * Booking page, served for /book/<slug>.
 *
 * The seat map here is the real one for the chosen showtime, so picking a
 * different time genuinely changes which seats are free. Choosing seats holds
 * them on the server for ten minutes; paying is what turns the hold into a
 * sale.
 */

var slug = decodeURIComponent(window.location.pathname.replace(/^\/book\//, "").replace(/\/$/, ""));

var pageMessage = document.getElementById("page-message");
var pageLoading = document.getElementById("page-loading");
var layout = document.getElementById("booking-layout");
var dateSelect = document.getElementById("date");
var showtimeSelect = document.getElementById("showtime");
var pickFirst = document.getElementById("pick-first");
var seatsAndSnacks = document.getElementById("seats-and-snacks");
var seatMap = document.getElementById("seat-map");
var seatsLoading = document.getElementById("seats-loading");
var snackGroups = document.getElementById("snack-groups");
var bookingMessage = document.getElementById("booking-message");
var confirmButton = document.getElementById("confirm");

var movie = null;
var showtimes = [];
var snacks = [];
var selectedSeats = [];
var seatLookup = {};

/* ---------------------------------------------------------------- *
 * Loading the movie and its showtimes
 * ---------------------------------------------------------------- */

async function loadMovie() {
  try {
    var result = await api("/api/movies/" + encodeURIComponent(slug) + "/showtimes");

    movie = result.movie;
    showtimes = result.showtimes;

    document.title = movie.title + " - Cinemax";
    document.getElementById("poster").src = movie.posterUrl;
    document.getElementById("poster").alt = movie.title + " poster";
    document.getElementById("film-title").textContent = movie.title;
    document.getElementById("film-details").textContent =
      movie.genre + ", " + movie.lengthText + ", " + movie.rating;

    pageLoading.classList.add("hidden");
    layout.classList.remove("hidden");

    if (showtimes.length === 0) {
      showMessage(pageMessage, "There are no showings left for this movie.", "notice");
      return;
    }

    fillDates();
  } catch (error) {
    pageLoading.classList.add("hidden");
    showMessage(pageMessage, error.message, "error");
  }
}

/** One option per day that still has a showing. */
function fillDates() {
  var seen = [];

  showtimes.forEach(function (showtime) {
    var key = dayKey(showtime.startsAt);

    if (seen.indexOf(key) !== -1) {
      return;
    }

    seen.push(key);

    var option = document.createElement("option");
    option.value = key;
    option.textContent = formatShortDate(showtime.startsAt);
    dateSelect.appendChild(option);
  });
}

/** The times available on the chosen day, with a note when one is filling up. */
function fillShowtimes() {
  showtimeSelect.innerHTML = '<option value="">Choose a showtime</option>';

  showtimes
    .filter(function (showtime) {
      return dayKey(showtime.startsAt) === dateSelect.value;
    })
    .forEach(function (showtime) {
      var option = document.createElement("option");
      option.value = String(showtime.id);
      option.textContent = formatTime(showtime.startsAt);

      if (showtime.freeSeats === 0) {
        option.textContent += " — full";
        option.disabled = true;
      } else if (showtime.freeSeats <= 10) {
        option.textContent += " — " + showtime.freeSeats + " seats left";
      }

      showtimeSelect.appendChild(option);
    });
}

/* ---------------------------------------------------------------- *
 * Seats
 * ---------------------------------------------------------------- */

async function loadSeats() {
  selectedSeats = [];
  seatMap.innerHTML = "";
  seatsLoading.classList.remove("hidden");
  showMessage(bookingMessage, "");

  try {
    var result = await api("/api/showtimes/" + encodeURIComponent(showtimeSelect.value) + "/seats");

    seatsLoading.classList.add("hidden");
    drawSeats(result.seats);
    updateSummary();
  } catch (error) {
    seatsLoading.classList.add("hidden");
    showMessage(bookingMessage, "The seats could not be loaded: " + error.message, "error");
  }
}

function drawSeats(seats) {
  seatLookup = {};

  var rows = [];

  seats.forEach(function (seat) {
    var row = rows.find(function (candidate) {
      return candidate.letter === seat.row;
    });

    if (row === undefined) {
      row = { letter: seat.row, seats: [] };
      rows.push(row);
    }

    row.seats.push(seat);
  });

  seatMap.innerHTML = "";

  rows.forEach(function (row) {
    var rowElement = document.createElement("div");
    rowElement.className = "seat-row";

    var letter = document.createElement("span");
    letter.className = "row-letter";
    letter.textContent = row.letter;
    rowElement.appendChild(letter);

    row.seats.forEach(function (seat) {
      if (seat.taken) {
        // A taken seat is plain text, not a checkbox, so it cannot be picked.
        var sold = document.createElement("span");
        sold.className = "seat-box seat-box-sold";
        sold.textContent = String(seat.number);
        sold.title = "Seat " + seat.code + " is taken";
        rowElement.appendChild(sold);
        return;
      }

      var label = document.createElement("label");
      label.className = "seat";

      var input = document.createElement("input");
      input.type = "checkbox";
      input.value = seat.code;
      input.onchange = onSeatToggled;

      var box = document.createElement("span");
      box.className = "seat-box";
      box.textContent = String(seat.number);

      label.appendChild(input);
      label.appendChild(box);
      rowElement.appendChild(label);

      seatLookup[seat.code] = input;
    });

    seatMap.appendChild(rowElement);
  });
}

function onSeatToggled() {
  selectedSeats = Object.keys(seatLookup).filter(function (code) {
    return seatLookup[code].checked;
  });

  updateSummary();
}

/* ---------------------------------------------------------------- *
 * Snacks
 * ---------------------------------------------------------------- */

async function loadSnacks() {
  try {
    var result = await api("/api/snacks");

    snackGroups.innerHTML = "";

    result.groups.forEach(function (group) {
      var heading = document.createElement("p");
      heading.className = "snack-heading";
      heading.textContent = group.category;
      snackGroups.appendChild(heading);

      var list = document.createElement("div");
      list.className = "snack-list";

      group.items.forEach(function (item) {
        var label = document.createElement("label");
        label.className = "snack";

        var input = document.createElement("input");
        input.type = "checkbox";
        input.value = String(item.id);
        input.dataset.price = String(item.priceCentavos);
        input.dataset.name = item.name;
        input.onchange = updateSummary;

        var box = document.createElement("span");
        box.className = "snack-box";
        box.innerHTML =
          "<span><span class=\"snack-name\">" + escapeHtml(item.name) + "</span></span>" +
          '<span class="snack-price">' + peso(item.priceCentavos) + "</span>";

        label.appendChild(input);
        label.appendChild(box);
        list.appendChild(label);

        snacks.push(input);
      });

      snackGroups.appendChild(list);
    });
  } catch (error) {
    snackGroups.innerHTML = "";
    showMessage(bookingMessage, "The snack menu could not be loaded: " + error.message, "error");
  }
}

function chosenSnacks() {
  return snacks.filter(function (input) {
    return input.checked;
  });
}

/* ---------------------------------------------------------------- *
 * Summary
 * ---------------------------------------------------------------- */

function updateSummary() {
  var showtime = showtimes.find(function (candidate) {
    return String(candidate.id) === showtimeSelect.value;
  });

  document.getElementById("summary-when").textContent =
    showtime === undefined
      ? "Choose a date and showtime"
      : formatShortDate(showtime.startsAt) + ", " + formatTime(showtime.startsAt);

  document.getElementById("summary-seats").textContent =
    selectedSeats.length === 0 ? "Tap the seats above" : selectedSeats.join(", ");

  var picked = chosenSnacks();

  document.getElementById("summary-snacks").textContent =
    picked.length === 0
      ? "Tick any items above"
      : picked
          .map(function (input) {
            return input.dataset.name;
          })
          .join(", ");

  var snackTotal = picked.reduce(function (sum, input) {
    return sum + Number(input.dataset.price);
  }, 0);

  var ticketTotal = selectedSeats.length * (movie ? movie.priceCentavos : 0);

  document.getElementById("summary-tickets").textContent =
    selectedSeats.length + (selectedSeats.length === 1 ? " ticket × " : " tickets × ") +
    peso(movie ? movie.priceCentavos : 0);

  // Shown so the customer knows what to expect. The server prices the booking
  // again from its own tables, so this figure is never what gets charged.
  document.getElementById("summary-amount").textContent = peso(ticketTotal + snackTotal);
}

/* ---------------------------------------------------------------- *
 * Confirming and paying
 * ---------------------------------------------------------------- */

confirmButton.onclick = async function () {
  if (showtimeSelect.value === "") {
    showMessage(bookingMessage, "Choose a date and a showtime first.", "error");
    return;
  }

  if (selectedSeats.length === 0) {
    showMessage(bookingMessage, "Choose at least one seat.", "error");
    return;
  }

  // Sign-in is needed before seats can be held in someone's name. Come back
  // to this same page afterwards rather than dropping the visitor at the home
  // page having lost their place.
  if (currentUser === null) {
    window.location.href = "/signin?next=" + encodeURIComponent(window.location.pathname);
    return;
  }

  showMessage(bookingMessage, "");
  setBusy(confirmButton, true, "Holding your seats…");

  try {
    var draft = await api("/api/bookings/draft", {
      method: "POST",
      body: {
        showtimeId: Number(showtimeSelect.value),
        seats: selectedSeats,
        snacks: chosenSnacks().map(function (input) {
          return { itemId: Number(input.value), quantity: 1 };
        }),
      },
    });

    setBusy(confirmButton, true, "Opening the payment page…");

    var checkout = await api(
      "/api/bookings/" + encodeURIComponent(draft.booking.reference) + "/checkout",
      { method: "POST" }
    );

    window.location.href = checkout.checkoutUrl;
  } catch (error) {
    setBusy(confirmButton, false);

    // Somebody else got there first. Say which seats, and show the map as it
    // now stands so the next choice is made against the truth.
    if (error.body && error.body.unavailableSeats) {
      showMessage(bookingMessage, error.message, "error");
      await loadSeats();
      return;
    }

    showMessage(bookingMessage, error.message, "error");
  }
};

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

/** Seats and snacks stay hidden until there is a showtime to attach them to. */
function revealIfReady() {
  var ready = dateSelect.value !== "" && showtimeSelect.value !== "";

  pickFirst.classList.toggle("hidden", ready);
  seatsAndSnacks.classList.toggle("hidden", !ready);

  return ready;
}

dateSelect.onchange = function () {
  fillShowtimes();
  revealIfReady();
  updateSummary();
};

showtimeSelect.onchange = async function () {
  if (revealIfReady()) {
    await loadSeats();
  }

  updateSummary();
};

(async function () {
  // Three requests that need nothing from each other: who is signed in, this
  // movie's showtimes, and the snack menu. Run one after another they were
  // three round trips deep before the seat map could be reached; started
  // together they cost one.
  // Named ...Loaded rather than movie/snacks, which are already globals these
  // two loaders fill in.
  var movieLoaded = loadMovie();
  var snacksLoaded = loadSnacks();

  await loadUser();
  renderTopBar();

  await movieLoaded;
  await snacksLoaded;
})();
