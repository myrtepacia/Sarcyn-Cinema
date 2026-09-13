/*
 * Door scanner.
 *
 * The camera handling here is unchanged from the version that was tested on a
 * phone: back camera first, with fallbacks for devices that refuse an exact
 * request or have only one camera. What changed is where ticket facts come
 * from — the hardcoded list and the in-memory "used" array are gone, and both
 * questions are now put to the server, so a ticket bought a minute ago is
 * recognised and a ticket already used on another device is caught.
 */

var cameraVideo = document.getElementById("camera-video");
var cameraMessage = document.getElementById("camera-message");
var scanResult = document.getElementById("scan-result");
var scanActions = document.getElementById("scan-actions");
var confirmBooking = document.getElementById("confirm-booking");
var cancelBooking = document.getElementById("cancel-booking");
var startCamera = document.getElementById("start-camera");
var closeCamera = document.getElementById("close-camera");

var cameraStream = null;

// The ticket on screen that is waiting for staff to press Confirm booking.
var waitingFor = null;

/* ------------------------------------------------------------------ *
 * Turning the camera on
 * ------------------------------------------------------------------ */

function openCamera() {
  if (!navigator.mediaDevices) {
    cameraMessage.textContent =
      "The camera only works when the page is opened over https, or on localhost.";
    return;
  }

  stopCamera();
  cameraMessage.textContent = "Starting the camera";

  // Ask for the back camera. Phones call that one the "environment" camera.
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: { exact: "environment" } } })
    .then(showCamera)
    .catch(function () {
      // Some phone browsers turn down an exact request, and a device with only
      // one camera always does, so open any camera and then look for a back one
      return navigator.mediaDevices.getUserMedia({ video: true }).then(swapToBackCamera);
    })
    .catch(function (error) {
      cameraMessage.textContent = "The camera could not be opened: " + error.message;
    });
}

// Trade the camera that opened for the back camera when the device has one
function swapToBackCamera(stream) {
  if (facesAway(stream.getVideoTracks()[0])) {
    showCamera(stream);
    return;
  }

  return navigator.mediaDevices.enumerateDevices().then(function (devices) {
    var backCamera = findBackCamera(devices);

    if (backCamera === null) {
      // A laptop, or a phone with no back camera, keeps the camera it opened
      showCamera(stream);
      return;
    }

    // Some phones allow only one camera at a time, so let go of this one first
    stopStream(stream);

    return navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: backCamera.deviceId } } })
      .then(showCamera)
      .catch(function () {
        // The back camera would not open after all, so go back to any camera
        return navigator.mediaDevices.getUserMedia({ video: true }).then(showCamera);
      });
  });
}

// Look through the cameras for one whose name says it faces away from you
function findBackCamera(devices) {
  for (var i = 0; i < devices.length; i += 1) {
    if (devices[i].kind === "videoinput" && nameSaysBack(devices[i].label)) {
      return devices[i];
    }
  }

  return null;
}

// Decide whether a camera track is the back camera
function facesAway(track) {
  var settings = track.getSettings ? track.getSettings() : {};

  if (settings.facingMode === "environment") {
    return true;
  }

  if (settings.facingMode === "user") {
    return false;
  }

  return nameSaysBack(track.label);
}

// Camera names differ between phones, so check the words they have in common
function nameSaysBack(label) {
  var name = String(label).toLowerCase();

  return (
    name.indexOf("back") !== -1 || name.indexOf("rear") !== -1 || name.indexOf("environment") !== -1
  );
}

// Put the camera picture on the screen and start looking for QR codes
function showCamera(stream) {
  cameraStream = stream;
  cameraVideo.srcObject = stream;
  cameraMessage.textContent = facesAway(stream.getVideoTracks()[0])
    ? "Back camera is on. Hold a ticket up to it."
    : "Camera is on. This device has no back camera.";

  startCamera.classList.add("hidden");
  closeCamera.classList.remove("hidden");
  startReading();
}

/* ------------------------------------------------------------------ *
 * Turning the camera off
 * ------------------------------------------------------------------ */

function stopCamera() {
  stopReading();
  clearAnswer();

  if (cameraStream !== null) {
    stopStream(cameraStream);
    cameraStream = null;
  }

  cameraVideo.srcObject = null;
  startCamera.classList.remove("hidden");
  closeCamera.classList.add("hidden");
}

// Switch off every track a stream holds
function stopStream(stream) {
  var tracks = stream.getTracks();

  for (var i = 0; i < tracks.length; i += 1) {
    tracks[i].stop();
  }
}

/* ------------------------------------------------------------------ *
 * Reading the QR code on a ticket
 * ------------------------------------------------------------------ */

var readingTimer = null;
var waitUntil = 0;
var lookingUp = false;
var scanCanvas = document.createElement("canvas");
var scanPad = scanCanvas.getContext("2d", { willReadFrequently: true });

// Look at the camera picture ten times a second
function startReading() {
  stopReading();
  readingTimer = setInterval(readPicture, 100);
}

