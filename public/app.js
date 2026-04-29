/* ═══════════════════════════════════════════════════
   InBetween — app.js
   ═══════════════════════════════════════════════════ */

// ── CONSTANTS ────────────────────────────────────────
const SILENCE_MS         = 5000;   // ms silence before circle mode
const SPEAKING_RMS       = 0.018;  // local audio RMS threshold
const SPEAKING_HOLD_MS   = 800;    // ms to hold speaking state after RMS drops
const LIP_THRESHOLD      = 0.055;  // MediaPipe mouth open threshold
const LEAN_THRESHOLD     = 1.14;   // face scale ratio for leaning
const GAZE_THRESHOLD     = 0.14;   // normalized gaze deviation
const ORBIT_SPEED        = 0.0025; // circle rotation speed (rad/frame)

// ── STATE ─────────────────────────────────────────────
let livekitRoom   = null;
let localIdentity = '';
let roomName      = '';
let meetingTitle  = '';

// participant map: identity → data object
const pMap = new Map();
/*  data = {
      tile, videoWrap, videoEl, nameEl, cueDots,
      isSpeaking, speakingMs, speakingStart,
      isMuted, isCamOff, isLocal
    }
*/

// speaker
let currentSpeaker = null;  // identity of active speaker
let heldSpeaker    = null;  // tile stays upright until next speaker

// silence / circle
let circleModeFeature = true; // user can toggle off
let isCircleMode      = false;
let silenceTimer      = null;
let orbitAngle        = 0;
let orbitRafId        = null;

// local audio analysis
let audioCtx          = null;
let analyserNode      = null;
let localSpeakingTimer= null;
let localSpeaking     = false;

// MediaPipe
let faceLandmarker    = null;
let mpRunning         = false;
let mpRafId           = null;
let baselineFaceScale = null;
const CUE = { lip: false, lean: false, gaze: false };

// ── DOM HELPERS ───────────────────────────────────────
const $ = id => document.getElementById(id);
const tilesContainer = () => $('tiles-container');

function showToast(msg, ms = 2000) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── URL PARSING ───────────────────────────────────────
function parseUrl() {
  const p = new URLSearchParams(location.search);
  roomName     = p.get('room')  || '';
  meetingTitle = p.get('title') || roomName;
  if (roomName) $('input-room').value = roomName;
  $('meeting-name').textContent = meetingTitle;
}

// ── MODAL ─────────────────────────────────────────────
function openJoinModal() {
  const overlay = $('modal-overlay');
  overlay.classList.add('open');
  setTimeout(() => {
    const saved = localStorage.getItem('ib-username');
    const nameInput = $('input-name');
    if (saved) nameInput.value = saved;
    nameInput.focus();
    nameInput.select();
  }, 80);
}

function closeJoinModal(e) {
  // Close only if clicking overlay background (not the card)
  if (e && e.target !== $('modal-overlay')) return;
  $('modal-overlay').classList.remove('open');
  $('join-error').textContent = '';
}

// ── JOIN FLOW ─────────────────────────────────────────
async function handleJoin() {
  const name = $('input-name').value.trim();
  const room = $('input-room').value.trim();
  $('join-error').textContent = '';

  if (!name) { $('join-error').textContent = 'Please enter your name.'; return; }
  if (!room) { $('join-error').textContent = 'Please enter a room name.'; return; }

  const btn = $('btn-join');
  btn.textContent = 'Connecting…';
  btn.disabled = true;

  try {
    localStorage.setItem('ib-username', name);
    localIdentity = name;
    roomName = room;
    meetingTitle = $('input-room').value.trim();

    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, username: name })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Server error'); }
    const { token, url } = await res.json();

    await connectToRoom(url, token);

    $('join-screen').style.display = 'none';
    $('meeting-screen').style.display = 'flex';
    $('meeting-name').textContent = meetingTitle || room;

    // Update URL without reload
    history.replaceState({}, '', `?room=${encodeURIComponent(room)}&title=${encodeURIComponent(meetingTitle)}`);

  } catch (err) {
    $('join-error').textContent = err.message || 'Failed to connect.';
    btn.textContent = 'Join a Meeting';
    btn.disabled = false;
  }
}

// Enter key on inputs
document.addEventListener('DOMContentLoaded', () => {
  parseUrl();

  // Escape closes modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('modal-overlay').classList.remove('open');
  });

  ['input-name', 'input-room'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') handleJoin(); });
  });
});

