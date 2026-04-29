/* ═══════════════════════════════════════════════════
   InBetween — app.js
   ═══════════════════════════════════════════════════ */

// ── CONSTANTS ────────────────────────────────────────
const SILENCE_MS = 5000;
const SPEAKING_RMS = 0.018;
const SPEAKING_HOLD_MS = 800;

const LIP_THRESHOLD = 0.028;
const LEAN_THRESHOLD = 1.06;
const GAZE_THRESHOLD = 0.045;

const ORBIT_SPEED = 0.0025;
const CUE_TOPIC = "inbetween-cue-state";

// ── STATE ─────────────────────────────────────────────
let livekitRoom = null;
let localIdentity = "";
let roomName = "";
let meetingTitle = "";

const pMap = new Map();

let currentSpeaker = null;
let heldSpeaker = null;

let circleModeFeature = true;
let isCircleMode = false;
let silenceTimer = null;
let orbitAngle = 0;
let orbitRafId = null;

let audioCtx = null;
let analyserNode = null;
let localSpeakingTimer = null;
let localSpeaking = false;

let faceLandmarker = null;
let mpRunning = false;
let mpRafId = null;
let baselineFaceScale = null;

const CUE = { lip: false, lean: false, gaze: false };

let lastCueSentAt = 0;
let lastCueSignature = "";

// ── DOM HELPERS ───────────────────────────────────────
const $ = (id) => document.getElementById(id);
const tilesContainer = () => $("tiles-container");

function showToast(msg, ms = 2000) {
  let t = document.querySelector(".toast");

  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }

  t.textContent = msg;
  t.classList.add("show");

  setTimeout(() => t.classList.remove("show"), ms);
}

function makeUniqueIdentity(name) {
  const safeName = String(name || "Participant")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "");

  const random =
    crypto && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);

  return `${safeName || "Participant"}-${random}`;
}

function getCueSpeakerId() {
  return currentSpeaker || heldSpeaker;
}

