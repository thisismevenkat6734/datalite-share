/* =========================================================
   DATALITE SHARE
   File: script.js
   Foundation: Firebase Authentication + Firestore
   ========================================================= */

import { initializeApp } from
  "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
  limit
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

/* ---------------------------------------------------------
   FIREBASE CONFIGURATION
   Existing Celebration of Life Firebase project
   --------------------------------------------------------- */

const firebaseConfig = {
  apiKey: "AIzaSyCm2ZwhbLg6SSY2qwAiOdfrMDx1i8sJjIQ",
  authDomain: "celebration-of-life-d3dfa.firebaseapp.com",
  projectId: "celebration-of-life-d3dfa",
  storageBucket: "celebration-of-life-d3dfa.firebasestorage.app",
  messagingSenderId: "808280368245",
  appId: "1:808280368245:web:a92fec777882dbf61a043c",
  measurementId: "G-PX41M3M7S5"
};

/* ---------------------------------------------------------
   INITIALIZATION
   --------------------------------------------------------- */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const COLLECTIONS = {
  users: "dataliteShareUsers",
  usernames: "dataliteShareUsernames"
};

const state = {
  user: null,
  profile: null,
  selectedFiles: [],
  receiver: null,
  qrScanner: null,
  cameraStream: null,
  busy: false
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------
   UTILITIES
   --------------------------------------------------------- */

function notify(message, type = "success") {
  const area = $("notificationArea");
  if (!area) return;

  const item = document.createElement("div");
  item.className = `notification ${type}`;
  item.textContent = message;

  area.appendChild(item);

  setTimeout(() => {
    item.remove();
  }, 4500);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`;
}

function validUsername(value) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(value);
}

function createUserCode() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0];
  return `DL${random.toString(36).toUpperCase().padStart(7, "0")}`;
}

function safeText(element, value) {
  if (element) element.textContent = value ?? "";
}

function setButtonLoading(button, loading, normalText) {
  if (!button) return;

  button.disabled = loading;
  button.textContent = loading ? "Please wait..." : normalText;
}

/* ---------------------------------------------------------
   NETWORK STATUS
   --------------------------------------------------------- */

function updateNetworkStatus() {
  const element = $("networkStatus");
  if (!element) return;

  const online = navigator.onLine;

  element.innerHTML = `
    <span class="status-dot"
      style="background:${online ? "#36e6a0" : "#ff6279"}">
    </span>
    ${online ? "Internet available" : "Offline"}
  `;
}

window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);
updateNetworkStatus();

/* ---------------------------------------------------------
   AUTHENTICATION
   --------------------------------------------------------- */

async function startAuthentication() {
  try {
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
  } catch (error) {
    console.error("Authentication error:", error);
    notify(
      "Authentication failed. Check Firebase Anonymous Authentication settings.",
      "error"
    );
  }
}

onAuthStateChanged(auth, async (user) => {
  state.user = user;

  if (!user) {
    state.profile = null;
    showGuestIdentity();
    return;
  }

  try {
    await loadUserProfile();
  } catch (error) {
    console.error("Profile loading error:", error);
    notify("Could not load your DataLite profile.", "error");
  }
});

/* ---------------------------------------------------------
   PROFILE
   --------------------------------------------------------- */

async function loadUserProfile() {
  if (!state.user) return;

  const profileRef = doc(
    db,
    COLLECTIONS.users,
    state.user.uid
  );

  const snapshot = await getDoc(profileRef);

  if (!snapshot.exists()) {
    showGuestIdentity();
    return;
  }

  state.profile = snapshot.data();
  showRegisteredIdentity();
}

function showGuestIdentity() {
  if ($("guestIdentity")) $("guestIdentity").hidden = false;
  if ($("registeredIdentity")) $("registeredIdentity").hidden = true;
  safeText($("userStatus"), "Not registered");
}

function showRegisteredIdentity() {
  if (!state.profile) return;

  if ($("guestIdentity")) $("guestIdentity").hidden = true;
  if ($("registeredIdentity")) $("registeredIdentity").hidden = false;

  safeText($("displayUserCode"), state.profile.code);
  safeText($("displayUsername"), `@${state.profile.username}`);
  safeText($("userStatus"), "Identity created");

  generateQRCode(state.profile.code);
}

/* ---------------------------------------------------------
   CREATE UNIQUE IDENTITY
   --------------------------------------------------------- */

async function createIdentity(event) {
  event.preventDefault();

  if (state.busy || !state.user) {
    notify("Please wait for authentication.", "error");
    return;
  }

  const input = $("usernameInput");
  const username = input?.value.trim().toLowerCase();

  if (!validUsername(username)) {
    notify(
      "Use 3–20 characters: letters, numbers or underscores.",
      "error"
    );
    return;
  }

  const button = $("createIdentityButton");

  try {
    state.busy = true;
    setButtonLoading(button, true, "Create ID");

    const usernameRef = doc(
      db,
      COLLECTIONS.usernames,
      username
    );

    const usernameSnapshot = await getDoc(usernameRef);

    if (usernameSnapshot.exists()) {
      notify("This username is already taken.", "error");
      return;
    }

    const code = createUserCode();

    const profileRef = doc(
      db,
      COLLECTIONS.users,
      state.user.uid
    );

    const profileSnapshot = await getDoc(profileRef);

    if (profileSnapshot.exists()) {
      state.profile = profileSnapshot.data();
      showRegisteredIdentity();
      notify("Your identity already exists.");
      return;
    }

    /*
      NOTE:
      This client-side availability check is not an atomic
      username reservation. Production requires a trusted
      server-side transaction or a carefully secured
      Firestore transaction with collision handling.
    */

    await setDoc(usernameRef, {
      uid: state.user.uid,
      username,
      createdAt: serverTimestamp()
    });

    await setDoc(profileRef, {
      uid: state.user.uid,
      username,
      code,
      createdAt: serverTimestamp(),
      status: "active"
    });

    state.profile = {
      uid: state.user.uid,
      username,
      code
    };

    showRegisteredIdentity();
    notify("Your DataLite identity has been created.");

  } catch (error) {
    console.error("Identity creation error:", error);
    notify("Could not create your identity. Try again.", "error");
  } finally {
    state.busy = false;
    setButtonLoading(button, false, "Create ID");
  }
}

/* ---------------------------------------------------------
   QR CODE
   --------------------------------------------------------- */

function generateQRCode(value) {
  const wrapper = $("userQrCode");
  if (!wrapper) return;

  wrapper.replaceChildren();

  if (!window.QRCode) {
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";

    script.onload = () => generateQRCode(value);
    script.onerror = () => {
      wrapper.textContent = "QR unavailable";
    };

    document.head.appendChild(script);
    return;
  }

  new window.QRCode(wrapper, {
    text: `dataliteshare://user/${encodeURIComponent(value)}`,
    width: 105,
    height: 105,
    colorDark: "#080d19",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.H
  });
}