// ── LIVEKIT CONNECTION ────────────────────────────────
async function connectToRoom(wsUrl, token) {
  const { Room, RoomEvent, Track, ParticipantEvent } = LivekitClient;

  livekitRoom = new Room({ adaptiveStream: true, dynacast: true });

  livekitRoom.on(RoomEvent.ParticipantConnected,    onParticipantConnected);
  livekitRoom.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  livekitRoom.on(RoomEvent.TrackSubscribed,         onTrackSubscribed);
  livekitRoom.on(RoomEvent.TrackUnsubscribed,       onTrackUnsubscribed);
  livekitRoom.on(RoomEvent.ActiveSpeakersChanged,   onActiveSpeakersChanged);
  livekitRoom.on(RoomEvent.TrackMuted,              onTrackMuted);
  livekitRoom.on(RoomEvent.TrackUnmuted,            onTrackUnmuted);
  livekitRoom.on(RoomEvent.Disconnected,            onDisconnected);

  await livekitRoom.connect(wsUrl, token);
  await livekitRoom.localParticipant.enableCameraAndMicrophone();

  // Add local tile
  createTile(localIdentity, localIdentity + ' / You', true);
  attachLocalVideo();

  // Add existing remote participants
  livekitRoom.remoteParticipants.forEach(p => onParticipantConnected(p));

  // Start systems
  startLocalAudioAnalysis();
  resetSilenceTimer();
  initMediaPipe();
  updateGridClass();
}

// ── PARTICIPANT EVENTS ────────────────────────────────
function onParticipantConnected(participant) {
  createTile(participant.identity, participant.name || participant.identity, false);
  updateGridClass();
}

function onParticipantDisconnected(participant) {
  removeTile(participant.identity);
  updateGridClass();
  if (currentSpeaker === participant.identity) setSpeaker(null);
  if (heldSpeaker    === participant.identity) clearHeld();
}

function onTrackSubscribed(track, pub, participant) {
  const { Track } = LivekitClient;
  const data = pMap.get(participant.identity);
  if (!data) return;

  if (track.kind === Track.Kind.Video) {
    const el = track.attach();
    el.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;';
    el.className = 'tile-video';
    hideCamOff(data);
    data.videoWrap.innerHTML = '';
    data.videoWrap.appendChild(el);
    data.videoEl = el;
  } else if (track.kind === Track.Kind.Audio) {
    const el = track.attach();
    el.style.display = 'none';
    document.body.appendChild(el);
  }
}

function onTrackUnsubscribed(track, pub, participant) {
  const { Track } = LivekitClient;
  const data = pMap.get(participant.identity);
  if (!data) return;
  if (track.kind === Track.Kind.Video) showCamOff(data);
}

function onTrackMuted(pub, participant) {
  const data = pMap.get(participant.identity);
  if (!data) return;
  const { Track } = LivekitClient;
  if (pub.kind === Track.Kind.Audio) {
    data.isMuted = true;
    showMuteBadge(data, true);
  }
  if (pub.kind === Track.Kind.Video) showCamOff(data);
}

function onTrackUnmuted(pub, participant) {
  const data = pMap.get(participant.identity);
  if (!data) return;
  const { Track } = LivekitClient;
  if (pub.kind === Track.Kind.Audio) {
    data.isMuted = false;
    showMuteBadge(data, false);
  }
  if (pub.kind === Track.Kind.Video) hideCamOff(data);
}