function showAudioPrompt() {
  let prompt = document.getElementById("audio-prompt");
  if (prompt) return;

  prompt = document.createElement("div");
  prompt.id = "audio-prompt";
  prompt.style.cssText = `
    position:fixed;bottom:88px;left:50%;transform:translateX(-50%);
    background:#1d1d1f;color:#fff;border-radius:12px;
    padding:12px 20px;font-size:.82rem;font-weight:500;
    cursor:pointer;z-index:200;box-shadow:0 4px 20px rgba(0,0,0,.2);
    display:flex;align-items:center;gap:8px;white-space:nowrap;
  `;

  prompt.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 4h3l4-3v12l-4-3H2V4z" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M10 5c.8.6 1.5 1.7 1.5 3s-.7 2.4-1.5 3" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
    Tap to enable audio
  `;

  prompt.onclick = async () => {
    if (livekitRoom && livekitRoom.startAudio) {
      await livekitRoom.startAudio();
    }
    prompt.remove();
  };

  document.body.appendChild(prompt);
}

// ── URL PARSING ───────────────────────────────────────
function parseUrl() {
  const p = new URLSearchParams(location.search);
  roomName = p.get("room") || "";
  meetingTitle = p.get("title") || roomName;

  if (roomName && $("input-room")) {
    $("input-room").value = roomName;
  }

  if ($("meeting-name")) {
    $("meeting-name").textContent = meetingTitle;
  }
}

// ── MODAL ─────────────────────────────────────────────
function openJoinModal() {
  const overlay = $("modal-overlay");
  overlay.classList.add("open");

  setTimeout(() => {
    const saved = localStorage.getItem("ib-username");
    const nameInput = $("input-name");

    if (saved) nameInput.value = saved;

    nameInput.focus();
    nameInput.select();
  }, 80);
}

function closeJoinModal(e) {
  if (e && e.target !== $("modal-overlay")) return;

  $("modal-overlay").classList.remove("open");
  $("join-error").textContent = "";
}

// ── JOIN FLOW ─────────────────────────────────────────
async function handleJoin() {
  const name = $("input-name").value.trim();
  const room = $("input-room").value.trim();

  $("join-error").textContent = "";

  if (!name) {
    $("join-error").textContent = "Please enter your name.";
    return;
  }

  if (!room) {
    $("join-error").textContent = "Please enter a room name.";
    return;
  }

  const btn = $("btn-join");
  btn.textContent = "Connecting…";
  btn.disabled = true;

  try {
    localStorage.setItem("ib-username", name);

    const uniqueIdentity = makeUniqueIdentity(name);

    localIdentity = uniqueIdentity;
    roomName = room;
    meetingTitle = $("input-room").value.trim();

    const res = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room,
        username: name,
        identity: uniqueIdentity,
      }),
    });

    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.error || "Server error");
    }

    const { token, url } = await res.json();

    await connectToRoom(url, token);

    $("join-screen").style.display = "none";
    $("meeting-screen").style.display = "flex";
    $("meeting-name").textContent = meetingTitle || room;

    history.replaceState(
      {},
      "",
      `?room=${encodeURIComponent(room)}&title=${encodeURIComponent(
        meetingTitle
      )}`
    );
  } catch (err) {
    $("join-error").textContent = err.message || "Failed to connect.";
    btn.textContent = "Join a Meeting";
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  parseUrl();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("modal-overlay").classList.remove("open");
  });

  ["input-name", "input-room"].forEach((id) => {
    const el = $(id);

    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleJoin();
      });
    }
  });
});

// ── LIVEKIT CONNECTION ────────────────────────────────
async function connectToRoom(wsUrl, token) {
  const { Room, RoomEvent } = LivekitClient;

  livekitRoom = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  livekitRoom.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  livekitRoom.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  livekitRoom.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  livekitRoom.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
  livekitRoom.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
  livekitRoom.on(RoomEvent.TrackMuted, onTrackMuted);
  livekitRoom.on(RoomEvent.TrackUnmuted, onTrackUnmuted);
  livekitRoom.on(RoomEvent.Disconnected, onDisconnected);
  livekitRoom.on(RoomEvent.DataReceived, onDataReceived);

  livekitRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (!livekitRoom.canPlaybackAudio) {
      showAudioPrompt();
    }
  });

  await livekitRoom.connect(wsUrl, token, { autoSubscribe: true });

  localIdentity = livekitRoom.localParticipant.identity;

  await livekitRoom.localParticipant.enableCameraAndMicrophone();

  createTile(
    localIdentity,
    `${livekitRoom.localParticipant.name || "You"} / You`,
    true
  );

  attachLocalVideo();

  livekitRoom.remoteParticipants.forEach((participant) => {
    onParticipantConnected(participant);

    participant.trackPublications.forEach((pub) => {
      if (pub.isSubscribed && pub.track) {
        onTrackSubscribed(pub.track, pub, participant);
      }
    });
  });

  startLocalAudioAnalysis();
  resetSilenceTimer();
  initMediaPipe();
  updateGridClass();
}

// ── PARTICIPANT EVENTS ────────────────────────────────
function onParticipantConnected(participant) {
  createTile(participant.identity, participant.name || participant.identity, false);

  participant.trackPublications.forEach((pub) => {
    if (pub.isSubscribed && pub.track) {
      onTrackSubscribed(pub.track, pub, participant);
    }
  });

  updateGridClass();
}

function onParticipantDisconnected(participant) {
  removeTile(participant.identity);
  updateGridClass();

  if (currentSpeaker === participant.identity) setSpeaker(null);
  if (heldSpeaker === participant.identity) clearHeld();
}

function onTrackSubscribed(track, pub, participant) {
  const { Track } = LivekitClient;

  if (!pMap.has(participant.identity)) {
    createTile(participant.identity, participant.name || participant.identity, false);
    updateGridClass();
  }

  const data = pMap.get(participant.identity);
  if (!data) return;

  if (track.kind === Track.Kind.Video) {
    const el = track.attach();
    el.className = "tile-video";

    attachVideoElementToTile(data, el, false);
  }

  if (track.kind === Track.Kind.Audio) {
    const el = track.attach();
    el.style.display = "none";
    el.dataset.identity = participant.identity;
    document.body.appendChild(el);
  }
}

function onTrackUnsubscribed(track, pub, participant) {
  const { Track } = LivekitClient;
  const data = pMap.get(participant.identity);

  if (!data) return;

  if (track.kind === Track.Kind.Video) {
    showCamOff(data);
  }

  if (track.kind === Track.Kind.Audio) {
    track.detach().forEach((el) => el.remove());

    document
      .querySelectorAll(`audio[data-identity="${participant.identity}"]`)
      .forEach((el) => el.remove());
  }
}

function onTrackMuted(pub, participant) {
  const data = pMap.get(participant.identity);
  if (!data) return;

  const { Track } = LivekitClient;

  if (pub.kind === Track.Kind.Audio) {
    data.isMuted = true;
    showMuteBadge(data, true);
  }

  if (pub.kind === Track.Kind.Video) {
    showCamOff(data);
  }
}

function onTrackUnmuted(pub, participant) {
  const data = pMap.get(participant.identity);
  if (!data) return;

  const { Track } = LivekitClient;

  if (pub.kind === Track.Kind.Audio) {
    data.isMuted = false;
    showMuteBadge(data, false);
  }

  if (pub.kind === Track.Kind.Video) {
    hideCamOff(data);
  }
}

function onActiveSpeakersChanged(speakers) {
  const ids = speakers.map((s) => s.identity);

  if (ids.length > 0) {
    const topSpeaker = ids[0];

    setSpeaker(topSpeaker);
    resetSilenceTimer();

    ids.forEach((id) => {
      const data = pMap.get(id);

      if (data && !data.isSpeaking) {
        data.isSpeaking = true;
        data.speakingStart = Date.now();
      }
    });

    pMap.forEach((data, id) => {
      if (data.isSpeaking && !ids.includes(id)) {
        data.isSpeaking = false;

        if (data.speakingStart) {
          data.speakingMs += Date.now() - data.speakingStart;
          data.speakingStart = null;
        }
      }
    });
  } else {
    if (currentSpeaker) {
      setSpeaker(null);
    }

    resetSilenceTimer();

    pMap.forEach((data) => {
      if (data.isSpeaking) {
        data.isSpeaking = false;

        if (data.speakingStart) {
          data.speakingMs += Date.now() - data.speakingStart;
          data.speakingStart = null;
        }
      }
    });
  }
}

function onDataReceived(payload, participant, kind, topic) {
  if (topic !== CUE_TOPIC) return;
  if (!participant) return;

  try {
    const message = JSON.parse(new TextDecoder().decode(payload));

    if (message.type !== "cue-state") return;

    const data = pMap.get(participant.identity);
    if (!data || data.isLocal) return;

    applyRemoteCues(participant.identity, message);
  } catch (error) {
    console.warn("Failed to parse cue data:", error);
  }
}

function onDisconnected() {
  tilesContainer().innerHTML = "";
  pMap.clear();
  stopSystems();
}

// ── TILE MANAGEMENT ───────────────────────────────────
function createTile(identity, displayName, isLocal) {
  if (pMap.has(identity)) return;

  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.identity = identity;

  /*
    기본 비율.
    실제 video metadata가 로드되면 --tile-ar가 실제 비율로 업데이트됨.
  */
  tile.style.setProperty("--tile-ar", "16 / 9");

  const vWrap = document.createElement("div");
  vWrap.className = "video-wrap";
  tile.appendChild(vWrap);

  const camOff = document.createElement("div");
  camOff.className = "tile-cam-off";
  camOff.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="2" y="7" width="18" height="14" rx="3" stroke="#86868b" stroke-width="1.5"/>
      <path d="M20 14l6-4v8l-6-4" stroke="#86868b" stroke-width="1.5" stroke-linejoin="round"/>
      <line x1="3" y1="3" x2="25" y2="25" stroke="#86868b" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span>${displayName.split("/")[0].trim()}</span>
  `;
  camOff.style.display = "none";
  tile.appendChild(camOff);

  const ring = document.createElement("div");
  ring.className = "speaker-ring";
  ring.style.display = "none";
  tile.appendChild(ring);

  const nameEl = document.createElement("div");
  nameEl.className = "tile-name";
  nameEl.textContent = displayName;
  tile.appendChild(nameEl);

  const muteBadge = document.createElement("div");
  muteBadge.className = "mute-badge";
  muteBadge.style.display = "none";
  muteBadge.innerHTML = `
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <line x1="1" y1="1" x2="9" y2="9" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
    </svg>
  `;
  tile.appendChild(muteBadge);

  let cueDots = null;

  if (isLocal) {
    const dots = document.createElement("div");
    dots.className = "cue-dots";
    dots.innerHTML = `
      <span class="cue-dot lip" title="Lip parting"></span>
      <span class="cue-dot gaze" title="Gazing at speaker"></span>
      <span class="cue-dot lean" title="Leaning forward"></span>
    `;
    tile.appendChild(dots);
    cueDots = dots;
  }

  tilesContainer().appendChild(tile);

  pMap.set(identity, {
    tile,
    videoWrap: vWrap,
    videoEl: null,
    camOffEl: camOff,
    speakerRing: ring,
    nameEl,
    muteBadge,
    cueDots,
    isSpeaking: false,
    speakingMs: 0,
    speakingStart: null,
    isMuted: false,
    isCamOff: false,
    isLocal,
  });
}

