/*
 * The e-ticket, served for /ticket/<reference>.
 *
 * Everything on it comes from the booking it names, and the QR code is drawn
 * from that reference — so what the scanner reads at the door is the booking
 * this page is showing, not a picture of somebody else's.
 */

var reference = decodeURIComponent(
  window.location.pathname.replace(/^\/ticket\//, "").replace(/\/$/, "")
);

var loading = document.getElementById("loading");
var pageMessage = document.getElementById("page-message");
var wrap = document.getElementById("ticket-wrap");

function fill(booking) {
  document.title = booking.movie.title + " ticket - Cinemax";

  document.getElementById("movie-title").textContent = booking.movie.title;
  document.getElementById("showtime").textContent = formatLongDateTime(booking.showtime.startsAt);
  document.getElementById("reference").textContent = booking.reference;
  document.getElementById("seats").textContent = booking.seats.join(", ");
  document.getElementById("customer-name").textContent = booking.customerName;
  document.getElementById("total").textContent = peso(booking.totalCentavos);

  if (booking.snacks.length === 0) {
    // No snacks on this booking, so the whole row would just say "none".
    document.getElementById("snack-pair").classList.add("hidden");
  } else {
    document.getElementById("snacks").textContent = booking.snacks
      .map(function (snack) {
        return snack.quantity > 1 ? snack.name + " ×" + snack.quantity : snack.name;
      })
      .join(", ");
  }

  var qr = document.getElementById("qr");
  qr.src = "/api/bookings/" + encodeURIComponent(booking.reference) + "/qr.png";
  qr.alt = "QR code for booking " + booking.reference;
  document.getElementById("qr-caption").textContent = booking.reference;

  document.getElementById("book-another").href = "/book/" + encodeURIComponent(booking.movie.slug);

  // A ticket that has already been through the door still shows, but says so,
  // so nobody is left wondering why it will not scan again.
  if (booking.checkedInAt !== null) {
    var note = document.getElementById("used-note");
    note.textContent = "This ticket was scanned at the door on " + formatLongDateTime(booking.checkedInAt) + ".";
    note.classList.remove("hidden");
  }

  loading.classList.add("hidden");
  wrap.classList.remove("hidden");
}

(async function () {
  await loadUser();
  renderTopBar();

  if (currentUser === null) {
    window.location.href = "/signin?next=" + encodeURIComponent(window.location.pathname);
    return;
  }

  try {
    var result = await api("/api/bookings/" + encodeURIComponent(reference));

    // Not paid for yet: the confirming page is where that gets resolved.
    if (result.booking.status !== "paid") {
      window.location.href = "/booking/" + encodeURIComponent(reference) + "/confirming";
      return;
    }

    fill(result.booking);
  } catch (error) {
    loading.classList.add("hidden");

    showMessage(
      pageMessage,
      error.status === 404
        ? "That ticket could not be found. Check the address, or sign in with the account that booked it."
        : error.message,
      "error"
    );
  }
})();
