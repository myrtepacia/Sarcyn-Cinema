/*
 * Staff dashboard.
 *
 * Every figure here is counted from paid bookings, and every change to an
 * order is written to the server before the row moves — so two people working
 * the counter on two devices see the same queue.
 */

// The counter queue, in the order the work actually happens.
var GROUPS = ["preparing", "ready", "sold"];

// The single step forward from each state. Sold is absent on purpose: an
// order that has been handed over has nowhere left to go.
var NEXT_STATUS = { preparing: "ready", ready: "sold" };

var LABELS = { preparing: "Preparing", ready: "Ready", sold: "Sold" };
var REFRESH_MS = 20 * 1000;

var pageMessage = document.getElementById("page-message");
var ordersLoading = document.getElementById("orders-loading");

async function loadSummary() {
  try {
    var summary = await api("/api/staff/summary");

    document.getElementById("total-revenue").textContent = peso(summary.totalRevenueCentavos);
    document.getElementById("ticket-revenue").textContent = peso(summary.ticketRevenueCentavos);
    document.getElementById("snack-revenue").textContent = peso(summary.snackRevenueCentavos);

    document.getElementById("tickets-sold").textContent =
      summary.ticketsSold + (summary.ticketsSold === 1 ? " ticket sold" : " tickets sold");
    document.getElementById("snacks-sold").textContent =
      summary.snacksSold + (summary.snacksSold === 1 ? " snack sold" : " snacks sold");
  } catch (error) {
    showMessage(pageMessage, "The takings could not be loaded: " + error.message, "error");
  }
}

/** One order row, with the dropdown that moves it between groups. */
function orderRow(order) {
  var row = document.createElement("div");
  row.className = "order-row";
  row.dataset.orderId = String(order.id);

  var left = document.createElement("div");
  left.className = "order-left";

  var items = document.createElement("p");
  items.className = "order-items";
  items.textContent = order.items
    .map(function (item) {
      return item.quantity > 1 ? item.name + " ×" + item.quantity : item.name;
    })
    .join(", ");

  var who = document.createElement("p");
  who.className = "order-who";
  who.textContent =
    order.reference + " • " + order.customerName + " • " +
    order.itemCount + (order.itemCount === 1 ? " snack" : " snacks");

  left.appendChild(items);
  left.appendChild(who);

  var price = document.createElement("p");
  price.className = "order-price";
  price.textContent = peso(order.totalCentavos);

  row.appendChild(left);
  row.appendChild(price);
  row.appendChild(control(row, order));

  return row;
}

/**
 * The one step an order can take from where it is.
 *
 * A snack order only ever moves forward: it is being prepared, then it is
 * waiting at the counter, then it has been handed over. Offering all three
 * states on every row let staff send a sold order back to Preparing by
 * misclicking, so each row now offers its next step and nothing else. Sold is
 * the end of the line and gets no dropdown at all.
 *
 * The server enforces the same order — see PATCH /api/staff/orders/:id/status
 * — so this is what staff can reach, not what the rule actually rests on.
 */
function control(row, order) {
  var next = NEXT_STATUS[order.status];

  if (next === undefined) {
    var done = document.createElement("span");
    done.className = "sold-tag";
    done.textContent = "Sold";
    return done;
  }

  var select = document.createElement("select");
  select.className = "order-status";

  // The current state, shown but not selectable again, then the one move on.
  [order.status, next].forEach(function (status, index) {
    var option = document.createElement("option");
    option.value = status;
    option.textContent = LABELS[status];
    option.selected = index === 0;
    select.appendChild(option);
  });

  select.onchange = function () {
    changeStatus(row, select, order);
  };

  return select;
}

/**
 * Writes the new status, and only moves the row once the server has taken it.
 * The old page moved the row first and saved nothing, so a failure looked
 * exactly like a success.
 */
async function changeStatus(row, select, order) {
  var previous = order.status;
  var wanted = select.value;

  select.disabled = true;

  try {
    await api("/api/staff/orders/" + order.id + "/status", {
      method: "PATCH",
      body: { status: wanted },
    });

    order.status = wanted;
    document.getElementById("group-" + wanted).appendChild(row);

    // The step forward is different now — from Ready the only move is Sold,
    // and from Sold there is none — so the control is rebuilt rather than
    // left offering the move that has just been made.
    row.replaceChild(control(row, order), select);

    refreshCounts();
    showMessage(pageMessage, "");
  } catch (error) {
    select.value = previous;
    select.disabled = false;
    showMessage(pageMessage, "That order could not be updated: " + error.message, "error");
  }
}

function refreshCounts() {
  GROUPS.forEach(function (group) {
    var count = document.getElementById("group-" + group).children.length;
    document.getElementById("count-" + group).textContent = String(count);
    document.getElementById("empty-" + group).classList.toggle("hidden", count > 0);
  });
}

async function loadOrders() {
  try {
    var result = await api("/api/staff/orders");

    ordersLoading.classList.add("hidden");

    GROUPS.forEach(function (group) {
      document.getElementById("group-" + group).innerHTML = "";
    });

    result.orders.forEach(function (order) {
      document.getElementById("group-" + order.status).appendChild(orderRow(order));
    });

    var total = result.orders.reduce(function (sum, order) {
      return sum + order.itemCount;
    }, 0);

    document.getElementById("orders-note").textContent =
      "Change the dropdown on an order and it moves to that group. " +
      total + (total === 1 ? " snack in total." : " snacks in total.");

    refreshCounts();
  } catch (error) {
    ordersLoading.classList.add("hidden");
    showMessage(pageMessage, "The snack orders could not be loaded: " + error.message, "error");
  }
}

(async function () {
  // The server already refused this page to anyone without the role (see the
  // guard on /admin in src/app.js), so the takings and the queue can be asked
  // for straight away rather than after a session round trip that can only
  // confirm what getting here already proved.
  var summaryLoaded = loadSummary();
  var ordersLoaded = loadOrders();

  await loadUser();
  renderTopBar();
  renderAdminMenu("/admin");

  await summaryLoaded;
  await ordersLoaded;

  // Someone else on another till may have moved an order along.
  setInterval(function () {
    loadSummary();
    loadOrders();
  }, REFRESH_MS);
})();