function removeTile(identity) {
  const data = pMap.get(identity);
  if (!data) return;

  data.tile.remove();
  pMap.delete(identity);
}

function attachVideoElementToTile(data, videoEl, mirror) {
  if (!data || !videoEl) return;

  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.classList.add("tile-video");

  if (mirror) {
    videoEl.classList.add("mirrored");
    videoEl.muted = true;
  }

  data.videoWrap.innerHTML = "";
  data.videoWrap.appendChild(videoEl);
  data.videoEl = videoEl;

  hideCamOff(data);
  lockInitialAspectRatio(data.tile, videoEl);
}

function lockInitialAspectRatio(tile, videoEl) {
  if (!tile || !videoEl) return;

  const applyAspect = () => {
    if (!videoEl.videoWidth || !videoEl.videoHeight) return;

    /*
      이미 한 번 aspect를 잡았다면 계속 유지.
      화면 효과가 나타나도 tile 비율이 다시 바뀌지 않음.
    */
    if (tile.dataset.aspectLocked === "true") return;

    tile.style.setProperty(
      "--tile-ar",
      `${videoEl.videoWidth} / ${videoEl.videoHeight}`
    );

    tile.dataset.aspectLocked = "true";
  };

  if (videoEl.readyState >= 1) {
    applyAspect();
  }

  videoEl.addEventListener("loadedmetadata", applyAspect, { once: true });
}