async function copyUserCode() {
  if (!state.profile?.code) return;

  try {
    await navigator.clipboard.writeText(state.profile.code);
    notify("DataLite ID copied.");
  } catch {
    notify("Clipboard access is unavailable.", "error");
  }
}

async function shareQRCode() {
  if (!state.profile?.code) return;

  const text =
    `Connect with me on DataLite Share. My ID: ${state.profile.code}`;

  if (navigator.share) {
    try {
      await navigator.share({
        title: "DataLite Share",
        text
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        notify("Sharing was not available.", "error");
      }
    }
  } else {
    try {
      await navigator.clipboard.writeText(text);
      notify("Your DataLite ID was copied.");
    } catch {
      notify("Unable to share this ID.", "error");
    }
  }
}

/* ---------------------------------------------------------
   USER SEARCH
   --------------------------------------------------------- */

async function searchUser(event) {
  event.preventDefault();

  if (!state.user) {
    notify("Authentication is not ready.", "error");
    return;
  }

  const input = $("searchUserInput");
  const term = input?.value.trim().toLowerCase();

  if (!term) return;

  const results = $("searchResults");
  if (!results) return;

  results.textContent = "Searching...";

  try {
    let profile = null;

    if (term.startsWith("dl")) {
      const codeQuery = query(
        collection(db, COLLECTIONS.users),
        where("code", "==", term.toUpperCase()),
        limit(1)
      );

      const codeSnapshot = await getDocs(codeQuery);

      if (!codeSnapshot.empty) {
        profile = codeSnapshot.docs[0].data();
      }
    } else {
      const usernameRef = doc(
        db,
        COLLECTIONS.usernames,
        term
      );

      const usernameSnapshot = await getDoc(usernameRef);

      if (usernameSnapshot.exists()) {
        const data = usernameSnapshot.data();

        const profileSnapshot = await getDoc(
          doc(db, COLLECTIONS.users, data.uid)
        );

        if (profileSnapshot.exists()) {
          profile = profileSnapshot.data();
        }
      }
    }

    results.replaceChildren();

    if (!profile || profile.uid === state.user.uid) {
      results.textContent = profile
        ? "This is your own account."
        : "No DataLite user found.";
      return;
    }

    const card = document.createElement("div");
    card.className = "search-user-card";

    const title = document.createElement("strong");
    title.textContent = `@${profile.username}`;

    const code = document.createElement("p");
    code.textContent = profile.code;

    const button = document.createElement("button");
    button.className = "primary-button";
    button.textContent = "Select Receiver";

    button.addEventListener("click", () => {
      selectReceiver(profile);
    });

    card.append(title, code, button);
    results.appendChild(card);

  } catch (error) {
    console.error("Search error:", error);
    results.textContent = "Search failed. Please try again.";
  }
}

function selectReceiver(profile) {
  state.receiver = profile;

  if ($("receiverCodeInput")) {
    $("receiverCodeInput").value = profile.code;
  }

  safeText(
    $("receiverStatus"),
    `Selected receiver: @${profile.username}`
  );

  updateSendButton();
  notify(`Selected @${profile.username}`);
}

/* ---------------------------------------------------------
   FILE SELECTION
   --------------------------------------------------------- */

function handleFiles(fileList) {
  state.selectedFiles = Array.from(fileList || []);

  renderSelectedFiles();
  updateSendButton();
  updateCompressionEstimate();
}

function renderSelectedFiles() {
  const container = $("selectedFiles");
  if (!container) return;

  container.replaceChildren();

  if (!state.selectedFiles.length) {
    return;
  }

  const totalSize = state.selectedFiles.reduce(
    (sum, file) => sum + file.size,
    0
  );

  const heading = document.createElement("p");
  heading.textContent =
    `${state.selectedFiles.length} file(s) selected • ${formatBytes(totalSize)}`;

  container.appendChild(heading);

  state.selectedFiles.forEach((file) => {
    const row = document.createElement("div");
    row.className = "selected-file-item";

    const name = document.createElement("span");
    name.textContent = file.name;

    const size = document.createElement("small");
    size.textContent = formatBytes(file.size);

    row.append(name, size);
    container.appendChild(row);
  });
}

function updateSendButton() {
  const button = $("sendFilesButton");
  if (!button) return;

  button.disabled = !(
    state.user &&
    state.profile &&
    state.receiver &&
    state.selectedFiles.length > 0
  );
}

/* ---------------------------------------------------------
   COMPRESSION ESTIMATE
   This is an informational estimate only.
   No file is compressed by this function.
   --------------------------------------------------------- */

function updateCompressionEstimate() {
  const panel = $("compressionResult");
  if (!panel) return;

  const total = state.selectedFiles.reduce(
    (sum, file) => sum + file.size,
    0
  );

  if (!total) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  safeText($("originalFileSize"), formatBytes(total));

  const mode = document.querySelector(
    'input[name="compressionMode"]:checked'
  )?.value || "original";

  let message;

  if (mode === "original") {
    message = "Same as original";
  } else {
    message =
      "Not calculated — actual compression is not implemented";
  }

  safeText($("estimatedFileSize"), message);
}

/* ---------------------------------------------------------
   FILE DROP AREA
   --------------------------------------------------------- */

function setupFileDrop() {
  const area = $("fileDropArea");
  if (!area) return;

  area.addEventListener("dragover", (event) => {
    event.preventDefault();
    area.classList.add("drag-over");
  });

  area.addEventListener("dragleave", () => {
    area.classList.remove("drag-over");
  });

  area.addEventListener("drop", (event) => {
    event.preventDefault();
    area.classList.remove("drag-over");

    handleFiles(event.dataTransfer.files);
  });
}

/* ---------------------------------------------------------
   TRANSFER STATUS
   --------------------------------------------------------- */

function showTransferUnavailable() {
  notify(
    "Live transfer is not enabled yet. WebRTC signaling, secure session handling and transfer streaming must be completed first.",
    "error"
  );
}

function pauseTransferUnavailable() {
  notify(
    "Pause is not available until the transfer protocol is implemented.",
    "error"
  );
}

function resumeTransferUnavailable() {
  notify(
    "Resume is not available until the transfer protocol is implemented.",
    "error"
  );
}

function cancelTransferUnavailable() {
  notify(
    "There is no active transfer to cancel.",
    "error"
  );
}

/* ---------------------------------------------------------
   OFFLINE MODE
   --------------------------------------------------------- */

function startNearbyMode() {
  const area = $("nearbyDevices");
  if (area) {
    area.hidden = false;
    area.textContent =
      "Nearby browser-to-browser discovery is not available in this web version. Native Android local-network support is required for reliable offline discovery.";
  }

  notify(
    "Offline transfer needs a supported local wireless transport.",
    "error"
  );
}

/* ---------------------------------------------------------
   GLOBAL MODE
   --------------------------------------------------------- */

function startGlobalMode() {
  $("userSearchSection")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });

  notify(
    "Find the receiver by DataLite ID. Live transfer is not enabled yet."
  );
}

