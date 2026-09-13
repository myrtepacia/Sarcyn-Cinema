/*
 * Where PayMongo sends the customer back to after they pay.
 *
 * Arriving here does not mean the payment succeeded — only that the browser
 * came back. The booking is treated as paid when the server says so, which it
 * learns either from PayMongo's webhook or, on a machine no webhook can reach,
 * by asking PayMongo directly as each of these checks comes in.
 */

var reference = decodeURIComponent(
  window.location.pathname.replace(/^\/booking\//, "").replace(/\/confirming\/?$/, "")
);

var spinner = document.getElementById("spinner");
var heading = document.getElementById("heading");
var detail = document.getElementById("detail");
var pageMessage = document.getElementById("page-message");
var actions = document.getElementById("actions");

var GIVE_UP_AFTER_MS = 60 * 1000;
var CHECK_EVERY_MS = 2000;

var startedAt = null;
var timer = null;

function stopWaiting(headingText, detailText, kind) {
  clearTimeout(timer);
  spinner.classList.add("hidden");
  heading.textContent = headingText;
  detail.textContent = detailText;
  actions.classList.remove("hidden");

  if (kind) {
    showMessage(pageMessage, detailText, kind);
    detail.textContent = "";
  }
}

async function check() {
  try {
    var result = await api("/api/bookings/" + encodeURIComponent(reference));
    var booking = result.booking;

    if (booking.status === "paid") {
      heading.textContent = "Payment confirmed";
      detail.textContent = "Taking you to your ticket…";
      window.location.href = "/ticket/" + encodeURIComponent(reference);
      return;
    }

    if (booking.status === "cancelled" || booking.status === "expired") {
      stopWaiting(
        "This booking is no longer held",
        "The seats were released because the payment did not come through in time. Please choose your seats again.",
        "notice"
      );
      document.getElementById("check-again").textContent = "Choose seats again";
      document.getElementById("check-again").onclick = function () {
        window.location.href = "/book/" + encodeURIComponent(booking.movie.slug);
      };
      return;
    }

    // Still pending. Keep checking until the cut-off rather than spinning
    // forever with nothing to show for it.
    if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
      stopWaiting(
        "Still confirming",
        "Your payment has not been confirmed yet. This can take a little longer at busy times — check again in a moment, and your ticket will appear here once it lands."
      );
      return;
    }

    timer = setTimeout(check, CHECK_EVERY_MS);
  } catch (error) {
    if (error.status === 404) {
      stopWaiting("Booking not found", "We could not find that booking on your account.", "error");
      return;
    }

    if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
      stopWaiting("Still confirming", error.message);
      return;
    }

    timer = setTimeout(check, CHECK_EVERY_MS);
  }
}

(async function () {
  await loadUser();
  renderTopBar();

  if (currentUser === null) {
    window.location.href = "/signin?next=" + encodeURIComponent(window.location.pathname);
    return;
  }

  document.getElementById("check-again").onclick = function () {
    showMessage(pageMessage, "");
    spinner.classList.remove("hidden");
    actions.classList.add("hidden");
    heading.textContent = "Confirming your payment";
    detail.textContent = "This usually takes a few seconds. Please do not close this page.";
    startedAt = Date.now();
    check();
  };

  startedAt = Date.now();
  check();
})();