function attachLocalVideo() {
  const lp = livekitRoom.localParticipant;
  const { Track } = LivekitClient;

  function doAttach(pub) {
    if (!pub.track || pub.kind !== Track.Kind.Video) return;

    const data = pMap.get(localIdentity);
    if (!data) return;

    const el = pub.track.attach();
    attachVideoElementToTile(data, el, true);
  }

  lp.trackPublications.forEach((pub) => doAttach(pub));
  lp.on(LivekitClient.ParticipantEvent.LocalTrackPublished, (pub) => doAttach(pub));
}

// ── TILE STATE HELPERS ────────────────────────────────
function showCamOff(data) {
  data.isCamOff = true;
  if (data.camOffEl) data.camOffEl.style.display = "flex";
}

function hideCamOff(data) {
  data.isCamOff = false;
  if (data.camOffEl) data.camOffEl.style.display = "none";
}

function showMuteBadge(data, show) {
  if (data.muteBadge) {
    data.muteBadge.style.display = show ? "flex" : "none";
  }
}

// ── GRID LAYOUT ───────────────────────────────────────
function updateGridClass() {
  const n = pMap.size;
  const tc = tilesContainer();

  tc.className = tc.className.replace(/\bn\d+\b|nmax/g, "").trim();

  if (isCircleMode) return;

  let cls = "n" + n;
  if (n > 12) cls = "nmax";

  tc.classList.add(cls);

  if ($("participant-count")) {
    $("participant-count").textContent = n;
  }
}

// ── LAYOUT MODE ───────────────────────────────────────
function setLayoutMode(mode) {
  $("mode-grid").classList.toggle("sel", mode === "grid");
  $("mode-circle-btn").classList.toggle("sel", mode === "circle");

  if (mode === "circle" && !isCircleMode) {
    enterCircleMode();
  } else if (mode === "grid" && isCircleMode) {
    exitCircleMode();
  }
}

// ── SPEAKER DETECTION ────────────────────────────────
function setSpeaker(identity) {
  if (currentSpeaker && currentSpeaker !== identity) {
    const old = pMap.get(currentSpeaker);

    if (old) {
      old.tile.classList.remove("speaker");
      old.tile.classList.add("held-speaker");
      old.speakerRing.style.display = "none";
      heldSpeaker = currentSpeaker;
    }
  }

  currentSpeaker = identity;

  if (identity) {
    if (heldSpeaker && heldSpeaker !== identity) {
      clearHeld();
    }

    const data = pMap.get(identity);

    if (data) {
      data.tile.classList.add("speaker");
      data.tile.classList.remove(
        "held-speaker",
        "mouth-open",
        "leaning",
        "gaze-pull",
        "pre-lean",
        "pre-gaze"
      );
      data.speakerRing.style.display = "block";
    }

    if (isCircleMode) {
      exitCircleMode();
    }
  }
}

function clearHeld() {
  if (!heldSpeaker) return;

  const data = pMap.get(heldSpeaker);

  if (data) {
    data.tile.classList.remove("held-speaker", "speaker");
    data.speakerRing.style.display = "none";
  }

  heldSpeaker = null;
}

// ── SILENCE DETECTION → CIRCLE MODE ──────────────────
function resetSilenceTimer() {
  if (silenceTimer) clearTimeout(silenceTimer);

  silenceTimer = setTimeout(() => {
    if (circleModeFeature && pMap.size >= 2 && !currentSpeaker) {
      enterCircleMode();
    }
  }, SILENCE_MS);
}

// ── CIRCLE MODE ───────────────────────────────────────
function enterCircleMode() {
  if (isCircleMode) return;

  isCircleMode = true;

  const tc = tilesContainer();
  tc.classList.remove(
    "n1",
    "n2",
    "n3",
    "n4",
    "n5",
    "n6",
    "n7",
    "n8",
    "n9",
    "n10",
    "n11",
    "n12",
    "nmax"
  );
  tc.classList.add("circle-mode");

  pMap.forEach(({ tile }) => {
    tile.classList.remove(
      "speaker",
      "held-speaker",
      "mouth-open",
      "leaning",
      "gaze-pull",
      "pre-lean",
      "pre-gaze"
    );
  });

  clearHeld();

  function orbit() {
    orbitAngle += ORBIT_SPEED;
    layoutCircleTiles();
    orbitRafId = requestAnimationFrame(orbit);
  }

  orbit();

  $("mode-circle-btn").classList.add("sel");
  $("mode-grid").classList.remove("sel");
}

