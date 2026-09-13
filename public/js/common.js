/*
 * Helpers every page uses: talking to the API, formatting money and times,
 * and drawing the two menus.
 *
 * Written as plain browser script with no build step, the same way the rest
 * of the site's JavaScript has always been written.
 */

/** Calls the API and returns the parsed body, or throws with a readable message. */
async function api(path, options) {
  const settings = Object.assign({ headers: {}, credentials: "same-origin" }, options);

  // A poster file is already a request body and must go up untouched. Left to
  // the branch below, JSON.stringify turned it into the literal text "{}" and
  // labelled it application/json — which the upload route then refused as not
  // an image, so every poster upload failed with a 415. Object.assign being
  // shallow, the caller's own image/jpeg header was overwritten on the way
  // past too. File extends Blob, so this covers both.
  if (
    settings.body !== undefined &&
    typeof settings.body !== "string" &&
    !(settings.body instanceof Blob)
  ) {
    settings.headers["Content-Type"] = "application/json";
    settings.body = JSON.stringify(settings.body);
  }

  const response = await fetch(path, settings);

  if (response.status === 204) {
    return null;
  }

  let body = null;

  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }

  if (!response.ok) {
    const failure = new Error(body && body.error ? body.error : "Something went wrong.");
    failure.status = response.status;
    failure.fields = body && body.fields ? body.fields : {};
    failure.body = body;
    throw failure;
  }

  return body;
}

/** 22000 -> "₱220". Whole pesos, because every price on the site is whole. */
function peso(centavos) {
  const pesos = Math.round(Number(centavos) / 100);
  return "₱" + pesos.toLocaleString("en-PH");
}

var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function clockTime(date) {
  var hours = date.getHours();
  var minutes = String(date.getMinutes()).padStart(2, "0");
  var suffix = hours >= 12 ? "PM" : "AM";
  var display = hours % 12 === 0 ? 12 : hours % 12;

  return display + ":" + minutes + " " + suffix;
}

/** "7:00 PM" */
function formatTime(epochMs) {
  return clockTime(new Date(epochMs));
}

/** "Sat, 5 Sep" — the short form the date dropdown uses. */
function formatShortDate(epochMs) {
  var date = new Date(epochMs);
  return WEEKDAYS[date.getDay()].slice(0, 3) + ", " + date.getDate() + " " + MONTHS[date.getMonth()].slice(0, 3);
}

