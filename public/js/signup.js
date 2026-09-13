/*
 * Sign up.
 *
 * Checks what it can here for a quick answer, but the server checks all of it
 * again — including that the two passwords match, which nothing in the old
 * site ever verified anywhere.
 */

var form = document.getElementById("signup-form");
var message = document.getElementById("form-message");
var submit = document.getElementById("submit");

// Which input each server-side field name belongs to.
var FIELD_INPUTS = {
  name: "fullname",
  email: "email",
  phone: "mobile",
  password: "password",
  confirmPassword: "confirm",
};

function nextDestination() {
  var next = new URLSearchParams(window.location.search).get("next");

  if (next && next.startsWith("/") && !next.startsWith("//")) {
    return next;
  }

  return "/";
}

function clearFieldErrors() {
  document.querySelectorAll(".field-error").forEach(function (note) {
    note.remove();
  });
  document.querySelectorAll(".invalid").forEach(function (input) {
    input.classList.remove("invalid");
  });
}

/** Puts the server's complaint underneath the input it is about. */
function showFieldError(fieldName, text) {
  var input = document.getElementById(FIELD_INPUTS[fieldName]);

  if (input === null || input === undefined) {
    return false;
  }

  input.classList.add("invalid");

  var note = document.createElement("span");
  note.className = "field-error";
  note.textContent = text;
  input.parentNode.appendChild(note);

  return true;
}

form.onsubmit = async function (event) {
  event.preventDefault();

  clearFieldErrors();
  showMessage(message, "");

  var payload = {
    name: document.getElementById("fullname").value.trim(),
    email: document.getElementById("email").value.trim(),
    phone: document.getElementById("mobile").value.trim(),
    password: document.getElementById("password").value,
    confirmPassword: document.getElementById("confirm").value,
  };

  if (!document.getElementById("agree").checked) {
    showMessage(message, "Please agree to the Terms of Service to continue.", "error");
    return;
  }

  if (payload.password !== payload.confirmPassword) {
    showFieldError("confirmPassword", "The two passwords do not match.");
    showMessage(message, "Please check the form.", "error");
    return;
  }

  setBusy(submit, true, "Creating your account…");

  try {
    await api("/api/auth/signup", { method: "POST", body: payload });

    // Signing up signs you in, so go straight on.
    window.location.href = nextDestination();
  } catch (error) {
    var shown = 0;

    Object.keys(error.fields || {}).forEach(function (field) {
      if (showFieldError(field, error.fields[field])) {
        shown += 1;
      }
    });

    showMessage(message, error.message, "error");

    if (shown === 0) {
      // Nothing to attach it to, so the banner is the whole story.
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    setBusy(submit, false);
  }
};

(async function () {
  await loadUser();
  renderTopBar();

  var next = new URLSearchParams(window.location.search).get("next");

  if (next) {
    document.getElementById("signin-link").href = "/signin?next=" + encodeURIComponent(next);
  }

  if (currentUser !== null) {
    window.location.href = nextDestination();
  }
})();