function exitCircleMode() {
  if (!isCircleMode) return;

  isCircleMode = false;

  if (orbitRafId) {
    cancelAnimationFrame(orbitRafId);
    orbitRafId = null;
  }

  orbitAngle = 0;

  const tc = tilesContainer();
  tc.classList.remove("circle-mode");

  pMap.forEach(({ tile }) => {
    clearCircleInlineLayout(tile);
    tile.classList.remove("speaker-circle");
  });

  updateGridClass();

  $("mode-grid").classList.add("sel");
  $("mode-circle-btn").classList.remove("sel");
}

function clearCircleInlineLayout(tile) {
  tile.style.removeProperty("position");
  tile.style.removeProperty("left");
  tile.style.removeProperty("top");
  tile.style.removeProperty("width");
  tile.style.removeProperty("height");
}

function layoutCircleTiles() {
  const tc = tilesContainer();

  const W = tc.clientWidth;
  const H = tc.clientHeight;
  const cx = W / 2;
  const cy = H / 2;

  const allData = [...pMap.values()];
  const n = allData.length;

  if (n === 0) return;

  const sorted = [...allData].sort((a, b) => b.speakingMs - a.speakingMs);

  const outerCount = Math.ceil(n / 2);
  const outerGroup = sorted.slice(0, outerCount);
  const innerGroup = sorted.slice(outerCount);

  const maxTile = Math.min(W, H) * 0.22;
  const tileSize = Math.min(maxTile, 140);

  const outerR = Math.min(W, H) * 0.33;
  const innerR = Math.max(tileSize * 1.1, outerR * 0.5);

  outerGroup.forEach((data, i) => {
    const angle = (i / outerCount) * Math.PI * 2 + orbitAngle;

    placeTile(
      data.tile,
      cx + Math.cos(angle) * outerR - tileSize / 2,
      cy + Math.sin(angle) * outerR - tileSize / 2,
      tileSize
    );
  });

  const innerOffset = outerCount > 0 ? Math.PI / outerCount : 0;

  innerGroup.forEach((data, i) => {
    const angle =
      (i / Math.max(innerGroup.length, 1)) * Math.PI * 2 +
      orbitAngle +
      innerOffset;

    placeTile(
      data.tile,
      cx + Math.cos(angle) * innerR - tileSize / 2,
      cy + Math.sin(angle) * innerR - tileSize / 2,
      tileSize
    );
  });
}

function placeTile(tile, x, y, size) {
  tile.style.position = "absolute";
  tile.style.left = `${Math.round(x)}px`;
  tile.style.top = `${Math.round(y)}px`;
  tile.style.width = `${Math.round(size)}px`;
  tile.style.height = `${Math.round(size)}px`;
}

// ── LOCAL AUDIO ANALYSIS ──────────────────────────────
function startLocalAudioAnalysis() {
  const lp = livekitRoom.localParticipant;
  const { Track } = LivekitClient;

  function trySetup(pub) {
    if (pub.kind !== Track.Kind.Audio || !pub.track) return;

    const mediaTrack = pub.track.mediaStreamTrack;
    if (!mediaTrack) return;

    audioCtx = new AudioContext();

    const stream = new MediaStream([mediaTrack]);
    const source = audioCtx.createMediaStreamSource(stream);

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 512;

    source.connect(analyserNode);

    const buf = new Float32Array(analyserNode.fftSize);

    function tick() {
      if (!analyserNode) return;

      analyserNode.getFloatTimeDomainData(buf);

      let rms = 0;

      for (let i = 0; i < buf.length; i++) {
        rms += buf[i] * buf[i];
      }

      rms = Math.sqrt(rms / buf.length);

      const data = pMap.get(localIdentity);

      if (data && data.isMuted) {
        requestAnimationFrame(tick);
        return;
      }

      if (rms > SPEAKING_RMS) {
        if (!localSpeaking) {
          localSpeaking = true;
          setSpeaker(localIdentity);
          resetSilenceTimer();
        }

        clearTimeout(localSpeakingTimer);

        localSpeakingTimer = setTimeout(() => {
          localSpeaking = false;

          if (currentSpeaker === localIdentity) {
            setSpeaker(null);
          }

          resetSilenceTimer();
        }, SPEAKING_HOLD_MS);
      }

      requestAnimationFrame(tick);
    }

    tick();
  }

  lp.trackPublications.forEach((pub) => trySetup(pub));
  lp.on(LivekitClient.ParticipantEvent.LocalTrackPublished, (pub) =>
    trySetup(pub)
  );
}

