/* =========================================================
   DataLite Share — script.js
   Firebase: celebration-of-life-d3dfa
   Browser P2P foundation
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
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
  runTransaction,
  collection,
  query,
  where,
  limit,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  push,
  onDisconnect,
  onValue,
  onChildAdded
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

/* ---------------- FIREBASE ---------------- */

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

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;
const BUFFER_LIMIT = 1024 * 1024;

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

/* ---------------- APP STATE ---------------- */

const state = {
  user: null,
  profile: null,
  peer: null,
  channel: null,
  requestId: null,
  role: null,
  selectedFiles: [],
  targetUser: null,
  incoming: null,
  sending: false,
  paused: false,
  cancelled: false,
  receivedChunks: [],
  receivedBytes: 0,
  expectedBytes: 0,
  currentFile: null,
  totalBytes: 0,
  transferredBytes: 0,
  startedAt: 0,
  presenceUnsubscribe: null,
  requestUnsubscribe: null,
  candidateUnsubscribers: []
};

/* ---------------- HELPERS ---------------- */

const $ = id => document.getElementById(id);

function text(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value);
}

function visible(id, show) {
  const element = $(id);
  if (element) element.hidden = !show;
}

function notify(message) {
  const area = $("notificationArea");

  if (area) {
    area.textContent = message;
    area.classList.add("show");

    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => {
      area.classList.remove("show");
    }, 4000);
  }

  console.info("[DataLite]", message);
}

function status(message) {
  text("networkStatus", message);
}

function bytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1
  );
  return `${(value / Math.pow(1024, index)).toFixed(2)} ${units[index]}`;
}

function randomCode(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(random, value =>
    alphabet[value % alphabet.length]
  ).join("");
}

function cleanUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9_]{3,20}$/.test(value);
}

function showError(error) {
  console.error(error);
  notify(error?.message || "Something went wrong.");
}

function scrollTo(id) {
  $(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- AUTH AND PROFILE ---------------- */

async function initializeAccount() {
  try {
    status("Connecting to Firebase...");

    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }

    state.user = auth.currentUser;

    if (!state.user) throw new Error("Firebase login failed.");

    const profileRef = doc(db, USERS, state.user.uid);
    const profileSnap = await getDoc(profileRef);

    if (profileSnap.exists()) {
      state.profile = profileSnap.data();
      displayRegisteredIdentity();
      await startPresence();
      loadHistory();
      status("Online");
      text("userStatus", "Online");
    } else {
      visible("guestIdentity", true);
      visible("registeredIdentity", false);
      text("userStatus", "Create ID");
      status("Create your DataLite ID");
    }

    listenForIncomingRequests();
  } catch (error) {
    status("Connection error");
    showError(error);
  }
}

function displayRegisteredIdentity() {
  visible("guestIdentity", false);
  visible("registeredIdentity", true);

  text("displayUserCode", state.profile.userCode);
  text("displayUsername", "@" + state.profile.username);
  text("userStatus", "Online");

  createIdentityQR();
}

async function createIdentity(event) {
  event.preventDefault();

  if (!state.user) {
    notify("Please wait for Firebase connection.");
    return;
  }

  const username = cleanUsername($("usernameInput")?.value);

  if (!validUsername(username)) {
    notify("Use 3–20 letters, numbers or underscores.");
    return;
  }

  const profileRef = doc(db, USERS, state.user.uid);
  const usernameRef = doc(db, USERNAMES, username);
  const userCode = randomCode();

  try {
    await runTransaction(db, async transaction => {
      const existingProfile = await transaction.get(profileRef);
      if (existingProfile.exists()) {
        throw new Error("Your DataLite ID already exists.");
      }

      const existingUsername = await transaction.get(usernameRef);
      if (existingUsername.exists()) {
        throw new Error("This username is already taken.");
      }

      transaction.set(usernameRef, {
        uid: state.user.uid,
        username,
        createdAt: serverTimestamp()
      });

      transaction.set(profileRef, {
        uid: state.user.uid,
        username,
        userCode,
        createdAt: serverTimestamp()
      });
    });

    state.profile = {
      uid: state.user.uid,
      username,
      userCode
    };

    displayRegisteredIdentity();
    await startPresence();

    notify("Your DataLite ID has been created!");
    status("Online");
    text("userStatus", "Online");
  } catch (error) {
    showError(error);
  }
}

/* ---------------- QR ID DISPLAY ---------------- */

function createIdentityQR() {
  const container = $("userQrCode");
  if (!container || !state.profile) return;

  container.replaceChildren();

  const code = document.createElement("strong");
  code.textContent = state.profile.userCode;
  code.style.wordBreak = "break-word";

  const note = document.createElement("small");
  note.textContent = "Your DataLite ID";

  container.append(code, note);
}

async function shareQR() {
  if (!state.profile) {
    notify("Create your DataLite ID first.");
    return;
  }

  const shareData = {
    title: "My DataLite ID",
    text:
      `Connect with me on DataLite Share. My ID: ${state.profile.userCode}`
  };

  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      await navigator.clipboard.writeText(shareData.text);
      notify("ID copied. Share it with your contact.");
    }
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  }
}

