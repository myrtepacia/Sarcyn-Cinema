/* The signed-in customer's own tickets. */

var loading = document.getElementById("loading");
var list = document.getElementById("bookings");
var pageMessage = document.getElementById("page-message");

function bookingRow(booking) {
  var row = document.createElement("a");
  row.className = "order-row";
  row.href = "/ticket/" + encodeURIComponent(booking.reference);
  row.style.textDecoration = "none";
  row.style.color = "inherit";

  var poster = document.createElement("img");
  poster.className = "table-poster";
  poster.src = booking.poster_url;
  poster.alt = booking.title + " poster";

  var left = document.createElement("div");
  left.className = "order-left";

  var title = document.createElement("p");
  title.className = "order-items";
  title.textContent = booking.title;

  var when = document.createElement("p");
  when.className = "order-who";
  when.textContent = formatLongDateTime(booking.starts_at) + " • " + booking.reference;

  left.appendChild(title);
  left.appendChild(when);

  var price = document.createElement("p");
  price.className = "order-price";
  price.textContent = peso(booking.total_centavos);

  row.appendChild(poster);
  row.appendChild(left);
  row.appendChild(price);

  return row;
}

(async function () {
  await loadUser();
  renderTopBar();

  if (currentUser === null) {
    window.location.href = "/signin?next=/account";
    return;
  }

  document.getElementById("intro").textContent =
    "Signed in as " + currentUser.email + ". Your tickets, newest first.";

  try {
    var result = await api("/api/auth/account");

    loading.classList.add("hidden");

    if (result.bookings.length === 0) {
      list.innerHTML =
        '<p class="empty-state"><strong>No bookings yet</strong>' +
        "Once you book a seat, your ticket appears here.</p>" +
        '<p style="text-align: center;"><a class="button button-red" href="/">Browse movies</a></p>';
      return;
    }

    result.bookings.forEach(function (booking) {
      list.appendChild(bookingRow(booking));
    });
  } catch (error) {
    loading.classList.add("hidden");
    showMessage(pageMessage, "Your bookings could not be loaded: " + error.message, "error");
  }
})();