// ── MEDIAPIPE FACE DETECTION ──────────────────────────
async function initMediaPipe() {
  try {
    let visionModule = null;

    try {
      visionModule = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/+esm"
      );
      console.log("[InBetween] MediaPipe module loaded from jsDelivr.");
    } catch (cdnError) {
      console.warn(
        "[InBetween] jsDelivr MediaPipe import failed. Retrying with esm.sh.",
        cdnError
      );

      visionModule = await import(
        "https://esm.sh/@mediapipe/tasks-vision@0.10.3"
      );
      console.log("[InBetween] MediaPipe module loaded from esm.sh.");
    }

    const { FaceLandmarker, FilesetResolver } = visionModule;

    const filesetResolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );

    async function createLandmarker(delegate) {
      return FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate,
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });
    }

    try {
      faceLandmarker = await createLandmarker("GPU");
      console.log("[InBetween] FaceLandmarker ready with GPU.");
    } catch (gpuError) {
      console.warn(
        "[InBetween] GPU failed. Retrying FaceLandmarker with CPU.",
        gpuError
      );
      faceLandmarker = await createLandmarker("CPU");
      console.log("[InBetween] FaceLandmarker ready with CPU.");
    }

    mpRunning = true;
    runFaceDetection();

    showToast("Face tracking ready.", 1600);
  } catch (error) {
    console.error("[InBetween] MediaPipe failed completely:", error);
    showToast("Face tracking failed. Check console.", 4000);
  }
}

function runFaceDetection() {
  if (!mpRunning || !faceLandmarker) return;

  const data = pMap.get(localIdentity);

  if (!data || !data.videoEl) {
    mpRafId = requestAnimationFrame(runFaceDetection);
    return;
  }

  const video = data.videoEl;

  if (video.readyState < 2) {
    mpRafId = requestAnimationFrame(runFaceDetection);
    return;
  }

  const now = performance.now();

  let result;

  try {
    result = faceLandmarker.detectForVideo(video, now);
  } catch {
    mpRafId = requestAnimationFrame(runFaceDetection);
    return;
  }

  if (result.faceLandmarks && result.faceLandmarks.length > 0) {
    const lm = result.faceLandmarks[0];
    const bs = result.faceBlendshapes?.[0]?.categories || [];

    const lipOpen = detectLipOpen(lm, bs);
    const leaning = detectLeaning(lm);
    const gazing = detectGazing(lm);

    if (Math.random() < 0.03) {
      console.log("[cue raw]", {
        lipOpen,
        gazing,
        leaning,
        currentSpeaker,
        heldSpeaker,
        localIdentity,
      });
    }

    updateCueState(lipOpen, leaning, gazing, data);
  } else {
    updateCueState(false, false, false, data);
  }

  mpRafId = requestAnimationFrame(runFaceDetection);
}

function detectLipOpen(landmarks, blendshapes) {
  const upper = landmarks[13];
  const lower = landmarks[14];
  const forehead = landmarks[10];
  const chin = landmarks[152];

  if (!upper || !lower) return false;

  const rawGap = Math.abs(lower.y - upper.y);

  let normalizedGap = rawGap;

  if (forehead && chin) {
    const faceHeight = Math.abs(chin.y - forehead.y) || 1;
    normalizedGap = rawGap / faceHeight;
  }

  const jawOpen = blendshapes.find((b) => b.categoryName === "jawOpen");
  const jawScore = jawOpen ? jawOpen.score : 0;

  return normalizedGap > 0.018 || jawScore > 0.08;
}

function detectLeaning(landmarks) {
  const l = landmarks[234] || landmarks[127];
  const r = landmarks[454] || landmarks[356];

  if (!l || !r) return false;

  const faceWidth = Math.abs(r.x - l.x);

  if (baselineFaceScale === null) {
    baselineFaceScale = faceWidth;
    return false;
  }

  const ratio = faceWidth / baselineFaceScale;

  if (ratio < 1.02) {
    baselineFaceScale = baselineFaceScale * 0.98 + faceWidth * 0.02;
  } else {
    baselineFaceScale = baselineFaceScale * 0.998 + faceWidth * 0.002;
  }

  return ratio > 1.035;
}