async function copyUserCode() {
  if (!state.profile) return;

  try {
    await navigator.clipboard.writeText(state.profile.userCode);
    notify("DataLite ID copied.");
  } catch (_) {
    notify("Please copy your ID manually: " + state.profile.userCode);
  }
}

/* ---------------- PRESENCE ---------------- */

async function startPresence() {
  if (!state.user || !state.profile) return;

  const presenceRef = ref(
    rtdb,
    `${ROOT}/presence/${state.user.uid}`
  );

  await onDisconnect(presenceRef).remove();

  await set(presenceRef, {
    uid: state.user.uid,
    username: state.profile.username,
    userCode: state.profile.userCode,
    online: true,
    lastSeen: Date.now()
  });

  state.presenceUnsubscribe?.();

  state.presenceUnsubscribe = onValue(
    ref(rtdb, `${ROOT}/presence`),
    snapshot => {
      const users = snapshot.val() || {};
      const onlineCount = Object.values(users).filter(
        item => item?.online && item.uid !== state.user.uid
      ).length;

      status(navigator.onLine
        ? `Online · ${onlineCount} users`
        : "Offline");
    },
    error => {
      console.error(error);
      status("Database connection error");
    }
  );
}

/* ---------------- USER SEARCH ---------------- */

async function searchUser(event) {
  event?.preventDefault();

  if (!state.user) {
    notify("Wait for account connection.");
    return;
  }

  const value = String($("searchUserInput")?.value || "").trim();

  if (!value) {
    notify("Enter a username or DataLite ID.");
    return;
  }

  const results = $("searchResults");
  results.replaceChildren();
  results.textContent = "Searching...";

  try {
    let userData = null;

    if (/^[A-Z0-9]{10}$/.test(value.toUpperCase())) {
      const q = query(
        collection(db, USERS),
        where("userCode", "==", value.toUpperCase()),
        limit(1)
      );

      const result = await getDocs(q);
      if (!result.empty) userData = result.docs[0].data();
    } else {
      const username = cleanUsername(value);
      const usernameSnap = await getDoc(
        doc(db, USERNAMES, username)
      );

      if (usernameSnap.exists()) {
        const uid = usernameSnap.data().uid;
        const profileSnap = await getDoc(doc(db, USERS, uid));
        if (profileSnap.exists()) userData = profileSnap.data();
      }
    }

    results.replaceChildren();

    if (!userData) {
      results.textContent = "No DataLite user found.";
      return;
    }

    if (userData.uid === state.user.uid) {
      results.textContent = "This is your own DataLite ID.";
      return;
    }

    state.targetUser = userData;

    const card = document.createElement("div");
    card.className = "user-result";

    const name = document.createElement("strong");
    name.textContent = "@" + userData.username;

    const code = document.createElement("p");
    code.textContent = "ID: " + userData.userCode;

    const connect = document.createElement("button");
    connect.type = "button";
    connect.textContent = "Request Connection";
    connect.addEventListener("click", () => {
      $("receiverCodeInput").value = userData.userCode;
      state.targetUser = userData;
      text("receiverStatus", "Selected: @" + userData.username);
      createConnectionRequest(userData);
    });

    card.append(name, code, connect);
    results.appendChild(card);
  } catch (error) {
    results.textContent = error.message || "Search failed.";
    console.error(error);
  }
}

