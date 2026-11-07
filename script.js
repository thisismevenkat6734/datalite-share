/*
 * DataLite Share
 * Firebase project: celebration-of-life-d3dfa
 * Version: 1.0.0 - P2P foundation
 *
 * Uses separate DataLite paths and collections.
 * No Cloud Storage is used for file transfer.
 *
 * Current transfer mode:
 * WebRTC DataChannel + in-memory receiver buffer.
 * Not suitable for very large files yet.
 */

import { initializeApp } from
  "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  limit,
  getDocs,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onChildAdded,
  onDisconnect,
  push,
  runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

/* -------------------- CONFIGURATION -------------------- */

const firebaseConfig = {
  apiKey: "AIzaSyCm2ZwhbLg6SSY2qwAiOdMDx1i8sJjIQ",
  authDomain: "celebration-of-life-d3dfa.firebaseapp.com",
  projectId: "celebration-of-life-d3dfa",
  storageBucket: "celebration-of-life-d3dfa.firebasestorage.app",
  messagingSenderId: "808280368245",
  appId: "1:808280368245:web:a92fec777882dbf61a043c",
  measurementId: "G-PX41M3M7S5",
  databaseURL:
    "https://celebration-of-life-d3dfa-default-rtdb.asia-southeast1.firebasedatabase.app/"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);

const USERS = "dataliteShareUsers";
const USERNAMES = "dataliteShareUsernames";
const ROOT = "dataliteShare";

const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;
const MAX_IN_MEMORY_FILE_SIZE = 100 * 1024 * 1024;

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

/* -------------------- STATE -------------------- */

const state = {
  user: null,
  profile: null,
  peer: null,
  channel: null,
  activeRequestId: null,
  activeRole: null,
  selectedFiles: [],
  receivedChunks: [],
  receivedBytes: 0,
  expectedBytes: 0,
  currentFile: null,
  sending: false,
  cancelled: false,
  incomingRequests: new Map(),
  unsubscribePresence: null,
  unsubscribeRequests: null,
  unsubscribeSignals: null,
  transferStartedAt: 0,
  sentBytes: 0,
  totalBytes: 0
};

/* -------------------- DOM HELPERS -------------------- */

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function setValue(id, value) {
  const el = $(id);
  if (el) el.value = value;
}

function show(id, visible = true) {
  const el = $(id);
  if (el) el.hidden = !visible;
}

function setStatus(message) {
  const ids = [
    "statusMessage",
    "connectionStatus",
    "transferStatus"
  ];

  ids.forEach(id => {
    if ($(id)) setText(id, message);
  });

  console.info("[DataLite]", message);
}

function notify(message) {
  setStatus(message);
  if ("Notification" in window &&
      Notification.permission === "granted") {
    try {
      new Notification("DataLite Share", { body: message });
    } catch (_) {}
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  return (
    (bytes / Math.pow(1024, index)).toFixed(2) +
    " " +
    units[index]
  );
}

function safeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
}

function randomCode(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));

  return Array.from(bytes)
    .map(byte => chars[byte % chars.length])
    .join("");
}

function getErrorMessage(error) {
  console.error(error);
  return error?.message || "Something went wrong.";
}

/* -------------------- AUTHENTICATION -------------------- */

async function authenticate() {
  if (auth.currentUser) return auth.currentUser;

  const result = await signInAnonymously(auth);
  return result.user;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  state.user = user;

  try {
    await loadOrCreateProfile(user);
    await startPresence();
    listenForIncomingRequests();

    setStatus("Connected to DataLite Share.");
    setText("userId", user.uid);

    if (state.profile) {
      setText("username", "@" + state.profile.username);
      setText("userCode", state.profile.userCode);
    }

    generateUserQR();
  } catch (error) {
    setStatus("Account setup failed: " + getErrorMessage(error));
  }
});

/* -------------------- USER PROFILE -------------------- */