function detectGazing(landmarks) {
  const cueSpeaker = getCueSpeakerId();

  if (!cueSpeaker || cueSpeaker === localIdentity) return false;
  if (pMap.size < 2) return false;

  const speakerData = pMap.get(cueSpeaker);
  const localData = pMap.get(localIdentity);

  if (!speakerData || !localData) return false;

  const speakerRect = speakerData.tile.getBoundingClientRect();
  const localRect = localData.tile.getBoundingClientRect();

  const speakerCenterX = speakerRect.left + speakerRect.width / 2;
  const speakerCenterY = speakerRect.top + speakerRect.height / 2;
  const localCenterX = localRect.left + localRect.width / 2;
  const localCenterY = localRect.top + localRect.height / 2;

  const dx = speakerCenterX - localCenterX;
  const dy = speakerCenterY - localCenterY;

  const nose = landmarks[1];
  const lEye = landmarks[33];
  const rEye = landmarks[263];
  const forehead = landmarks[10];
  const chin = landmarks[152];

  if (!nose || !lEye || !rEye || !forehead || !chin) return false;

  const eyeCenterX = (lEye.x + rEye.x) / 2;
  const faceCenterY = (forehead.y + chin.y) / 2;
  const faceHeight = Math.abs(chin.y - forehead.y) || 1;

  const yaw = nose.x - eyeCenterX;
  const pitch = (nose.y - faceCenterY) / faceHeight;

  const horizontal = Math.abs(dx) >= Math.abs(dy);

  if (horizontal) {
    if (dx > 0) return yaw > 0.006;
    return yaw < -0.006;
  }

  if (dy < 0) return pitch < 0.12;
  return pitch > -0.12;
}

function updateCueState(lipOpen, leaning, gazing, data) {
  const cueSpeaker = getCueSpeakerId();

  updateCueDots(data, lipOpen, gazing, leaning);

  CUE.lip = lipOpen;
  CUE.lean = leaning;
  CUE.gaze = gazing;

  if (currentSpeaker === localIdentity) {
    applyCueVisual(data, {
      lip: false,
      lean: false,
      gaze: false,
      speakerId: cueSpeaker,
    });

    publishCueState(false, false, false, cueSpeaker);
    return;
  }

  applyLocalCues(lipOpen, leaning, gazing, data);
  publishCueState(lipOpen, leaning, gazing, cueSpeaker);
}

function updateCueDots(data, lip, gaze, lean) {
  if (!data || !data.cueDots) return;

  const dots = data.cueDots.querySelectorAll(".cue-dot");

  dots[0]?.classList.toggle("active", Boolean(lip));
  dots[1]?.classList.toggle("active", Boolean(gaze));
  dots[2]?.classList.toggle("active", Boolean(lean));
}

function applyLocalCues(lip, lean, gaze, data) {
  applyCueVisual(data, {
    lip,
    lean,
    gaze,
    speakerId: getCueSpeakerId(),
  });
}

function applyRemoteCues(identity, message) {
  const data = pMap.get(identity);
  if (!data) return;

  applyCueVisual(data, {
    lip: Boolean(message.lip),
    lean: Boolean(message.lean),
    gaze: Boolean(message.gaze),
    speakerId: message.speakerId || getCueSpeakerId(),
  });
}

function applyCueVisual(data, cue) {
  const tile = data.tile;
  if (!tile) return;

  const speakerId = cue.speakerId || getCueSpeakerId();

  tile.classList.remove(
    "mouth-open",
    "leaning",
    "gaze-pull",
    "pre-lean",
    "pre-gaze"
  );

  tile.style.removeProperty("--pull-x");
  tile.style.removeProperty("--pull-y");
  tile.style.removeProperty("--cue-pull-x");
  tile.style.removeProperty("--cue-pull-y");
  tile.style.removeProperty("transform-origin");

  if (data.tile.dataset.identity === speakerId) {
    return;
  }

  if (cue.lip) {
    tile.classList.add("mouth-open");
  }

  /*
    B. Open mouth + Leaning Forward
    더 강한 turn-taking cue.
    크기를 키우지 않고 하단이 먼저 살짝 들리는 느낌만 줌.
  */
  if (cue.lip && cue.lean) {
    requestAnimationFrame(() => {
      tile.classList.add("pre-lean");
    });

    return;
  }

  /*
    A. Open mouth + Gazing Speaker
    speaker 방향으로 살짝 당겨지고 부풀어 오르는 cue.
  */
  if (cue.lip && cue.gaze && speakerId) {
    const speakerData = pMap.get(speakerId);

    if (speakerData) {
      const sr = speakerData.tile.getBoundingClientRect();
      const lr = tile.getBoundingClientRect();

      const dx = sr.left + sr.width / 2 - (lr.left + lr.width / 2);
      const dy = sr.top + sr.height / 2 - (lr.top + lr.height / 2);

      const len = Math.hypot(dx, dy) || 1;

      const nx = Math.max(-1, Math.min(1, dx / len));
      const ny = Math.max(-1, Math.min(1, dy / len));

      tile.style.setProperty("--cue-pull-x", nx.toFixed(4));
      tile.style.setProperty("--cue-pull-y", ny.toFixed(4));

      requestAnimationFrame(() => {
        tile.classList.add("pre-gaze");
      });
    }
  }
}