/* ---------------- RECEIVER LOOKUP ---------------- */

async function lookupReceiver() {
  const value = String($("receiverCodeInput")?.value || "")
    .trim().toUpperCase();

  if (!value) {
    notify("Enter receiver's unique DataLite ID.");
    return null;
  }

  if (!state.user) return null;

  try {
    const q = query(
      collection(db, USERS),
      where("userCode", "==", value),
      limit(1)
    );

    const result = await getDocs(q);

    if (result.empty) {
      text("receiverStatus", "No user found with this ID.");
      state.targetUser = null;
      return null;
    }

    const receiver = result.docs[0].data();

    if (receiver.uid === state.user.uid) {
      text("receiverStatus", "You cannot send files to yourself.");
      return null;
    }

    state.targetUser = receiver;
    text("receiverStatus", "Receiver found: @" + receiver.username);

    return receiver;
  } catch (error) {
    showError(error);
    return null;
  }
}

/* ---------------- REQUEST AND WEBRTC ---------------- */

async function createConnectionRequest(receiver) {
  if (!state.profile) {
    notify("Create your DataLite ID first.");
    return;
  }

  try {
    await closePeer();

    const requestRef = push(ref(rtdb, `${ROOT}/requests`));
    const requestId = requestRef.key;

    const peer = new RTCPeerConnection(ICE_CONFIG);
    state.peer = peer;
    state.requestId = requestId;
    state.role = "sender";

    const channel = peer.createDataChannel("datalite-transfer", {
      ordered: true
    });

    setupDataChannel(channel);
    setupLocalIce(peer, requestId, "sender");

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    await set(requestRef, {
      requestId,
      senderUid: state.user.uid,
      senderName: state.profile.username,
      receiverUid: receiver.uid,
      status: "pending",
      offer: {
        type: offer.type,
        sdp: offer.sdp
      },
      createdAt: Date.now()
    });

    listenForAnswer(requestId, peer);
    listenForRemoteIce(requestId, peer, "receiver");

    notify("Connection request sent to @" + receiver.username);
    text("receiverStatus", "Waiting for receiver to accept...");
  } catch (error) {
    await closePeer();
    showError(error);
  }
}

function listenForIncomingRequests() {
  state.requestUnsubscribe?.();

  state.requestUnsubscribe = onChildAdded(
    ref(rtdb, `${ROOT}/requests`),
    snapshot => {
      const request = snapshot.val();

      if (
        !request ||
        request.receiverUid !== state.user?.uid ||
        request.status !== "pending"
      ) return;

      state.incoming = {
        id: snapshot.key,
        data: request
      };

      text(
        "incomingRequestDetails",
        `@${request.senderName || "DataLite user"} wants to connect.`
      );

      visible("incomingRequestSection", true);
      notify("Incoming connection request.");
    }
  );
}

async function acceptIncomingRequest() {
  if (!state.incoming) return;

  const { id, data } = state.incoming;

  try {
    await closePeer();

    const peer = new RTCPeerConnection(ICE_CONFIG);
    state.peer = peer;
    state.requestId = id;
    state.role = "receiver";

    peer.ondatachannel = event => {
      setupDataChannel(event.channel);
    };

    await peer.setRemoteDescription(data.offer);
    setupLocalIce(peer, id, "receiver");

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    await set(
      ref(rtdb, `${ROOT}/signals/${id}/answer`),
      {
        type: answer.type,
        sdp: answer.sdp
      }
    );

    await update(ref(rtdb, `${ROOT}/requests/${id}`), {
      status: "accepted",
      acceptedAt: Date.now()
    });

    listenForRemoteIce(id, peer, "sender");

    visible("incomingRequestSection", false);
    visible("liveTransferSection", true);
    text("transferStatus", "Connecting");

    notify("Request accepted. Connecting...");
  } catch (error) {
    showError(error);
  }
}