/* ---------------------------------------------------------
   QR SCANNER
   --------------------------------------------------------- */

async function startQrScanner() {
  const scanner = $("qrScanner");
  const video = $("cameraPreview");

  if (!scanner || !video) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    notify("Camera access requires HTTPS and browser support.", "error");
    return;
  }

  try {
    state.cameraStream =
      await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment"
        },
        audio: false
      });

    video.srcObject = state.cameraStream;
    video.hidden = false;
    scanner.hidden = false;

    notify(
      "Camera opened. QR decoding is not yet implemented in this version.",
      "error"
    );

  } catch (error) {
    console.error("Camera error:", error);
    notify("Camera permission denied or unavailable.", "error");
  }
}

function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => {
      track.stop();
    });
  }

  state.cameraStream = null;

  if ($("cameraPreview")) {
    $("cameraPreview").srcObject = null;
    $("cameraPreview").hidden = true;
  }

  if ($("qrScanner")) {
    $("qrScanner").hidden = true;
  }
}

/* ---------------------------------------------------------
   SHARE LINKS
   --------------------------------------------------------- */

async function createShareLink() {
  notify(
    "Live share links require a working WebRTC session and secure token validation. This feature is not enabled yet.",
    "error"
  );
}

function revokeShareLink() {
  notify(
    "No active share link is available to revoke.",
    "error"
  );
}