function publishCueState(lip, lean, gaze, speakerId) {
  if (!livekitRoom || !livekitRoom.localParticipant) return;

  const now = Date.now();
  const signature = `${lip}-${lean}-${gaze}-${speakerId || ""}`;

  if (signature === lastCueSignature && now - lastCueSentAt < 220) {
    return;
  }

  lastCueSignature = signature;
  lastCueSentAt = now;

  const payload = {
    type: "cue-state",
    lip: Boolean(lip),
    lean: Boolean(lean),
    gaze: Boolean(gaze),
    speakerId: speakerId || null,
  };

  try {
    livekitRoom.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(payload)),
      {
        reliable: false,
        topic: CUE_TOPIC,
      }
    );
  } catch (error) {
    console.warn("publish cue failed:", error);
  }
}

// ── CONTROLS ──────────────────────────────────────────
let micEnabled = true;
let camEnabled = true;

async function toggleMic() {
  micEnabled = !micEnabled;

  await livekitRoom.localParticipant.setMicrophoneEnabled(micEnabled);

  const icon = $("mic-icon");
  const label = $("mic-label");

  icon.className = "ctrl-icon" + (micEnabled ? " on" : "");

  if (micEnabled) {
    icon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="5" y="1" width="6" height="9" rx="3" stroke="white" stroke-width="1.3"/>
        <path d="M2.5 8.5C2.5 11.5 5 14 8 14s5.5-2.5 5.5-5.5" stroke="white" stroke-width="1.3" stroke-linecap="round"/>
        <line x1="8" y1="14" x2="8" y2="15.5" stroke="white" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
    `;
    label.textContent = "Mic";
  } else {
    icon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="5" y="1" width="6" height="9" rx="3" stroke="#86868b" stroke-width="1.3"/>
        <line x1="2" y1="2" x2="14" y2="14" stroke="#86868b" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    `;
    label.textContent = "Muted";
  }

  const localData = pMap.get(localIdentity);
  if (localData) showMuteBadge(localData, !micEnabled);
}

async function toggleCamera() {
  camEnabled = !camEnabled;

  await livekitRoom.localParticipant.setCameraEnabled(camEnabled);

  const icon = $("cam-icon");
  const label = $("cam-label");

  icon.className = "ctrl-icon" + (camEnabled ? " on" : "");

  if (camEnabled) {
    icon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="4" width="10" height="8" rx="2" stroke="white" stroke-width="1.3"/>
        <path d="M11 7.5L15 5v6l-4-2.5" stroke="white" stroke-width="1.3" stroke-linejoin="round"/>
      </svg>
    `;
    label.textContent = "Video";
  } else {
    icon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="4" width="10" height="8" rx="2" stroke="#86868b" stroke-width="1.3"/>
        <line x1="2" y1="2" x2="14" y2="14" stroke="#86868b" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    `;
    label.textContent = "Cam off";
  }

  const localData = pMap.get(localIdentity);

  if (localData) {
    camEnabled ? hideCamOff(localData) : showCamOff(localData);
  }
}

function toggleCircleFeature() {
  circleModeFeature = !circleModeFeature;

  const icon = $("circle-icon");

  if (circleModeFeature) {
    icon.className = "ctrl-icon circle-active";
    icon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="white" stroke-width="1.3"/>
        <circle cx="8" cy="2.8" r="1.6" fill="white"/>
        <circle cx="13.2" cy="11" r="1.4" fill="white"/>
        <circle cx="2.8" cy="11" r="1.4" fill="white"/>
      </svg>
    `;
    showToast("Circle mode on");
  } else {
    if (isCircleMode) exitCircleMode();

    icon.className = "ctrl-icon";
    icon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="#1d1d1f" stroke-width="1.3"/>
        <circle cx="8" cy="2.8" r="1.6" fill="#1d1d1f"/>
        <circle cx="13.2" cy="11" r="1.4" fill="#1d1d1f"/>
        <circle cx="2.8" cy="11" r="1.4" fill="#1d1d1f"/>
      </svg>
    `;
    showToast("Circle mode off");
  }
}

async function leaveRoom() {
  if (!livekitRoom) return;

  stopSystems();

  await livekitRoom.disconnect();

  pMap.clear();
  tilesContainer().innerHTML = "";

  $("meeting-screen").style.display = "none";

  const msg = document.createElement("div");
  msg.className = "left-msg";
  msg.style.display = "flex";
  msg.innerHTML = `<p>You left the room.</p><a href="/">Back to home</a>`;

  $("meeting-screen").appendChild(msg);
  $("meeting-screen").style.display = "flex";
}

function stopSystems() {
  if (silenceTimer) clearTimeout(silenceTimer);

  if (orbitRafId) {
    cancelAnimationFrame(orbitRafId);
    orbitRafId = null;
  }

  if (mpRafId) {
    cancelAnimationFrame(mpRafId);
    mpRafId = null;
  }

  mpRunning = false;

  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

function copyInvite() {
  const url = location.href;

  navigator.clipboard.writeText(url).then(() => {
    showToast("Invite link copied!");
  });
}