async function rejectIncomingRequest() {
  if (!state.incoming) return;

  try {
    await update(
      ref(rtdb, `${ROOT}/requests/${state.incoming.id}`),
      { status: "rejected", rejectedAt: Date.now() }
    );

    state.incoming = null;
    visible("incomingRequestSection", false);
    notify("Request rejected.");
  } catch (error) {
    showError(error);
  }
}

function setupLocalIce(peer, requestId, role) {
  peer.onicecandidate = event => {
    if (!event.candidate) return;

    const candidateRef = push(
      ref(rtdb, `${ROOT}/signals/${requestId}/${role}Candidates`)
    );

    set(candidateRef, event.candidate.toJSON())
      .catch(console.error);
  };

  peer.onconnectionstatechange = () => {
    const connectionState = peer.connectionState;

    text("transferStatus", connectionState);

    if (connectionState === "connected") {
      visible("liveTransferSection", true);
      notify("Peer connection established.");
    }

    if (
      connectionState === "failed" ||
      connectionState === "disconnected"
    ) {
      notify("Connection interrupted. Check both devices' networks.");
    }
  };
}

function listenForAnswer(requestId, peer) {
  let applied = false;

  onValue(
    ref(rtdb, `${ROOT}/signals/${requestId}/answer`),
    async snapshot => {
      const answer = snapshot.val();

      if (!answer || applied || peer.signalingState === "closed") {
        return;
      }

      applied = true;

      try {
        await peer.setRemoteDescription(answer);
      } catch (error) {
        showError(error);
      }
    }
  );
}

function listenForRemoteIce(requestId, peer, remoteRole) {
  const candidateRef = ref(
    rtdb,
    `${ROOT}/signals/${requestId}/${remoteRole}Candidates`
  );

  const pending = [];
  let remoteReady = false;

  const apply = async candidate => {
    if (!remoteReady || !peer.remoteDescription) {
      pending.push(candidate);
      return;
    }

    try {
      await peer.addIceCandidate(candidate);
    } catch (error) {
      console.warn("ICE candidate:", error);
    }
  };

  const unsubscribe = onChildAdded(candidateRef, snapshot => {
    const candidate = snapshot.val();
    if (candidate) apply(candidate);
  });

  state.candidateUnsubscribers.push(unsubscribe);

  const check = setInterval(async () => {
    if (peer.signalingState === "closed") {
      clearInterval(check);
      return;
    }

    if (peer.remoteDescription && !remoteReady) {
      remoteReady = true;

      while (pending.length) {
        const candidate = pending.shift();
        try {
          await peer.addIceCandidate(candidate);
        } catch (error) {
          console.warn(error);
        }
      }

      clearInterval(check);
    }
  }, 100);
}

/* ---------------- DATA CHANNEL ---------------- */

function setupDataChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    visible("liveTransferSection", true);
    text("transferStatus", "Connected");
    text("transferTitle", "Ready to transfer");
    notify("Connected. You can now send files.");
    updateSendButton();
  };

  channel.onclose = () => {
    text("transferStatus", "Disconnected");
    updateSendButton();
  };

  channel.onerror = error => {
    console.error(error);
    notify("Data channel error.");
  };

  channel.onmessage = event => {
    receiveMessage(event.data);
  };
}

/* ---------------- FILE SELECTION ---------------- */

function selectFiles(event) {
  state.selectedFiles = Array.from(event.target.files || []);

  const container = $("selectedFiles");
  container.replaceChildren();

  if (!state.selectedFiles.length) {
    updateSendButton();
    return;
  }

  const total = state.selectedFiles.reduce(
    (sum, file) => sum + file.size,
    0
  );

  state.selectedFiles.forEach(file => {
    const item = document.createElement("div");
    item.textContent = `${file.name} — ${bytes(file.size)}`;
    container.appendChild(item);
  });

  const summary = document.createElement("p");
  summary.textContent =
    `${state.selectedFiles.length} file(s), total ${bytes(total)}`;

  container.appendChild(summary);

  updateSendButton();
  updateCompressionEstimate();
}