async function loadOrCreateProfile(user) {
  const profileRef = doc(db, USERS, user.uid);
  const snapshot = await getDoc(profileRef);

  if (snapshot.exists()) {
    state.profile = snapshot.data();
    return state.profile;
  }

  const username = "user_" + randomCode(7).toLowerCase();
  const userCode = randomCode(10);

  const usernameRef = doc(db, USERNAMES, username);

  await setDoc(usernameRef, {
    uid: user.uid,
    createdAt: serverTimestamp()
  });

  const profile = {
    uid: user.uid,
    username,
    userCode,
    displayName: "DataLite User",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await setDoc(profileRef, profile);
  state.profile = profile;

  return profile;
}

async function changeUsername() {
  if (!state.user) {
    notify("Please wait for account setup.");
    return;
  }

  const input =
    $("newUsername")?.value ||
    $("usernameInput")?.value;

  const username = safeUsername(input);

  if (username.length < 4) {
    notify("Username must contain at least 4 characters.");
    return;
  }

  const oldUsername = state.profile.username;

  if (username === oldUsername) {
    notify("This is already your username.");
    return;
  }

  const usernameRef = doc(db, USERNAMES, username);

  try {
    const result = await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(usernameRef);

      if (existing.exists()) {
        throw new Error("Username is already taken.");
      }

      transaction.set(usernameRef, {
        uid: state.user.uid,
        createdAt: serverTimestamp()
      });

      transaction.update(doc(db, USERS, state.user.uid), {
        username,
        updatedAt: serverTimestamp()
      });
    });

    await setDoc(
      doc(db, USERNAMES, oldUsername),
      { uid: state.user.uid, retired: true },
      { merge: true }
    );

    state.profile.username = username;
    setText("username", "@" + username);
    notify("Username updated.");
  } catch (error) {
    notify(getErrorMessage(error));
  }
}

/* -------------------- USER QR -------------------- */

