/*
 * Where PayMongo sends someone who backed out of paying.
 *
 * The hold would lapse on its own after ten minutes, but there is no reason to
 * keep those seats off the map when the customer has already walked away, so
 * they are released straight away.
 */

var reference = decodeURIComponent(
  window.location.pathname.replace(/^\/booking\//, "").replace(/\/cancelled\/?$/, "")
);

var tryAgain = document.getElementById("try-again");
var pageMessage = document.getElementById("page-message");

(async function () {
  await loadUser();
  renderTopBar();

  if (currentUser === null) {
    tryAgain.onclick = function () {
      window.location.href = "/";
    };
    return;
  }

  try {
    var result = await api("/api/bookings/" + encodeURIComponent(reference));
    var booking = result.booking;

    // Already paid for after all — someone reached this address by going back
    // in the browser. Send them to the ticket rather than cancelling a sale.
    if (booking.status === "paid") {
      window.location.href = "/ticket/" + encodeURIComponent(reference);
      return;
    }

    if (booking.status === "pending_payment") {
      await api("/api/bookings/" + encodeURIComponent(reference) + "/cancel", { method: "POST" });
    }

    tryAgain.onclick = function () {
      window.location.href = "/book/" + encodeURIComponent(booking.movie.slug);
    };
  } catch (error) {
    // Nothing to release, so just offer the way back to the listings.
    showMessage(pageMessage, "", null);
    tryAgain.textContent = "Back to movies";
    tryAgain.onclick = function () {
      window.location.href = "/";
    };
  }
})();