function updateSendButton() {
  const button = $("sendFilesButton");

  if (button) {
    button.disabled = !(
      state.selectedFiles.length &&
      state.profile &&
      navigator.onLine
    );
  }
}

function updateCompressionEstimate() {
  const selected = state.selectedFiles;
  if (!selected.length) {
    visible("compressionResult", false);
    return;
  }

  const total = selected.reduce((sum, file) => sum + file.size, 0);
  text("originalFileSize", bytes(total));
  text("estimatedFileSize", "Not available");

  visible("compressionResult", true);
}

/* ---------------- SEND FILES ---------------- */

async function sendFiles() {
  if (!state.selectedFiles.length) {
    notify("Choose files first.");
    return;
  }

  const receiver = state.targetUser || await lookupReceiver();

  if (!receiver) return;

  const total = state.selectedFiles.reduce(
    (sum, file) => sum + file.size,
    0
  );

  if (total > MAX_FILE_SIZE) {
    notify("This version supports up to 100 MB total per transfer.");
    return;
  }

  if (!state.channel || state.channel.readyState !== "open") {
    await createConnectionRequest(receiver);
    notify("Accept the request on the receiver's device. Transfer will be ready after connection.");
    return;
  }

  await transmitFiles();
}

async function waitForChannelBuffer(channel) {
  while (
    channel.readyState === "open" &&
    channel.bufferedAmount > BUFFER_LIMIT
  ) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }

  if (channel.readyState !== "open") {
    throw new Error("Connection closed.");
  }
}

async function transmitFiles() {
  const channel = state.channel;
  if (!channel || channel.readyState !== "open") {
    notify("No active receiver connection.");
    return;
  }

  state.sending = true;
  state.paused = false;
  state.cancelled = false;
  state.startedAt = Date.now();

  state.totalBytes = state.selectedFiles.reduce(
    (sum, file) => sum + file.size, 0
  );

  state.transferredBytes = 0;

  visible("liveTransferSection", true);
  text("transferTitle", "Sending files");
  text("transferStatus", "Transferring");

  try {
    for (const file of state.selectedFiles) {
      if (state.cancelled) break;

      channel.send(JSON.stringify({
        type: "file-start",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream"
      }));

      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        while (state.paused && !state.cancelled) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }

        if (state.cancelled) break;

        await waitForChannelBuffer(channel);

        const chunk = await file.slice(
          offset,
          Math.min(offset + CHUNK_SIZE, file.size)
        ).arrayBuffer();

        channel.send(chunk);
        state.transferredBytes += chunk.byteLength;
        updateTransferStats();
      }

      if (!state.cancelled) {
        channel.send(JSON.stringify({ type: "file-end" }));
      }
    }

    if (state.cancelled) {
      notify("Transfer cancelled.");
    } else {
      text("transferStatus", "Completed");
      text("transferTitle", "Transfer completed");
      await saveHistory("sent", state.totalBytes);
      notify("Files sent successfully.");
    }
  } catch (error) {
    showError(error);
  } finally {
    state.sending = false;
    state.paused = false;
  }
}

/* ---------------- RECEIVE FILES ---------------- */

function receiveMessage(data) {
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
        mime: message.mime || "application/octet-stream"
      };

      visible("liveTransferSection", true);
      text("transferTitle", "Receiving " + state.currentFile.name);
      text("transferStatus", "Receiving");
      updateReceiveStats();
      return;
    }

    if (message.type === "file-end") {
      finishReceivedFile();
      return;
    }

    if (message.type === "cancel") {
      state.receivedChunks = [];
      state.receivedBytes = 0;
      text("transferStatus", "Cancelled");
      notify("Sender cancelled the transfer.");
      return;
    }

    if (message.type === "pause") {
      text("transferStatus", "Sender paused");
      return;
    }

    if (message.type === "resume") {
      text("transferStatus", "Receiving");
      return;
    }

    return;
  }

  if (data instanceof ArrayBuffer) {
    state.receivedChunks.push(data);
    state.receivedBytes += data.byteLength;
    updateReceiveStats();
  }
}