/** "7:00 PM, Saturday, September 5, 2026" — the long form printed on a ticket. */
function formatLongDateTime(epochMs) {
  var date = new Date(epochMs);

  return (
    clockTime(date) + ", " + WEEKDAYS[date.getDay()] + ", " +
    MONTHS[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear()
  );
}

/** The day part alone, used to group showtimes by date. */
function dayKey(epochMs) {
  var date = new Date(epochMs);
  return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
}

/** Escapes text before it goes anywhere near innerHTML. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

var currentUser = null;

/** Who is signed in, fetched once per page load. */
async function loadUser() {
  try {
    var result = await api("/api/auth/me");
    currentUser = result.user;
  } catch (error) {
    currentUser = null;
  }

  return currentUser;
}

/** Adds one link to a nav, unless it is already there. */
function addMenuLink(menu, href, label) {
  if (menu.querySelector('[href="' + href + '"]') !== null) {
    return;
  }

  var link = document.createElement("a");
  link.href = href;
  link.textContent = label;

  if (window.location.pathname === href) {
    link.className = "current";
  }

  menu.appendChild(link);
}

/**
 * Fills in the top bar for whoever is signed in.
 *
 * The account link goes in the nav rather than beside Sign Out, because the
 * bar only has room for one button before it overflows a phone screen — which
 * is exactly what happened when both sat there together.
 */
function renderTopBar() {
  var holder = document.querySelector(".auth-buttons");

  if (holder === null) {
    return;
  }

  if (currentUser === null) {
    holder.innerHTML =
      '<a class="button button-outline" href="/signin">Sign In</a>' +
      '<a class="button button-red" href="/signup">Sign Up</a>';
    setupMobileNav();
    return;
  }

  var menu = document.querySelector(".menu");

  if (menu !== null) {
    // currentUser.menu comes from the server, built from the same table that
    // decides what each role may open. A customer's is empty; staff and
    // scanner accounts have back-office pages in theirs.
    var isBackOffice = currentUser.menu.length > 0;

    if (isBackOffice) {
      // Now Showing, Upcoming Shows and My Bookings are customer links, and
      // they have no business on the till or the door scanner — six links in
      // the bar was most of a shift spent reading past the ones that did not
      // apply. Clear what the page hardcoded and show only this account's own
      // pages. On a back-office page even those are dropped, since it already
      // lists them as pills under its heading; the CINEMAX logo is still the
      // way back to the public site.
      menu.innerHTML = "";

      if (document.querySelector(".admin-menu") === null) {
        currentUser.menu.forEach(function (entry) {
          addMenuLink(menu, entry.href, entry.label);
        });
      }
    } else {
      addMenuLink(menu, "/account", "My Bookings");
    }
  }

  holder.innerHTML = '<button class="button button-red" type="button" id="sign-out">Sign Out</button>';

  document.getElementById("sign-out").onclick = async function () {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };

  // Called here rather than by each page's own script, so every page that
  // draws a top bar gets the phone treatment without having to remember to
  // ask for it.
  setupMobileNav();
}

/* ------------------------------------------------------------------ *
 * Mobile navigation
 * ------------------------------------------------------------------ */

var NARROW = window.matchMedia("(max-width: 760px)");
var drawer = null;
var toggle = null;

/**
 * Puts the bar's links behind a hamburger on a phone.
 *
 * The links and the sign-in buttons are MOVED into the drawer, not copied.
 * Copying would have meant two Sign Out buttons with one dead handler between
 * them, and a copy that quietly went stale every time the bar was redrawn.
 * Moving keeps one of each, wherever it currently lives.
 *
 * Called after renderTopBar, so what ends up in the drawer is whatever that
 * decided this account should see.
 */
function setupMobileNav() {
  var bar = document.querySelector(".top-bar-inner");
  var menu = document.querySelector(".menu");
  var buttons = document.querySelector(".auth-buttons");

  if (bar === null || buttons === null) {
    return;
  }

  if (toggle === null) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "menu-toggle";
    toggle.setAttribute("aria-label", "Menu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "mobile-drawer");
    toggle.appendChild(document.createElement("span"));
    toggle.onclick = function () {
      setDrawerOpen(toggle.getAttribute("aria-expanded") !== "true");
    };
    bar.appendChild(toggle);

    drawer = document.createElement("div");
    drawer.className = "mobile-drawer";
    drawer.id = "mobile-drawer";
    drawer.hidden = true;
    // The bar is sticky, so it is already a positioning parent and the
    // drawer drops directly beneath it.
    document.querySelector(".top-bar").appendChild(drawer);
  }

  // A back-office page navigates by its own pill row, so its bar has no links
  // and needs no hamburger — Sign Out alone fits fine.
  var worthCollapsing = menu !== null && menu.children.length > 0;
  toggle.classList.toggle("is-needed", worthCollapsing);

  placeNav(worthCollapsing);
}

/** Moves the bar's nav into the drawer on a phone, and back on a wide screen. */
function placeNav(worthCollapsing) {
  var bar = document.querySelector(".top-bar-inner");
  var menu = document.querySelector(".menu");
  var buttons = document.querySelector(".auth-buttons");

  if (NARROW.matches && worthCollapsing) {
    if (menu !== null) {
      drawer.appendChild(menu);
    }

    drawer.appendChild(buttons);
    return;
  }

  // Back in the bar, in the order the markup had them: logo, links, buttons,
  // then the toggle last so it stays at the right-hand end.
  setDrawerOpen(false);

  if (menu !== null) {
    bar.insertBefore(menu, buttons.parentNode === bar ? buttons : null);
  }

  bar.appendChild(buttons);
  bar.appendChild(toggle);
}

function setDrawerOpen(open) {
  if (drawer === null || toggle === null) {
    return;
  }

  drawer.hidden = !open;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

// Following a link should put the drawer away, or it stays open over the page
// that was just opened.
document.addEventListener("click", function (event) {
  if (drawer === null || drawer.hidden) {
    return;
  }

  if (event.target.closest("a") !== null && drawer.contains(event.target)) {
    setDrawerOpen(false);
    return;
  }

  // A tap anywhere outside the drawer or the button closes it too.
  if (!drawer.contains(event.target) && !toggle.contains(event.target)) {
    setDrawerOpen(false);
  }
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    setDrawerOpen(false);
  }
});

// Turning the phone sideways, or opening the same page on a wide screen, puts
// the links back in the bar rather than leaving them stranded in a hidden
// drawer.
NARROW.addEventListener("change", function () {
  if (toggle !== null) {
    placeNav(toggle.classList.contains("is-needed"));
  }
});

/**
 * Draws the staff menu from the list the server sent.
 *
 * The server decides what belongs in it, so a scanner account is never shown
 * a link to the dashboard it would be refused anyway.
 */
function renderAdminMenu(currentHref) {
  var nav = document.querySelector(".admin-menu");

  if (nav === null || currentUser === null) {
    return;
  }

  nav.innerHTML = currentUser.menu
    .map(function (entry) {
      var current = entry.href === currentHref ? ' class="current"' : "";
      return '<a href="' + entry.href + '"' + current + ">" + escapeHtml(entry.label) + "</a>";
    })
    .join("");
}

/** Shows a message in a box that is hidden until there is something to say. */
function showMessage(element, text, kind) {
  if (element === null) {
    return;
  }

  if (!text) {
    element.textContent = "";
    element.classList.add("hidden");
    return;
  }

  element.textContent = text;
  element.className = "form-message form-message-" + (kind || "error");
}

/** Puts a button into and out of its working state. */
function setBusy(button, busy, busyLabel) {
  if (button === null) {
    return;
  }

  if (busy) {
    // Only the first call records the real label. A step that updates the
    // working text part way through must not save that as the text to
    // restore, or the button keeps the working label after it finishes.
    if (button.dataset.idleLabel === undefined) {
      button.dataset.idleLabel = button.textContent;
    }

    button.textContent = busyLabel || "Working…";
    button.disabled = true;
  } else {
    if (button.dataset.idleLabel !== undefined) {
      button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
    }

    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Show / hide password
 * ------------------------------------------------------------------ */

/**
 * Puts a working eye on every password field.
 *
 * The whole job is switching the input between type="password" and
 * type="text"; the browser does the rest. Which of the two icons shows is
 * decided by CSS from aria-pressed, so nothing here touches the markup.
 *
 * The button is in the HTML carrying the hidden attribute and this is what
 * removes it, so with JavaScript off there is no dead button and the field
 * simply stays masked.
 */
function setupPasswordToggles() {
  var toggles = document.querySelectorAll(".password-toggle");

  toggles.forEach(function (button) {
    // Each button finds its own input through its own wrapper, so the two
    // fields on the sign-up page never reach for each other's box.
    var field = button.closest(".password-field");
    var input = field === null ? null : field.querySelector("input");

    if (input === null) {
      return;
    }

    button.hidden = false;

    button.onclick = function () {
      var reveal = input.type === "password";

      input.type = reveal ? "text" : "password";
      button.setAttribute("aria-pressed", reveal ? "true" : "false");
      button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");

      // Changing the type moves the cursor to the start in some browsers, so
      // typing carries on from where it left off.
      var at = input.value.length;
      input.focus();
      input.setSelectionRange(at, at);
    };
  });
}

// Runs on every page. A page with no password fields finds none and stops.
setupPasswordToggles();