function stopReading() {
  if (readingTimer !== null) {
    clearInterval(readingTimer);
    readingTimer = null;
  }

  waitUntil = 0;
}

// Copy one camera picture and hand it to the QR reader
function readPicture() {
  // After an answer, hold it on screen before reading again
  if (Date.now() < waitUntil || lookingUp) {
    return;
  }

  // The camera needs a moment before it has a picture to give
  if (cameraVideo.readyState < 2 || cameraVideo.videoWidth === 0) {
    return;
  }

  if (typeof jsQR !== "function") {
    cameraMessage.textContent = "The QR reader did not load, so js/jsQR.js may be missing";
    stopReading();
    return;
  }

  scanCanvas.width = cameraVideo.videoWidth;
  scanCanvas.height = cameraVideo.videoHeight;
  scanPad.drawImage(cameraVideo, 0, 0, scanCanvas.width, scanCanvas.height);

  var picture = scanPad.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  var found = jsQR(picture.data, picture.width, picture.height, { inversionAttempts: "dontInvert" });

  if (found !== null) {
    checkTicket(found.data);
  }
}

/* ------------------------------------------------------------------ *
 * Asking the server what a code means
 * ------------------------------------------------------------------ */

async function checkTicket(text) {
  lookingUp = true;

  // A new answer replaces whatever was waiting on screen before it
  waitingFor = null;
  scanActions.classList.add("hidden");

  try {
    var result = await api("/api/staff/scan/" + encodeURIComponent(text));
    var booking = result.booking;

    if (result.result === "already-used") {
      showAnswer("used", "Ticket already used", describe(booking) +
        (booking.checkedInAt ? " • scanned " + formatLongDateTime(booking.checkedInAt) : ""));
    } else {
      // A good ticket is not used up yet. Staff look at the person in front of
      // them and press Confirm booking, and only then does it count as used.
      waitingFor = booking;
      showAnswer("good", "Confirmed booking", describe(booking));
      scanActions.classList.remove("hidden");
      stopReading();
    }
  } catch (error) {
    var body = error.body || {};

    if (body.result === "unpaid") {
      showAnswer("bad", "Not paid", "That booking was never paid for.");
    } else {
      showAnswer("bad", "Try again", "That code is not a Cinemax ticket");
    }
  } finally {
    lookingUp = false;

    if (waitingFor === null) {
      waitUntil = Date.now() + 2500;
    }
  }
}

/** "Juan Dela Cruz • CX-8F3K92LM • The Reckoning • D5, D6" */
function describe(booking) {
  return (
    booking.customerName + " • " + booking.reference + " • " +
    booking.movie.title + " • " + booking.seats.join(", ")
  );
}

// Staff pressed Confirm booking, so the ticket is used from now on
confirmBooking.onclick = async function () {
  if (waitingFor === null) {
    return;
  }

  var reference = waitingFor.reference;
  setBusy(confirmBooking, true, "Confirming…");

  try {
    var result = await api("/api/staff/scan/" + encodeURIComponent(reference) + "/check-in", {
      method: "POST",
    });

    if (result.result === "checked-in") {
      showAnswer("good", "Ticket used", describe(result.booking));
    } else {
      // Another scanner got there first — exactly the case the old in-memory
      // list could never catch.
      showAnswer("used", "Ticket already used", describe(result.booking));
    }
  } catch (error) {
    showAnswer("bad", "Not confirmed", error.message);
  } finally {
    setBusy(confirmBooking, false);
    goBackToScanning();
  }
};

// Staff pressed Cancel, so the ticket is left alone and can be scanned again
cancelBooking.onclick = function () {
  clearAnswer();
  goBackToScanning();
};

// Put the buttons away and start looking for the next ticket
function goBackToScanning() {
  waitingFor = null;
  scanActions.classList.add("hidden");
  startReading();

  // Give staff a moment to move the ticket away from the camera
  waitUntil = Date.now() + 2500;
}

// Show the answer in green, yellow or red under the camera
function showAnswer(kind, heading, detail) {
  scanResult.className = "scan-result scan-result-" + kind;
  scanResult.textContent = heading;

  var line = document.createElement("span");
  line.className = "scan-result-who";
  line.textContent = detail;
  scanResult.appendChild(line);
}

// Clear the answer, ready for the next ticket
function clearAnswer() {
  scanResult.className = "scan-result hidden";
  scanResult.textContent = "";
  scanActions.classList.add("hidden");
  waitingFor = null;
}

startCamera.onclick = openCamera;

closeCamera.onclick = function () {
  stopCamera();
  cameraMessage.textContent = "Camera is off";
};

(async function () {
  await loadUser();
  renderTopBar();
  renderAdminMenu("/admin-scanner");

  // Door staff share devices, so make it obvious which account this one is on.
  if (currentUser !== null) {
    document.getElementById("signed-in-as").textContent = "Signed in as " + currentUser.name + ".";
  }

  // This page is only for scanning, so the camera starts on its own.
  openCamera();
})();