/* ---------------------------------------------------------
   HISTORY
   --------------------------------------------------------- */

function clearHistory() {
  const container = $("transferHistory");
  if (!container) return;

  container.textContent =
    "No completed transfers are recorded.";

  notify("Visible history cleared.");
}

/* ---------------------------------------------------------
   MENU
   --------------------------------------------------------- */

function toggleMenu() {
  const panel = $("menuPanel");
  if (!panel) return;

  panel.hidden = !panel.hidden;
}

function closeMenu() {
  if ($("menuPanel")) {
    $("menuPanel").hidden = true;
  }
}

/* ---------------------------------------------------------
   BUTTON EVENTS
   --------------------------------------------------------- */

function bindEvents() {
  $("createIdentityForm")?.addEventListener(
    "submit",
    createIdentity
  );

  $("userSearchForm")?.addEventListener(
    "submit",
    searchUser
  );

  $("fileInput")?.addEventListener("change", (event) => {
    handleFiles(event.target.files);
  });

  $("copyUserCodeButton")?.addEventListener(
    "click",
    copyUserCode
  );

  $("shareQrButton")?.addEventListener(
    "click",
    shareQRCode
  );

  $("nearbyShareButton")?.addEventListener(
    "click",
    startNearbyMode
  );

  $("globalShareButton")?.addEventListener(
    "click",
    startGlobalMode
  );

  $("scanQrButton")?.addEventListener(
    "click",
    startQrScanner
  );

  $("sendFilesButton")?.addEventListener(
    "click",
    showTransferUnavailable
  );

  $("pauseTransferButton")?.addEventListener(
    "click",
    pauseTransferUnavailable
  );

  $("resumeTransferButton")?.addEventListener(
    "click",
    resumeTransferUnavailable
  );

  $("cancelTransferButton")?.addEventListener(
    "click",
    cancelTransferUnavailable
  );

  $("clearHistoryButton")?.addEventListener(
    "click",
    clearHistory
  );

  $("menuButton")?.addEventListener(
    "click",
    toggleMenu
  );

  $("historyMenuButton")?.addEventListener("click", () => {
    closeMenu();
    $("historySection")?.scrollIntoView({
      behavior: "smooth"
    });
  });

  $("profileMenuButton")?.addEventListener("click", () => {
    closeMenu();
    $("identitySection")?.scrollIntoView({
      behavior: "smooth"
    });
  });

  $("settingsMenuButton")?.addEventListener("click", () => {
    closeMenu();
    $("transferSection")?.scrollIntoView({
      behavior: "smooth"
    });
  });

  $("logoutButton")?.addEventListener("click", () => {
    notify(
      "Anonymous identity sign-out is not enabled in this version.",
      "error"
    );
    closeMenu();
  });

  $("copyShareLinkButton")?.addEventListener(
    "click",
    async () => {
      const value = $("shareLinkOutput")?.value;

      if (!value) return;

      try {
        await navigator.clipboard.writeText(value);
        notify("Share link copied.");
      } catch {
        notify("Unable to copy the link.", "error");
      }
    }
  );

  $("revokeShareLinkButton")?.addEventListener(
    "click",
    revokeShareLink
  );

  document.querySelectorAll(
    'input[name="compressionMode"]'
  ).forEach((input) => {
    input.addEventListener(
      "change",
      updateCompressionEstimate
    );
  });

  document.addEventListener("click", (event) => {
    const menu = $("menuPanel");
    const button = $("menuButton");

    if (
      menu &&
      !menu.hidden &&
      !menu.contains(event.target) &&
      !button?.contains(event.target)
    ) {
      closeMenu();
    }
  });
}

/* ---------------------------------------------------------
   INITIALIZE
   --------------------------------------------------------- */

function initializeAppUI() {
  safeText(
    $("currentYear"),
    String(new Date().getFullYear())
  );

  bindEvents();
  setupFileDrop();
  updateNetworkStatus();
  updateSendButton();

  startAuthentication();

  console.info("DataLite Share foundation initialized.");
}

initializeAppUI();