function generateUserQR() {
  const qrElement =
    $("userQRCode") ||
    $("qrCode") ||
    $("qrContainer");

  if (!qrElement || !state.profile) return;

  qrElement.replaceChildren();

  const identity = state.profile.userCode;

  if (typeof QRCode === "undefined") {
    qrElement.textContent = identity;
    return;
  }

  try {
    new QRCode(qrElement, {
      text: identity,
      width: 180,
      height: 180,
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (error) {
    console.error("QR generation failed", error);
    qrElement.textContent = identity;
  }
}

/* -------------------- ONLINE PRESENCE -------------------- */

async function startPresence() {
  const uid = state.user.uid;
  const presenceRef = ref(rtdb, `${ROOT}/presence/${uid}`);

  await onDisconnect(presenceRef).remove();

  await set(presenceRef, {
    uid,
    username: state.profile.username,
    userCode: state.profile.userCode,
    online: true,
    lastSeen: Date.now()
  });

  if (state.unsubscribePresence) {
    state.unsubscribePresence();
  }

  state.unsubscribePresence = onValue(
    ref(rtdb, `${ROOT}/presence`),
    snapshot => {
      renderPresence(snapshot.val() || {});
    }
  );
}

function renderPresence(presence) {
  const container =
    $("nearbyUsersList") ||
    $("onlineUsersList");

  if (!container) return;

  container.replaceChildren();

  const users = Object.values(presence)
    .filter(item =>
      item &&
      item.uid !== state.user?.uid &&
      item.online === true
    );

  if (!users.length) {
    container.textContent = "No other users online.";
    return;
  }

  users.forEach(user => {
    const row = document.createElement("div");
    row.className = "user-result";

    const name = document.createElement("span");
    name.textContent = "@" + (user.username || "user");

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Connect";
    button.addEventListener("click", () => {
      createConnectionRequest(user.uid);
    });

    row.append(name, button);
    container.appendChild(row);
  });
}

/* -------------------- GLOBAL USER SEARCH -------------------- */

async function searchUsers() {
  const input =
    $("userSearchInput") ||
    $("searchUserInput");

  const queryText = safeUsername(input?.value);

  const results =
    $("searchResults") ||
    $("userSearchResults");

  if (!queryText || !results) return;

  results.textContent = "Searching...";

  try {
    const usersQuery = query(
      collection(db, USERS),
      where("username", ">=", queryText),
      where("username", "<=", queryText + "\uf8ff"),
      limit(15)
    );

    const snapshot = await getDocs(usersQuery);
    results.replaceChildren();

    if (snapshot.empty) {
      results.textContent = "No matching users found.";
      return;
    }

    snapshot.forEach(item => {
      const user = item.data();

      if (user.uid === state.user.uid) return;

      const row = document.createElement("div");
      row.className = "user-result";

      const name = document.createElement("span");
      name.textContent = "@" + user.username;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Connect";
      button.addEventListener("click", () => {
        createConnectionRequest(user.uid);
      });

      row.append(name, button);
      results.appendChild(row);
    });
  } catch (error) {
    results.textContent = getErrorMessage(error);
  }
}

/* -------------------- CONNECTION REQUESTS -------------------- */

async function createConnectionRequest(receiverUid) {
  if (!state.user || receiverUid === state.user.uid) return;

  try {
    const requestRef = push(ref(rtdb, `${ROOT}/requests`));
    const requestId = requestRef.key;

    const peer = new RTCPeerConnection(ICE_SERVERS);
    state.peer = peer;
    state.activeRequestId = requestId;
    state.activeRole = "sender";

    const channel = peer.createDataChannel("datalite-file-transfer", {
      ordered: true
    });

    setupDataChannel(channel);

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    await set(requestRef, {
      requestId,
      senderUid: state.user.uid,
      senderName: state.profile.username,
      receiverUid,
      status: "pending",
      offer: {
        type: offer.type,
        sdp: offer.sdp
      },
      createdAt: Date.now()
    });

    listenForSenderAnswer(requestId, peer);
    listenForIceCandidates(requestId, peer, "receiver");

    peer.onicecandidate = event => {
      if (event.candidate) {
        set(
          ref(
            rtdb,
            `${ROOT}/signals/${requestId}/senderCandidates/${push(ref(rtdb, `${ROOT}/signals/${requestId}/senderCandidates`)).key}`
          ),
          event.candidate.toJSON()
        ).catch(console.error);
      }
    };

    setStatus("Connection request sent. Waiting for acceptance.");
  } catch (error) {
    closePeer();
    notify("Could not create request: " + getErrorMessage(error));
  }
}

function listenForIncomingRequests() {
  const requestsRef = ref(rtdb, `${ROOT}/requests`);

  if (state.unsubscribeRequests) {
    state.unsubscribeRequests();
  }

  state.unsubscribeRequests = onChildAdded(
    requestsRef,
    snapshot => {
      const request = snapshot.val();

      if (!request ||
          request.receiverUid !== state.user.uid ||
          request.status !== "pending") {
        return;
      }

      state.incomingRequests.set(snapshot.key, request);
      showIncomingRequest(snapshot.key, request);
    }
  );
}

function showIncomingRequest(requestId, request) {
  const container =
    $("incomingRequest") ||
    $("incomingRequestSection");

  if (!container) {
    notify("Incoming connection request from @" + request.senderName);
    return;
  }

  show(container.id, true);

  setText(
    "incomingRequestText",
    "@" + (request.senderName || "user") + " wants to connect."
  );

  const acceptButton = $("acceptRequestButton");
  const rejectButton = $("rejectRequestButton");

  if (acceptButton) {
    acceptButton.onclick = () => acceptConnectionRequest(requestId);
  }

  if (rejectButton) {
    rejectButton.onclick = () => rejectConnectionRequest(requestId);
  }
}

async function acceptConnectionRequest(requestId) {
  const request = state.incomingRequests.get(requestId);
  if (!request) return;

  try {
    const peer = new RTCPeerConnection(ICE_SERVERS);

    state.peer = peer;
    state.activeRequestId = requestId;
    state.activeRole = "receiver";

    peer.ondatachannel = event => {
      setupDataChannel(event.channel);
    };

    await peer.setRemoteDescription(
      new RTCSessionDescription(request.offer)
    );

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    peer.onicecandidate = event => {
      if (event.candidate) {
        const candidateRef = push(
          ref(rtdb, `${ROOT}/signals/${requestId}/receiverCandidates`)
        );

        set(candidateRef, event.candidate.toJSON())
          .catch(console.error);
      }
    };

    await set(
      ref(rtdb, `${ROOT}/signals/${requestId}/answer`),
      {
        type: answer.type,
        sdp: answer.sdp
      }
    );

    await update(ref(rtdb, `${ROOT}/requests/${requestId}`), {
      status: "accepted",
      acceptedAt: Date.now()
    });

    listenForIceCandidates(requestId, peer, "sender");

    setStatus("Connecting to sender...");
    show("incomingRequest", false);
  } catch (error) {
    notify("Could not accept request: " + getErrorMessage(error));
  }
}

async function rejectConnectionRequest(requestId) {
  try {
    await update(
      ref(rtdb, `${ROOT}/requests/${requestId}`),
      { status: "rejected", rejectedAt: Date.now() }
    );

    state.incomingRequests.delete(requestId);
    show("incomingRequest", false);
    notify("Request rejected.");
  } catch (error) {
    notify(getErrorMessage(error));
  }
}

function listenForSenderAnswer(requestId, peer) {
  const answerRef = ref(
    rtdb,
    `${ROOT}/signals/${requestId}/answer`
  );

  let applied = false;

  onValue(answerRef, async snapshot => {
    const answer = snapshot.val();

    if (!answer || applied || peer.signalingState === "closed") {
      return;
    }

    applied = true;

    try {
      await peer.setRemoteDescription(
        new RTCSessionDescription(answer)
      );
      setStatus("Answer received. Establishing connection...");
    } catch (error) {
      notify("Answer error: " + getErrorMessage(error));
    }
  });
}

function listenForIceCandidates(requestId, peer, remoteRole) {
  const path =
    remoteRole === "sender"
      ? "senderCandidates"
      : "receiverCandidates";

  const candidatesRef = ref(
    rtdb,
    `${ROOT}/signals/${requestId}/${path}`
  );

  const pending = [];

  const applyCandidate = async candidate => {
    try {
      if (!peer.remoteDescription) {
        pending.push(candidate);
        return;
      }

      await peer.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (error) {
      console.warn("ICE candidate error", error);
    }
  };

  onChildAdded(candidatesRef, snapshot => {
    const candidate = snapshot.val();
    if (candidate) applyCandidate(candidate);
  });

  peer.addEventListener("signalingstatechange", async () => {
    if (!peer.remoteDescription) return;

    while (pending.length) {
      const candidate = pending.shift();

      try {
        await peer.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      } catch (error) {
        console.warn(error);
      }
    }
  });
}

/* -------------------- FILE SELECTION -------------------- */

function handleFileSelection(event) {
  const files = Array.from(event.target.files || []);

  state.selectedFiles = files;

  const list =
    $("selectedFilesList") ||
    $("fileList");

  if (!list) return;

  list.replaceChildren();

  files.forEach(file => {
    const item = document.createElement("div");
    item.textContent =
      `${file.name} — ${formatBytes(file.size)}`;

    list.appendChild(item);
  });

  const total = files.reduce((sum, file) => sum + file.size, 0);

  setText("selectedFileCount", files.length);
  setText("selectedFileSize", formatBytes(total));

  notify(files.length + " file(s) selected.");
}

/* -------------------- DATA CHANNEL -------------------- */

function setupDataChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    setStatus("Peer connected. Ready to transfer.");
    show("transferDashboard", true);
  };

  channel.onclose = () => {
    setStatus("Peer connection closed.");
  };

  channel.onerror = error => {
    console.error("Data channel error", error);
    notify("Transfer connection error.");
  };

  channel.onmessage = event => {
    handleIncomingMessage(event.data);
  };
}

function handleIncomingMessage(data) {
  if (typeof data === "string") {
    let message;

    try {
      message = JSON.parse(data);
    } catch (_) {
      return;
    }

    if (message.type === "file-start") {
      state.receivedChunks = [];
      state.receivedBytes = 0;
      state.expectedBytes = Number(message.size) || 0;
      state.currentFile = {
        name: String(message.name || "received-file")
          .replace(/[\\/:*?"<>|]/g, "_"),
        type: String(message.mime || "application/octet-stream")
      };

      setText("transferStatus", "Receiving " + state.currentFile.name);
      setText("transferProgress", "0%");
      return;
    }

    if (message.type === "file-end") {
      finishReceivingFile();
      return;
    }

    if (message.type === "cancel") {
      state.receivedChunks = [];
      state.receivedBytes = 0;
      notify("Sender cancelled the transfer.");
      return;
    }

    if (message.type === "ping") {
      state.channel?.send(JSON.stringify({
        type: "pong",
        time: message.time
      }));
    }

    return;
  }

  if (data instanceof ArrayBuffer) {
    state.receivedChunks.push(data);
    state.receivedBytes += data.byteLength;

    const percent = state.expectedBytes
      ? Math.min(
          100,
          (state.receivedBytes / state.expectedBytes) * 100
        )
      : 0;

    updateProgress(percent, state.receivedBytes, state.expectedBytes);
  }
}

function finishReceivingFile() {
  if (!state.currentFile) return;

  const blob = new Blob(state.receivedChunks, {
    type: state.currentFile.type
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = state.currentFile.name;
  link.style.display = "none";

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 60000);

  state.receivedChunks = [];
  state.receivedBytes = 0;
  state.expectedBytes = 0;
  state.currentFile = null;

  notify("File received. Download started.");
}

/* -------------------- SENDING FILES -------------------- */

async function waitForBuffer(channel) {
  while (
    channel.readyState === "open" &&
    channel.bufferedAmount > MAX_BUFFERED_AMOUNT
  ) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  if (channel.readyState !== "open") {
    throw new Error("Connection closed during transfer.");
  }
}

async function sendSelectedFiles() {
  const channel = state.channel;

  if (!channel || channel.readyState !== "open") {
    notify("Connect to another user first.");
    return;
  }

  if (!state.selectedFiles.length) {
    notify("Select at least one file.");
    return;
  }

  const total = state.selectedFiles.reduce(
    (sum, file) => sum + file.size,
    0
  );

  state.totalBytes = total;
  state.sentBytes = 0;
  state.cancelled = false;
  state.sending = true;
  state.transferStartedAt = Date.now();

  if (total > MAX_IN_MEMORY_FILE_SIZE) {
    notify(
      "This first version is limited to files up to 100 MB. " +
      "Large-file disk streaming is not implemented yet."
    );
    state.sending = false;
    return;
  }

  try {
    for (const file of state.selectedFiles) {
      if (state.cancelled) break;

      channel.send(JSON.stringify({
        type: "file-start",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream"
      }));

      for (
        let offset = 0;
        offset < file.size;
        offset += CHUNK_SIZE
      ) {
        if (state.cancelled) break;

        await waitForBuffer(channel);

        const chunk = file.slice(
          offset,
          Math.min(offset + CHUNK_SIZE, file.size)
        );

        const buffer = await chunk.arrayBuffer();

        channel.send(buffer);
        state.sentBytes += buffer.byteLength;

        const percent = total
          ? (state.sentBytes / total) * 100
          : 100;

        updateProgress(percent, state.sentBytes, total);
      }

      if (!state.cancelled) {
        channel.send(JSON.stringify({ type: "file-end" }));
      }
    }

    if (state.cancelled) {
      channel.send(JSON.stringify({ type: "cancel" }));
      notify("Transfer cancelled.");
    } else {
      notify("All selected files sent.");
      saveTransferHistory("sent", total);
    }
  } catch (error) {
    notify("Transfer failed: " + getErrorMessage(error));
  } finally {
    state.sending = false;
  }
}

function updateProgress(percent, transferred, total) {
  const safePercent = Math.max(0, Math.min(100, percent));

  const bar =
    $("transferProgressBar") ||
    $("progressBar");

  if (bar) {
    if ("value" in bar) {
      bar.value = safePercent;
    } else {
      bar.style.width = safePercent + "%";
    }
  }

  setText("transferProgress", safePercent.toFixed(1) + "%");
  setText(
    "transferBytes",
    formatBytes(transferred) + " / " + formatBytes(total)
  );

  const elapsed = Math.max(
    1,
    (Date.now() - state.transferStartedAt) / 1000
  );

  const speed = transferred / elapsed;

  setText("transferSpeed", formatBytes(speed) + "/s");
}

/* -------------------- CANCEL -------------------- */

function cancelTransfer() {
  state.cancelled = true;

  if (state.channel?.readyState === "open") {
    try {
      state.channel.send(JSON.stringify({ type: "cancel" }));
    } catch (_) {}
  }

  setStatus("Cancelling transfer...");
}

/* -------------------- TRANSFER HISTORY -------------------- */

async function saveTransferHistory(direction, bytes) {
  if (!state.user) return;

  try {
    const historyRef = push(
      ref(rtdb, `${ROOT}/history/${state.user.uid}`)
    );

    await set(historyRef, {
      direction,
      bytes,
      createdAt: Date.now()
    });
  } catch (error) {
    console.warn("History could not be saved:", error);
  }
}

async function loadTransferHistory() {
  if (!state.user) return;

  try {
    const snapshot = await get(
      ref(rtdb, `${ROOT}/history/${state.user.uid}`)
    );

    const container =
      $("transferHistory") ||
      $("historyList");

    if (!container) return;

    container.replaceChildren();

    if (!snapshot.exists()) {
      container.textContent = "No transfer history yet.";
      return;
    }

    const history = Object.values(snapshot.val())
      .sort((a, b) => b.createdAt - a.createdAt);

    history.forEach(item => {
      const row = document.createElement("div");
      row.textContent =
        `${item.direction} · ${formatBytes(item.bytes)} · ` +
        new Date(item.createdAt).toLocaleString();

      container.appendChild(row);
    });
  } catch (error) {
    notify("Could not load history: " + getErrorMessage(error));
  }
}

/* -------------------- DISCONNECT -------------------- */

async function closePeer() {
  try {
    if (state.channel) {
      state.channel.close();
    }

    if (state.peer) {
      state.peer.close();
    }
  } catch (_) {}

  state.channel = null;
  state.peer = null;
  state.activeRequestId = null;
  state.activeRole = null;
  state.sending = false;
}

async function disconnectPeer() {
  const requestId = state.activeRequestId;

  await closePeer();

  if (requestId) {
    try {
      await update(
        ref(rtdb, `${ROOT}/requests/${requestId}`),
        { status: "closed", closedAt: Date.now() }
      );
    } catch (_) {}
  }

  setStatus("Disconnected.");
}

/* -------------------- LOGOUT -------------------- */

async function logout() {
  try {
    await closePeer();

    if (state.unsubscribePresence) {
      state.unsubscribePresence();
    }

    if (state.unsubscribeRequests) {
      state.unsubscribeRequests();
    }

    await signOut(auth);
    notify("Logged out.");
  } catch (error) {
    notify(getErrorMessage(error));
  }
}

/* -------------------- CAMERA QR SCANNER -------------------- */

let cameraStream = null;
let scanTimer = null;

async function startQRScanner() {
  const video = $("cameraPreview");

  if (!video) {
    notify("Camera preview element not found.");
    return;
  }

  if (!("BarcodeDetector" in window)) {
    notify(
      "QR scanning is not supported by this browser. " +
      "Use your phone camera to scan the QR code."
    );
    return;
  }

  try {
    const detector = new BarcodeDetector({
      formats: ["qr_code"]
    });

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });

    video.srcObject = cameraStream;
    await video.play();

    show("cameraPreview", true);

    scanTimer = setInterval(async () => {
      if (video.readyState < 2) return;

      try {
        const codes = await detector.detect(video);

        if (codes.length) {
          const value = codes[0].rawValue;
          setValue("userSearchInput", value);
          stopQRScanner();
          notify("QR code detected: " + value);
        }
      } catch (error) {
        console.warn(error);
      }
    }, 700);
  } catch (error) {
    notify("Camera error: " + getErrorMessage(error));
  }
}

function stopQRScanner() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
  }

  cameraStream = null;

  const video = $("cameraPreview");
  if (video) video.srcObject = null;
}

/* -------------------- BUTTON BINDINGS -------------------- */

function bind(id, event, handler) {
  const element = $(id);
  if (element) {
    element.addEventListener(event, handler);
  }
}

function bindFirst(ids, event, handler) {
  for (const id of ids) {
    const element = $(id);

    if (element) {
      element.addEventListener(event, handler);
      return;
    }
  }
}

function setupUI() {
  bindFirst(
    ["fileInput", "fileUploadInput", "selectFiles"],
    "change",
    handleFileSelection
  );

  bindFirst(
    ["sendFileButton", "sendButton", "startTransferButton"],
    "click",
    sendSelectedFiles
  );

  bindFirst(
    ["cancelTransferButton", "cancelButton"],
    "click",
    cancelTransfer
  );

  bindFirst(
    ["searchUserButton", "searchButton"],
    "click",
    searchUsers
  );

  bindFirst(
    ["updateUsernameButton", "saveUsernameButton"],
    "click",
    changeUsername
  );

  bindFirst(
    ["disconnectButton", "endConnectionButton"],
    "click",
    disconnectPeer
  );

  bindFirst(
    ["logoutButton", "signOutButton"],
    "click",
    logout
  );

  bindFirst(
    ["scanQRButton", "startScanButton"],
    "click",
    startQRScanner
  );

  bindFirst(
    ["stopScanButton"],
    "click",
    stopQRScanner
  );

  bindFirst(
    ["historyButton", "viewHistoryButton"],
    "click",
    loadTransferHistory
  );

  bindFirst(
    ["globalShareButton"],
    "click",
    () => {
      const searchInput = $("userSearchInput");
      if (searchInput?.value) {
        searchUsers();
      } else {
        notify("Enter a username to find someone.");
      }
    }
  );

  bindFirst(
    ["nearbyShareButton", "nearbyButton"],
    "click",
    () => {
      notify(
        "Browser-based nearby Wi-Fi Direct is not available. " +
        "This feature needs a native Android implementation."
      );
    }
  );

  bindFirst(
    ["compressionSelect", "compressionMode"],
    "change",
    () => {
      notify(
        "Compression engine is not included in this version. " +
        "Files are sent unchanged."
      );
    }
  );

  bind("userSearchInput", "keydown", event => {
    if (event.key === "Enter") searchUsers();
  });

  bind("searchUserInput", "keydown", event => {
    if (event.key === "Enter") searchUsers();
  });

  if ("Notification" in window &&
      Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

/* -------------------- START APPLICATION -------------------- */

async function startApp() {
  setupUI();

  if (!navigator.onLine) {
    setStatus("Internet connection required for global sharing.");
  }

  if (!window.isSecureContext) {
    console.warn(
      "DataLite Share requires HTTPS for camera and WebRTC features."
    );
  }

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./service-worker.js");
    } catch (error) {
      console.warn("Service worker registration failed:", error);
    }
  }

  try {
    await authenticate();
  } catch (error) {
    setStatus("Firebase login failed: " + getErrorMessage(error));
  }
}

window.addEventListener("online", () => {
  setStatus("Internet connection restored.");
});

window.addEventListener("offline", () => {
  setStatus("Internet connection lost.");
});

window.addEventListener("beforeunload", () => {
  stopQRScanner();
  closePeer();
});

startApp();