function onActiveSpeakersChanged(speakers) {
  const ids = speakers.map(s => s.identity);
  if (ids.length > 0) {
    const topSpeaker = ids[0];
    setSpeaker(topSpeaker);
    resetSilenceTimer();
    // Update speaking time for all active speakers
    ids.forEach(id => {
      const data = pMap.get(id);
      if (data && !data.isSpeaking) {
        data.isSpeaking = true;
        data.speakingStart = Date.now();
      }
    });
    // Clear speaking for those who stopped
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
    // No active speakers
    pMap.forEach((data, id) => {
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

function onDisconnected() {
  tilesContainer().innerHTML = '';
  pMap.clear();
  stopSystems();
}

// ── TILE MANAGEMENT ───────────────────────────────────
function createTile(identity, displayName, isLocal) {
  if (pMap.has(identity)) return;

  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.identity = identity;

  // Video wrapper (holds actual video el)
  const vWrap = document.createElement('div');
  vWrap.style.cssText = 'position:absolute;inset:0;';
  tile.appendChild(vWrap);

  // Cam-off overlay
  const camOff = document.createElement('div');
  camOff.className = 'tile-cam-off';
  camOff.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="2" y="7" width="18" height="14" rx="3" stroke="#86868b" stroke-width="1.5"/>
      <path d="M20 14l6-4v8l-6-4" stroke="#86868b" stroke-width="1.5" stroke-linejoin="round"/>
      <line x1="3" y1="3" x2="25" y2="25" stroke="#86868b" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span>${displayName.split('/')[0].trim()}</span>`;
  camOff.style.display = 'none';
  tile.appendChild(camOff);

  // Speaker ring
  const ring = document.createElement('div');
  ring.className = 'speaker-ring';
  ring.style.display = 'none';
  tile.appendChild(ring);

  // Name pill
  const nameEl = document.createElement('div');
  nameEl.className = 'tile-name';
  nameEl.textContent = displayName;
  tile.appendChild(nameEl);

  // Mute badge
  const muteBadge = document.createElement('div');
  muteBadge.className = 'mute-badge';
  muteBadge.style.display = 'none';
  muteBadge.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><line x1="1" y1="1" x2="9" y2="9" stroke="white" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  tile.appendChild(muteBadge);

  // Cue dots (local only)
  let cueDots = null;
  if (isLocal) {
    const dots = document.createElement('div');
    dots.className = 'cue-dots';
    dots.innerHTML = '<span class="cue-dot" title="Lip open"></span><span class="cue-dot" title="Leaning"></span><span class="cue-dot" title="Gaze"></span>';
    tile.appendChild(dots);
    cueDots = dots;
  }

  tilesContainer().appendChild(tile);

  pMap.set(identity, {
    tile, videoWrap: vWrap, videoEl: null,
    camOffEl: camOff, speakerRing: ring, nameEl, muteBadge, cueDots,
    isSpeaking: false, speakingMs: 0, speakingStart: null,
    isMuted: false, isCamOff: false, isLocal
  });
}

function removeTile(identity) {
  const data = pMap.get(identity);
  if (!data) return;
  data.tile.remove();
  pMap.delete(identity);
}

function attachLocalVideo() {
  const lp = livekitRoom.localParticipant;
  const { Track } = LivekitClient;

  function doAttach(pub) {
    if (!pub.track || pub.kind !== Track.Kind.Video) return;
    const data = pMap.get(localIdentity);
    if (!data) return;
    const el = pub.track.attach();
    el.muted = true;
    el.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;transform:scaleX(-1);';
    el.className = 'tile-video mirrored';
    data.videoWrap.innerHTML = '';
    data.videoWrap.appendChild(el);
    data.videoEl = el;
    hideCamOff(data);
  }

  lp.trackPublications.forEach(pub => doAttach(pub));
  lp.on(LivekitClient.ParticipantEvent.LocalTrackPublished, pub => doAttach(pub));
}

// ── TILE STATE HELPERS ────────────────────────────────
function showCamOff(data) {
  data.isCamOff = true;
  if (data.camOffEl) data.camOffEl.style.display = 'flex';
}
function hideCamOff(data) {
  data.isCamOff = false;
  if (data.camOffEl) data.camOffEl.style.display = 'none';
}
function showMuteBadge(data, show) {
  if (data.muteBadge) data.muteBadge.style.display = show ? 'flex' : 'none';
}

// ── GRID LAYOUT ───────────────────────────────────────
function updateGridClass() {
  const n = pMap.size;
  const tc = tilesContainer();
  tc.className = tc.className.replace(/\bn\d+\b|nmax/g, '').trim();

  if (isCircleMode) return;

  let cls = 'n' + n;
  if (n > 12) cls = 'nmax';
  tc.classList.add(cls);

  $('participant-count').textContent = n;
}

// ── LAYOUT MODE (from top pill) ───────────────────────
function setLayoutMode(mode) {
  $('mode-grid').classList.toggle('sel', mode === 'grid');
  $('mode-circle-btn').classList.toggle('sel', mode === 'circle');

  if (mode === 'circle' && !isCircleMode) {
    enterCircleMode();
  } else if (mode === 'grid' && isCircleMode) {
    exitCircleMode();
  }
}

// ── SPEAKER DETECTION ────────────────────────────────
function setSpeaker(identity) {
  // Clear old speaker
  if (currentSpeaker && currentSpeaker !== identity) {
    const old = pMap.get(currentSpeaker);
    if (old) {
      old.tile.classList.remove('speaker');
      old.tile.classList.add('held-speaker');
      old.speakerRing.style.display = 'none';
      heldSpeaker = currentSpeaker;
    }
  }

  currentSpeaker = identity;

  if (identity) {
    // Clear held if someone new speaks
    if (heldSpeaker && heldSpeaker !== identity) clearHeld();

    const data = pMap.get(identity);
    if (data) {
      data.tile.classList.add('speaker');
      data.tile.classList.remove('held-speaker', 'mouth-open', 'leaning', 'gaze-pull');
      data.speakerRing.style.display = 'block';
    }
    // Exit circle mode when someone speaks
    if (isCircleMode) exitCircleMode();
  }
}

function clearHeld() {
  if (!heldSpeaker) return;
  const data = pMap.get(heldSpeaker);
  if (data) {
    data.tile.classList.remove('held-speaker', 'speaker');
    data.speakerRing.style.display = 'none';
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
  tc.classList.remove('n1','n2','n3','n4','n5','n6','n7','n8','n9','n10','n11','n12','nmax');
  tc.classList.add('circle-mode');

  // Reset all tile classes
  pMap.forEach(({ tile }) => {
    tile.classList.remove('speaker','held-speaker','mouth-open','leaning','gaze-pull');
  });
  clearHeld();

  // Start orbit
  function orbit() {
    orbitAngle += ORBIT_SPEED;
    layoutCircleTiles();
    orbitRafId = requestAnimationFrame(orbit);
  }
  orbit();

  $('mode-circle-btn').classList.add('sel');
  $('mode-grid').classList.remove('sel');
}

function exitCircleMode() {
  if (!isCircleMode) return;
  isCircleMode = false;

  if (orbitRafId) { cancelAnimationFrame(orbitRafId); orbitRafId = null; }
  orbitAngle = 0;

  const tc = tilesContainer();
  tc.classList.remove('circle-mode');

  // Reset tile inline styles set during circle mode
  pMap.forEach(({ tile }) => {
    tile.style.cssText = '';
    tile.classList.remove('speaker-circle');
  });

  updateGridClass();
  $('mode-grid').classList.add('sel');
  $('mode-circle-btn').classList.remove('sel');
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

  // Sort by speaking time descending
  const sorted = [...allData].sort((a, b) => b.speakingMs - a.speakingMs);

  const outerCount = Math.ceil(n / 2);
  const outerGroup = sorted.slice(0, outerCount);
  const innerGroup = sorted.slice(outerCount);

  // Tile size based on participant count
  const maxTile = Math.min(W, H) * 0.22;
  const tileSize = Math.min(maxTile, 140);

  const outerR = Math.min(W, H) * 0.33;
  const innerR = Math.max(tileSize * 1.1, outerR * 0.50);

  outerGroup.forEach((data, i) => {
    const angle = (i / outerCount) * Math.PI * 2 + orbitAngle;
    placeTile(data.tile, cx + Math.cos(angle) * outerR - tileSize/2, cy + Math.sin(angle) * outerR - tileSize/2, tileSize);
  });

  const innerOffset = outerCount > 0 ? Math.PI / outerCount : 0;
  innerGroup.forEach((data, i) => {
    const angle = (i / Math.max(innerGroup.length, 1)) * Math.PI * 2 + orbitAngle + innerOffset;
    placeTile(data.tile, cx + Math.cos(angle) * innerR - tileSize/2, cy + Math.sin(angle) * innerR - tileSize/2, tileSize);
  });
}

function placeTile(tile, x, y, size) {
  tile.style.position = 'absolute';
  tile.style.left  = `${Math.round(x)}px`;
  tile.style.top   = `${Math.round(y)}px`;
  tile.style.width = `${Math.round(size)}px`;
  tile.style.height= `${Math.round(size)}px`;
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
      for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / buf.length);

      const data = pMap.get(localIdentity);
      if (data && data.isMuted) { requestAnimationFrame(tick); return; }

      if (rms > SPEAKING_RMS) {
        if (!localSpeaking) {
          localSpeaking = true;
          setSpeaker(localIdentity);
          resetSilenceTimer();
        }
        clearTimeout(localSpeakingTimer);
        localSpeakingTimer = setTimeout(() => {
          localSpeaking = false;
          if (currentSpeaker === localIdentity) setSpeaker(null);
          resetSilenceTimer();
        }, SPEAKING_HOLD_MS);
      }
      requestAnimationFrame(tick);
    }
    tick();
  }

  lp.trackPublications.forEach(pub => trySetup(pub));
  lp.on(LivekitClient.ParticipantEvent.LocalTrackPublished, pub => trySetup(pub));
}

// ── MEDIAPIPE FACE DETECTION ──────────────────────────
async function initMediaPipe() {
  try {
    const { FaceLandmarker, FilesetResolver } = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.js'
    );

    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU'
      },
      outputFaceBlendshapes: true,
      runningMode: 'VIDEO',
      numFaces: 1
    });

    mpRunning = true;
    runFaceDetection();
    console.log('[InBetween] MediaPipe face landmarker ready.');
  } catch (e) {
    console.warn('[InBetween] MediaPipe unavailable, skipping pre-speech cues.', e);
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

    const lipOpen  = detectLipOpen(lm, bs);
    const leaning  = detectLeaning(lm);
    const gazing   = detectGazing(lm);

    updateCueState(lipOpen, leaning, gazing, data);
  } else {
    updateCueState(false, false, false, data);
  }

  mpRafId = requestAnimationFrame(runFaceDetection);
}

function detectLipOpen(landmarks, blendshapes) {
  // Upper lip center: 13, Lower lip center: 14
  const upper = landmarks[13];
  const lower = landmarks[14];
  if (!upper || !lower) return false;

  const dist = Math.abs(lower.y - upper.y);

  // Also check jawOpen blendshape if available
  const jawOpen = blendshapes.find(b => b.categoryName === 'jawOpen');
  const jawScore = jawOpen ? jawOpen.score : 0;

  return dist > LIP_THRESHOLD || jawScore > 0.15;
}

function detectLeaning(landmarks) {
  // Use horizontal span of face (left cheek to right cheek)
  // Landmarks 234 (left) and 454 (right)
  const l = landmarks[234] || landmarks[127];
  const r = landmarks[454] || landmarks[356];
  if (!l || !r) return false;

  const faceWidth = Math.abs(r.x - l.x);

  if (baselineFaceScale === null) {
    baselineFaceScale = faceWidth;
    return false;
  }

  // Slowly update baseline to account for natural drift
  baselineFaceScale = baselineFaceScale * 0.995 + faceWidth * 0.005;

  return faceWidth / baselineFaceScale > LEAN_THRESHOLD;
}

function detectGazing(landmarks) {
  if (!currentSpeaker || currentSpeaker === localIdentity) return false;
  if (pMap.size < 2) return false;

  // Nose tip: landmark 1, left eye: 33, right eye: 263
  const nose  = landmarks[1];
  const lEye  = landmarks[33];
  const rEye  = landmarks[263];
  if (!nose || !lEye || !rEye) return false;

  // Face center X (midpoint of eyes)
  const faceCenterX = (lEye.x + rEye.x) / 2;
  const yaw = nose.x - faceCenterX; // positive = looking right, negative = looking left

  // Get speaker tile position relative to local tile
  const speakerData = pMap.get(currentSpeaker);
  const localData   = pMap.get(localIdentity);
  if (!speakerData || !localData) return false;

  const speakerRect = speakerData.tile.getBoundingClientRect();
  const localRect   = localData.tile.getBoundingClientRect();

  const speakerOnRight = speakerRect.left > localRect.left;

  // If speaker is to the right, positive yaw means gazing at speaker
  const gazingTowardSpeaker = speakerOnRight ? yaw > GAZE_THRESHOLD : yaw < -GAZE_THRESHOLD;
  return gazingTowardSpeaker;
}

function updateCueState(lipOpen, leaning, gazing, data) {
  if (currentSpeaker === localIdentity) {
    // Already speaking — clear all cues
    applyLocalCues(false, false, false, data);
    return;
  }

  CUE.lip  = lipOpen;
  CUE.lean = leaning;
  CUE.gaze = gazing;

  applyLocalCues(lipOpen, leaning, gazing, data);
}

function applyLocalCues(lip, lean, gaze, data) {
  const tile = data.tile;
  if (!tile) return;

  // Remove all cue classes
  tile.classList.remove('mouth-open', 'leaning', 'gaze-pull');

  if (lip && lean) {
    tile.classList.add('leaning');
  } else if (lip && gaze) {
    // Pull tile toward speaker direction
    const speakerData = pMap.get(currentSpeaker);
    const localData   = data;
    if (speakerData && localData) {
      const sr = speakerData.tile.getBoundingClientRect();
      const lr = localData.tile.getBoundingClientRect();
      const pullX = Math.sign(sr.left - lr.left) * 0.5;
      const pullY = Math.sign(sr.top  - lr.top)  * 0.3;
      tile.style.setProperty('--pull-x', pullX);
      tile.style.setProperty('--pull-y', pullY);
    }
    tile.classList.add('gaze-pull');
  } else if (lip) {
    tile.classList.add('mouth-open');
  }

  // Update cue dots
  if (data.cueDots) {
    const dots = data.cueDots.querySelectorAll('.cue-dot');
    dots[0]?.classList.toggle('active', lip);
    dots[1]?.classList.toggle('active', lean);
    dots[2]?.classList.toggle('active', gaze);
  }
}

// ── CONTROLS ──────────────────────────────────────────
let micEnabled = true;
let camEnabled = true;

async function toggleMic() {
  micEnabled = !micEnabled;
  await livekitRoom.localParticipant.setMicrophoneEnabled(micEnabled);

  const icon  = $('mic-icon');
  const label = $('mic-label');
  icon.className = 'ctrl-icon' + (micEnabled ? ' on' : '');

  if (micEnabled) {
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="6" height="9" rx="3" stroke="white" stroke-width="1.3"/><path d="M2.5 8.5C2.5 11.5 5 14 8 14s5.5-2.5 5.5-5.5" stroke="white" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="14" x2="8" y2="15.5" stroke="white" stroke-width="1.3" stroke-linecap="round"/></svg>`;
    label.textContent = 'Mic';
  } else {
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="6" height="9" rx="3" stroke="#86868b" stroke-width="1.3"/><line x1="2" y1="2" x2="14" y2="14" stroke="#86868b" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    label.textContent = 'Muted';
  }

  const localData = pMap.get(localIdentity);
  if (localData) showMuteBadge(localData, !micEnabled);
}

async function toggleCamera() {
  camEnabled = !camEnabled;
  await livekitRoom.localParticipant.setCameraEnabled(camEnabled);

  const icon  = $('cam-icon');
  const label = $('cam-label');
  icon.className = 'ctrl-icon' + (camEnabled ? ' on' : '');

  if (camEnabled) {
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="4" width="10" height="8" rx="2" stroke="white" stroke-width="1.3"/><path d="M11 7.5L15 5v6l-4-2.5" stroke="white" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    label.textContent = 'Video';
  } else {
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="4" width="10" height="8" rx="2" stroke="#86868b" stroke-width="1.3"/><line x1="2" y1="2" x2="14" y2="14" stroke="#86868b" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    label.textContent = 'Cam off';
  }

  const localData = pMap.get(localIdentity);
  if (localData) camEnabled ? hideCamOff(localData) : showCamOff(localData);
}

function toggleCircleFeature() {
  circleModeFeature = !circleModeFeature;
  const icon = $('circle-icon');

  if (circleModeFeature) {
    icon.className = 'ctrl-icon circle-active';
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="white" stroke-width="1.3"/><circle cx="8" cy="2.8" r="1.6" fill="white"/><circle cx="13.2" cy="11" r="1.4" fill="white"/><circle cx="2.8" cy="11" r="1.4" fill="white"/></svg>`;
    showToast('Circle mode on');
  } else {
    if (isCircleMode) exitCircleMode();
    icon.className = 'ctrl-icon';
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#1d1d1f" stroke-width="1.3"/><circle cx="8" cy="2.8" r="1.6" fill="#1d1d1f"/><circle cx="13.2" cy="11" r="1.4" fill="#1d1d1f"/><circle cx="2.8" cy="11" r="1.4" fill="#1d1d1f"/></svg>`;
    showToast('Circle mode off');
  }
}

async function leaveRoom() {
  if (!livekitRoom) return;
  stopSystems();
  await livekitRoom.disconnect();
  pMap.clear();
  tilesContainer().innerHTML = '';
  $('meeting-screen').style.display = 'none';
  // Show left message
  const msg = document.createElement('div');
  msg.className = 'left-msg';
  msg.style.display = 'flex';
  msg.innerHTML = `<p>You left the room.</p><a href="/">Back to home</a>`;
  $('meeting-screen').appendChild(msg);
  $('meeting-screen').style.display = 'flex';
}

function stopSystems() {
  if (silenceTimer) clearTimeout(silenceTimer);
  if (orbitRafId)   { cancelAnimationFrame(orbitRafId); orbitRafId = null; }
  if (mpRafId)      { cancelAnimationFrame(mpRafId); mpRafId = null; }
  mpRunning = false;
  if (audioCtx)     { audioCtx.close(); audioCtx = null; }
}

function copyInvite() {
  const url = location.href;
  navigator.clipboard.writeText(url).then(() => showToast('Invite link copied!'));
}