function finishReceivedFile() {
  if (!state.currentFile) return;

  const blob = new Blob(state.receivedChunks, {
    type: state.currentFile.mime
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = state.currentFile.name;
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 60000);

  const receivedSize = state.receivedBytes;

  state.receivedChunks = [];
  state.receivedBytes = 0;
  state.expectedBytes = 0;
  state.currentFile = null;

  text("transferStatus", "Completed");
  text("transferTitle", "File received");
  saveHistory("received", receivedSize);

  notify("File received. Download should begin.");
}

/* ---------------- PROGRESS ---------------- */

function updateTransferStats() {
  const done = state.transferredBytes;
  const total = state.totalBytes;
  const elapsed = Math.max(0.1, (Date.now() - state.startedAt) / 1000);
  const speed = done / elapsed;
  const remaining = speed > 0 ? (total - done) / speed : 0;
  const percent = total ? done / total * 100 : 0;

  text("dataTransferred", bytes(done));
  text("transferSpeed", bytes(speed) + "/s");
  text("remainingTime", remaining ? Math.ceil(remaining) + " sec" : "Calculating...");
  text("transferPercentage", percent.toFixed(1) + "%");

  const bar = $("transferProgressBar");
  if (bar) bar.style.width = percent + "%";
}

function updateReceiveStats() {
  const percent = state.expectedBytes
    ? Math.min(100, state.receivedBytes / state.expectedBytes * 100)
    : 0;

  text("dataTransferred", bytes(state.receivedBytes));
  text("transferPercentage", percent.toFixed(1) + "%");

  const bar = $("transferProgressBar");
  if (bar) bar.style.width = percent + "%";
}

/* ---------------- PAUSE / RESUME / CANCEL ---------------- */

function pauseTransfer() {
  if (!state.sending || state.paused) {
    notify("No active sending transfer to pause.");
    return;
  }

  state.paused = true;

  try {
    state.channel?.send(JSON.stringify({ type: "pause" }));
  } catch (_) {}

  visible("pauseTransferButton", false);
  visible("resumeTransferButton", true);
  text("transferStatus", "Paused");
}

function resumeTransfer() {
  if (!state.sending || !state.paused) {
    notify("No paused transfer.");
    return;
  }

  state.paused = false;

  try {
    state.channel?.send(JSON.stringify({ type: "resume" }));
  } catch (_) {}

  visible("pauseTransferButton", true);
  visible("resumeTransferButton", false);
  text("transferStatus", "Transferring");
}

function cancelTransfer() {
  state.cancelled = true;
  state.paused = false;

  try {
    if (state.channel?.readyState === "open") {
      state.channel.send(JSON.stringify({ type: "cancel" }));
    }
  } catch (_) {}

  text("transferStatus", "Cancelling");
}

/* ---------------- HISTORY ---------------- */

async function saveHistory(direction, size) {
  if (!state.user) return;

  try {
    const itemRef = push(
      ref(rtdb, `${ROOT}/history/${state.user.uid}`)
    );

    await set(itemRef, {
      direction,
      size,
      createdAt: Date.now()
    });

    loadHistory();
  } catch (error) {
    console.warn("History save failed:", error);
  }
}

async function loadHistory() {
  if (!state.user) return;

  const container = $("transferHistory");

  try {
    const snapshot = await get(
      ref(rtdb, `${ROOT}/history/${state.user.uid}`)
    );

    container.replaceChildren();

    if (!snapshot.exists()) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Your completed transfers will appear here.";
      container.appendChild(empty);
      return;
    }

    const entries = Object.values(snapshot.val())
      .sort((a, b) => b.createdAt - a.createdAt);

    entries.forEach(item => {
      const row = document.createElement("div");
      row.className = "history-item";
      row.textContent =
        `${item.direction === "sent" ? "Sent" : "Received"} · ` +
        `${bytes(item.size)} · ` +
        `${new Date(item.createdAt).toLocaleString()}`;

      container.appendChild(row);
    });
  } catch (error) {
    console.warn("History load failed:", error);
  }
}

