/*
 * Sign in.
 *
 * The old page was a GET form, which put the password in the address bar and
 * checked nothing. This posts it and lets the server decide.
 */

var form = document.getElementById("signin-form");
var message = document.getElementById("form-message");
var submit = document.getElementById("submit");

/**
 * Where to go after signing in.
 *
 * A ?next= address always wins — that is someone who was sent here mid-way
 * through something and should be put back. Otherwise it depends who they
 * are: a customer wants the listings, but staff and door scanners want the
 * page they actually work on. Sending them to the movie grid meant every
 * shift started by hunting for the dashboard.
 *
 * The list comes from the server, which builds it from the same table that
 * decides what each role may open, so a scanner lands on the scanner and a
 * manager on the dashboard without either being named here.
 */
function nextDestination(user) {
  var next = new URLSearchParams(window.location.search).get("next");

  // Only same-site paths, so a crafted link cannot bounce someone off-site
  // after they sign in.
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    return next;
  }

  if (user && user.menu && user.menu.length > 0) {
    return user.menu[0].href;
  }

  return "/";
}

form.onsubmit = async function (event) {
  event.preventDefault();

  var email = document.getElementById("email").value.trim();
  var password = document.getElementById("password").value;

  if (email === "" || password === "") {
    showMessage(message, "Enter your email and password.", "error");
    return;
  }

  showMessage(message, "");
  setBusy(submit, true, "Signing in…");

  try {
    var result = await api("/api/auth/login", { method: "POST", body: { email: email, password: password } });
    window.location.href = nextDestination(result.user);
  } catch (error) {
    // The email is deliberately left in place so it does not have to be retyped.
    showMessage(message, error.message, "error");
    document.getElementById("password").value = "";
    setBusy(submit, false);
  }
};

(async function () {
  await loadUser();
  renderTopBar();

  // Carry the destination across to the sign-up page, so someone who creates
  // an account instead still lands back where they were going.
  var next = new URLSearchParams(window.location.search).get("next");

  if (next) {
    document.getElementById("signup-link").href = "/signup?next=" + encodeURIComponent(next);
  }

  if (currentUser !== null) {
    window.location.href = nextDestination(currentUser);
  }
})();