async function clearHistory() {
  if (!state.user) return;

  if (!confirm("Clear your DataLite transfer history?")) return;

  try {
    await remove(
      ref(rtdb, `${ROOT}/history/${state.user.uid}`)
    );

    await loadHistory();
    notify("Transfer history cleared.");
  } catch (error) {
    showError(error);
  }
}

/* ---------------- DISCONNECT / LOGOUT ---------------- */

async function closePeer() {
  state.candidateUnsubscribers.forEach(unsubscribe => {
    try { unsubscribe(); } catch (_) {}
  });

  state.candidateUnsubscribers = [];

  try { state.channel?.close(); } catch (_) {}
  try { state.peer?.close(); } catch (_) {}

  state.channel = null;
  state.peer = null;
  state.requestId = null;
  state.role = null;
}

async function logout() {
  try {
    await closePeer();

    state.presenceUnsubscribe?.();
    state.requestUnsubscribe?.();

    if (state.user) {
      await remove(
        ref(rtdb, `${ROOT}/presence/${state.user.uid}`)
      );
    }

    await signOut(auth);

    state.user = null;
    state.profile = null;

    visible("registeredIdentity", false);
    visible("guestIdentity", true);
    text("userStatus", "Offline");
    status("Logged out");

    notify("You have been logged out.");
  } catch (error) {
    showError(error);
  }
}

/* ---------------- QR SCANNER ---------------- */

let cameraStream = null;
let scanInterval = null;

async function scanQR() {
  if (!("BarcodeDetector" in window)) {
    notify("QR scanning is not supported in this browser. Enter the ID manually.");
    return;
  }

  try {
    const video = $("cameraPreview");
    const detector = new BarcodeDetector({ formats: ["qr_code"] });

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });

    video.srcObject = cameraStream;
    video.hidden = false;
    await video.play();

    const scanner = $("qrScanner");
    scanner.replaceChildren();

    const message = document.createElement("p");
    message.textContent = "Point your camera at a DataLite QR code.";
    scanner.appendChild(message);
    visible("qrScanner", true);

    scanInterval = setInterval(async () => {
      if (video.readyState < 2) return;

      try {
        const codes = await detector.detect(video);

        if (codes.length) {
          const value = codes[0].rawValue.trim();

          $("searchUserInput").value = value;
          stopQRScanner();
          searchUser();

          notify("QR code scanned.");
        }
      } catch (error) {
        console.warn(error);
      }
    }, 700);
  } catch (error) {
    showError(error);
  }
}

function stopQRScanner() {
  if (scanInterval) clearInterval(scanInterval);
  scanInterval = null;

  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;

  const video = $("cameraPreview");
  if (video) {
    video.srcObject = null;
    video.hidden = true;
  }

  visible("qrScanner", false);
}

/* ---------------- MENU AND NAVIGATION ---------------- */

function toggleMenu() {
  const panel = $("menuPanel");
  if (panel) panel.hidden = !panel.hidden;
}

function closeMenu() {
  visible("menuPanel", false);
}

function menuNavigate(target) {
  closeMenu();
  scrollTo(target);
}

function startSending() {
  scrollTo("transferSection");
  $("fileInput")?.click();
}

function receiveFiles() {
  scrollTo("incomingRequestSection");

  if (!state.incoming) {
    notify("Waiting for someone to send you a connection request.");
  }
}

function connectWorldwide() {
  scrollTo("userSearchSection");
  $("searchUserInput")?.focus();
  notify("Search for a DataLite username or unique ID.");
}

function nearbySharing() {
  const panel = $("nearbyDevices");
  visible("nearbyDevices", true);

  if (panel) {
    panel.textContent =
      "Nearby Wi-Fi Direct sharing requires a native Android app. " +
      "This browser version cannot discover nearby devices without internet.";
  }

  notify("Native Android nearby sharing is not available in this web version.");
}

/* ---------------- SHARE LINKS / COMPRESSION ---------------- */

function explainShareLink() {
  notify(
    "Temporary share links are not enabled yet. " +
    "Secure link creation needs additional server-side authorization."
  );
}

function revokeShareLink() {
  notify("No active share link exists to revoke.");
}

function copyShareLink() {
  notify("No share link has been generated.");
}

function compressionChanged() {
  const mode = document.querySelector(
    'input[name="compressionMode"]:checked'
  )?.value || "original";

  if (mode === "original") {
    notify("Original Quality selected. Files will be sent unchanged.");
  } else {
    notify(
      "Compression engine is not installed yet. " +
      "Files will still be sent unchanged."
    );
  }

  updateCompressionEstimate();
}

/* ---------------- BUTTON EVENTS ---------------- */

function bindEvents() {
  $("createIdentityForm")?.addEventListener("submit", createIdentity);
  $("userSearchForm")?.addEventListener("submit", searchUser);

  $("menuButton")?.addEventListener("click", toggleMenu);
  $("startSendingButton")?.addEventListener("click", startSending);
  $("receiveButton")?.addEventListener("click", receiveFiles);

  $("nearbyShareButton")?.addEventListener("click", nearbySharing);
  $("globalShareButton")?.addEventListener("click", connectWorldwide);

  $("copyUserCodeButton")?.addEventListener("click", copyUserCode);
  $("shareQrButton")?.addEventListener("click", shareQR);

  $("scanQrButton")?.addEventListener("click", scanQR);

  $("fileInput")?.addEventListener("change", selectFiles);
  $("sendFilesButton")?.addEventListener("click", sendFiles);

  $("acceptTransferButton")?.addEventListener(
    "click",
    acceptIncomingRequest
  );

  $("rejectTransferButton")?.addEventListener(
    "click",
    rejectIncomingRequest
  );

  $("pauseTransferButton")?.addEventListener("click", pauseTransfer);
  $("resumeTransferButton")?.addEventListener("click", resumeTransfer);
  $("cancelTransferButton")?.addEventListener("click", cancelTransfer);

  $("clearHistoryButton")?.addEventListener("click", clearHistory);

  $("profileMenuButton")?.addEventListener("click", () => {
    closeMenu();
    scrollTo("identitySection");
  });

  $("historyMenuButton")?.addEventListener("click", () => {
    menuNavigate("historySection");
    loadHistory();
  });

  $("settingsMenuButton")?.addEventListener("click", () => {
    closeMenu();
    scrollTo("transferSection");
  });

  $("logoutButton")?.addEventListener("click", logout);

  $("copyShareLinkButton")?.addEventListener("click", copyShareLink);
  $("revokeShareLinkButton")?.addEventListener("click", revokeShareLink);

  document.querySelectorAll('input[name="compressionMode"]')
    .forEach(input => {
      input.addEventListener("change", compressionChanged);
    });

  $("receiverCodeInput")?.addEventListener("change", lookupReceiver);

  $("fileDropArea")?.addEventListener("dragover", event => {
    event.preventDefault();
  });

  $("fileDropArea")?.addEventListener("drop", event => {
    event.preventDefault();

    const files = Array.from(event.dataTransfer?.files || []);
    state.selectedFiles = files;

    const transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));

    $("fileInput").files = transfer.files;

    selectFiles({ target: $("fileInput") });
  });

  document.addEventListener("click", event => {
    const panel = $("menuPanel");
    const button = $("menuButton");

    if (
      panel &&
      !panel.hidden &&
      !panel.contains(event.target) &&
      !button?.contains(event.target)
    ) {
      closeMenu();
    }
  });

  text("currentYear", new Date().getFullYear());
}

/* ---------------- NETWORK EVENTS ---------------- */

window.addEventListener("online", () => {
  status("Internet restored");
  updateSendButton();
});

window.addEventListener("offline", () => {
  status("Offline");
  updateSendButton();
});

window.addEventListener("beforeunload", () => {
  stopQRScanner();
  closePeer();
});

/* ---------------- START ---------------- */

bindEvents();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js")
    .catch(error => console.warn("Service worker:", error));
}

initializeAccount();
