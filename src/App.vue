<script setup>
import * as faceapi from 'face-api.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  clearHallOfFame,
  isFirebaseEnabled,
  setForcePunishment,
  subscribeForcePunishment,
  subscribeHallOfFame,
  uploadHallOfFameSnapshot,
} from './sync';

const adminPin = import.meta.env.VITE_ADMIN_PIN || 'face-rot';
const route = ref(window.location.pathname);
const params = new URLSearchParams(window.location.search);
const isAdmin = computed(() => route.value.startsWith('/godmode'));
const isGallery = computed(() => route.value.startsWith('/gallery'));
const adminAllowed = computed(() => (!isAdmin.value && !isGallery.value) || params.get('pin') === adminPin);
const syncMode = computed(() => (isFirebaseEnabled() ? 'Firebase RTDB' : 'local demo mode'));
const realtimeTokenUrl = import.meta.env.VITE_REALTIME_TOKEN_URL || '/api/realtime-token';

const subwaySrc = ref('/videos/subway.mp4');
const punishmentSrc = ref('/videos/punishment.mp4');
const started = ref(false);
const busy = ref(false);
const faceReady = ref(false);
const looking = ref(true);
const attentionLost = ref(false);
const forcedPunishment = ref(false);
const status = ref('Ready');
const caption = ref('');
const auraScore = ref(20);
const displayedAuraScore = ref(20);
const auraPopupVisible = ref(false);
const auraPopupKind = ref('negative');
const auraPopupTitle = ref('Beta Status');
const auraPopupKey = ref(0);
const archiveCaseNumber = ref(generateCaseNumber());
const archiveOffense = ref('LOOKING AT PHONE');
const hallOfFame = ref([]);
const clearingGallery = ref(false);

// surveillance + session-time-driven aura float
const sessionStartedAt = ref(0);
const nowMs = ref(Date.now());
const reducedMotion = ref(false);
const punishmentSilenced = ref(false);

// system toasts (cursed terminal layer)
const toasts = ref([]);
let toastSeq = 0;

// caption per-word rendering
const liveCaptionWords = computed(() => {
  const trimmed = (caption.value || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return [];
  return trimmed.split(' ').slice(-14);
});

// rotating attention bait used while waiting for transcription
const fakeCaptions = [
  'BRO IS SPEAKING IN 1.25X SPEED',
  'POV: YOU ARE LOCKED IN ACADEMICALLY',
  'THE SLIDES ARE OPTIONAL BUT THE LORE IS NOT',
  'AVERAGE GROUP PROJECT SURVIVAL TECHNIQUE',
  'FOCUS LEVELS REACHING LEGALLY CONCERNING NUMBERS',
  'WHEN THE EXAMPLE HAS THREE EDGE CASES AND A DREAM',
];

const startBaitIndex = ref(0);
const startBaitText = computed(() => fakeCaptions[startBaitIndex.value % fakeCaptions.length]);
const fakeOnlineCount = ref(127432);

// aura derived UI
const auraTitle = computed(() => {
  if (auraScore.value >= 100) return 'Ultimate Sigma';
  if (auraScore.value >= 50) return 'Chief Rizz Officer';
  if (auraScore.value >= 0) return 'Locked-In Scholar';
  if (auraScore.value <= -50) return 'Level 1 Crook';
  return 'Beta Status';
});
const auraRankLevel = computed(() => {
  if (auraScore.value >= 100) return 4;
  if (auraScore.value >= 50) return 3;
  if (auraScore.value >= 0) return 2;
  if (auraScore.value <= -50) return 0;
  return 1;
});
const auraEmoji = computed(() => {
  if (auraScore.value >= 100) return '👑';
  if (auraScore.value >= 50) return '🔥';
  if (auraScore.value >= 0) return '🧠';
  if (auraScore.value <= -50) return '💀';
  return '🤡';
});

const sessionMinutes = computed(() => {
  if (!sessionStartedAt.value) return 0;
  return Math.max(0, (nowMs.value - sessionStartedAt.value) / 60000);
});

// HUD float-up: drifts up to 56px above its anchor over the first 8 mins
const auraFloat = computed(() => Math.min(56, sessionMinutes.value * 7));
// Glow intensity scales over the first 6 mins, capped at 1
const auraGlow = computed(() => Math.min(1, sessionMinutes.value / 6));

const auraHudStyle = computed(() => ({
  '--aura-float': `${auraFloat.value}px`,
  '--aura-glow': auraGlow.value.toFixed(3),
}));

const tierUp = ref(false);
const sparkles = ref([]);
let sparkleSeq = 0;

const punishmentActive = computed(() => forcedPunishment.value || attentionLost.value);

const unsupportedReason = computed(() => {
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const isSecure = window.isSecureContext || isLocalhost;

  if (!isSecure) return 'Open over HTTPS so camera and microphone permissions work.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not expose camera access.';
  return '';
});

const surveillanceTimestamp = computed(() => {
  const d = new Date(nowMs.value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
});

// barcode bars for the archive card (deterministic per popup)
const archiveBars = ref(makeBarcode());

const selfieVideo = ref(null);
const mugshotCanvas = ref(null);
const subwayVideo = ref(null);
const punishmentVideo = ref(null);

let unsubscribe;
let unsubscribeGallery;
let mediaStream;
let detectionInterval;
let vibrationInterval;
let lastSeenAt = 0;
let realtimePeerConnection;
let realtimeDataChannel;
let realtimeTranscriptByItem = new Map();
let badAttentionSince;
let goodAttentionSince;
let auraPopupTimer;
let lastAuraTickAt = 0;
let lastAuraTitle = 'Locked-In Scholar';
let rankUpAudio;
let rankDownAudio;
let clockInterval;
let baitInterval;
let onlineCounterInterval;
let auraDisplayInterval;
let lastAttentionLost = false;

function generateCaseNumber() {
  return `FM-${Math.floor(Math.random() * 89999 + 10000)}`;
}

function makeBarcode() {
  const bars = [];
  let total = 0;
  while (total < 100) {
    const w = Math.random() < 0.5 ? 1 : Math.random() < 0.7 ? 2 : 4;
    bars.push(w);
    total += w + 1;
  }
  return bars;
}

function pushToast(text, kind = 'info') {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, text, kind }].slice(-4);
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 2400);
}

function emitSparkles(count = 6) {
  if (reducedMotion.value) return;
  for (let i = 0; i < count; i++) {
    const id = ++sparkleSeq;
    const sx = (Math.random() * 80 - 40) + 'px';
    const sy = (-40 - Math.random() * 60) + 'px';
    const left = (Math.random() * 80 + 10) + '%';
    const top = (Math.random() * 60 + 20) + '%';
    const glyph = ['✨', '⭐', '💫', '🔥'][Math.floor(Math.random() * 4)];
    sparkles.value.push({ id, glyph, sx, sy, left, top });
    window.setTimeout(() => {
      sparkles.value = sparkles.value.filter((s) => s.id !== id);
    }, 1700);
  }
}

function handleMissingVideo(kind) {
  if (kind === 'subway' && subwaySrc.value !== '/videos/gta.mp4') {
    subwaySrc.value = '/videos/gta.mp4';
  }

  if (kind === 'punishment' && punishmentSrc.value !== '/videos/gta.mp4') {
    punishmentSrc.value = '/videos/gta.mp4';
  }
}

function normalizeTranscript(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(-160);
}

async function loadFaceModel() {
  status.value = 'Loading attention model';
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri('/models'),
  ]);
  faceReady.value = true;
}

function handleRealtimeEvent(rawEvent) {
  let event;
  try {
    event = JSON.parse(rawEvent);
  } catch {
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    const itemId = event.item_id || 'current';
    const current = realtimeTranscriptByItem.get(itemId) || '';
    const next = `${current}${event.delta || ''}`;
    realtimeTranscriptByItem.set(itemId, next);
    caption.value = normalizeTranscript(next);
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = event.transcript || '';
    if (transcript) {
      realtimeTranscriptByItem.set(event.item_id || String(Date.now()), transcript);
      caption.value = normalizeTranscript(transcript);
    }
    return;
  }

  if (event.type === 'error') {
    status.value = event.error?.message || 'Subtitle stream error';
  }
}

async function startRealtimeTranscription(stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) {
    status.value = 'No microphone track';
    return;
  }

  status.value = 'Connecting captions';
  const tokenResponse = await fetch(realtimeTokenUrl, { method: 'POST' });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok || !tokenPayload.client_secret) {
    throw new Error(tokenPayload.error || 'Unable to start captions');
  }

  realtimePeerConnection = new RTCPeerConnection();
  realtimePeerConnection.addTrack(audioTrack, stream);
  realtimeDataChannel = realtimePeerConnection.createDataChannel('oai-events');
  realtimeDataChannel.addEventListener('message', (message) => handleRealtimeEvent(message.data));
  realtimeDataChannel.addEventListener('open', () => {
    status.value = 'Live captions on';
    realtimeDataChannel.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              transcription: {
                model: 'gpt-4o-mini-transcribe',
                language: 'en',
                prompt: 'University lecture audio. Prefer concise, readable live captions.',
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.45,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          },
        },
      }),
    );
  });

  const offer = await realtimePeerConnection.createOffer();
  await realtimePeerConnection.setLocalDescription(offer);

  const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenPayload.client_secret}`,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp,
  });

  if (!sdpResponse.ok) {
    throw new Error(await sdpResponse.text());
  }

  await realtimePeerConnection.setRemoteDescription({
    type: 'answer',
    sdp: await sdpResponse.text(),
  });
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(points) {
  const verticalA = distance(points[1], points[5]);
  const verticalB = distance(points[2], points[4]);
  const horizontal = distance(points[0], points[3]);
  return horizontal ? (verticalA + verticalB) / (2 * horizontal) : 0;
}

function getAttentionScore(detection) {
  if (!detection) return { score: 4, reason: 'No face' };

  const { detection: faceDetection, landmarks } = detection;
  const box = faceDetection.box;
  const points = landmarks.positions;
  const leftEye = points.slice(36, 42);
  const rightEye = points.slice(42, 48);
  const bothEyes = [...leftEye, ...rightEye];
  const nose = points[30];
  const chin = points[8];
  const leftJaw = points[0];
  const rightJaw = points[16];
  const eyeCenterY = bothEyes.reduce((sum, point) => sum + point.y, 0) / bothEyes.length;
  const eyeLineY = (points[36].y + points[45].y) / 2;
  const noseXRatio = (nose.x - box.x) / box.width;
  const noseYRatio = (nose.y - box.y) / box.height;
  const chinYRatio = (chin.y - box.y) / box.height;
  const jawBalance = distance(nose, leftJaw) / Math.max(distance(nose, rightJaw), 1);
  const ear = (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;
  const frameArea = selfieVideo.value.videoWidth * selfieVideo.value.videoHeight || 1;
  const faceAreaRatio = (box.width * box.height) / frameArea;

  const issues = [];
  let score = 0;

  if (faceDetection.score < 0.58) {
    score += 1;
    issues.push('weak face');
  }

  if (faceAreaRatio < 0.035) {
    score += 1;
    issues.push('too far');
  }

  if (noseXRatio < 0.38 || noseXRatio > 0.62 || jawBalance < 0.62 || jawBalance > 1.62) {
    score += 2;
    issues.push('turned away');
  }

  if (noseYRatio > 0.62 || chinYRatio > 0.98 || eyeCenterY - eyeLineY > box.height * 0.04) {
    score += 2;
    issues.push('looking down');
  }

  if (ear < 0.18) {
    score += 2;
    issues.push('eyes closed');
  }

  return { score, reason: issues[0] || 'Locked in' };
}

function drawMugshotOverlay(kind) {
  const video = selfieVideo.value;
  const canvas = mugshotCanvas.value;
  if (!video || !canvas || video.readyState < 2) return;

  const width = 360;
  const height = 480;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.save();
  context.translate(width, 0);
  context.scale(-1, 1);
  context.drawImage(video, 0, 0, width, height);
  context.restore();

  // crosshair on negative
  if (kind === 'negative') {
    context.strokeStyle = 'rgba(255, 45, 85, 0.85)';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(width / 2, 40);
    context.lineTo(width / 2, height - 40);
    context.moveTo(40, height / 2);
    context.lineTo(width - 40, height / 2);
    context.stroke();

    context.strokeStyle = '#ff2d55';
    context.lineWidth = 3;
    context.strokeRect(width / 2 - 70, height / 2 - 90, 140, 180);
  }

  context.textAlign = 'center';
  context.lineWidth = 8;
  context.strokeStyle = '#050507';
  context.fillStyle = kind === 'positive' ? '#ffe600' : '#ff2d55';
  context.font = '900 64px Impact, system-ui';
  context.strokeText(kind === 'positive' ? '😎' : '🤡', width / 2, 80);
  context.fillText(kind === 'positive' ? '😎' : '🤡', width / 2, 80);
}

async function uploadMugshotSnapshot(kind) {
  const canvas = mugshotCanvas.value;
  if (!canvas) return;

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.62));
  if (!blob) return;

  await uploadHallOfFameSnapshot({
    blob,
    auraScore: auraScore.value,
    auraTitle: auraTitle.value,
    offense: archiveOffense.value,
    kind,
  }).catch(() => undefined);
}

async function showAuraPopup(kind) {
  auraPopupKind.value = kind;
  auraPopupTitle.value = auraTitle.value;
  auraPopupKey.value += 1;
  auraPopupVisible.value = true;
  archiveCaseNumber.value = generateCaseNumber();
  archiveBars.value = makeBarcode();
  archiveOffense.value = pickOffense(kind);
  await nextTick();
  drawMugshotOverlay(kind);
  uploadMugshotSnapshot(kind);
  window.clearTimeout(auraPopupTimer);
  auraPopupTimer = window.setTimeout(() => {
    auraPopupVisible.value = false;
  }, 1800);
}

function pickOffense(kind) {
  if (kind === 'positive') {
    const goods = ['SUSTAINED EYE CONTACT', 'COMPLETED A THOUGHT', 'NO PHONE FOR 2 MIN', 'POSTURE: SIGMA'];
    return goods[Math.floor(Math.random() * goods.length)];
  }
  const bads = [
    'LOOKING AT PHONE',
    'GLAZED OVER',
    'LEFT THE DESK',
    'EYES CLOSED MID-LECTURE',
    'GROUP CHAT REPLY',
    'DOOMSCROLL DETECTED',
  ];
  return bads[Math.floor(Math.random() * bads.length)];
}

async function warmRankAudio() {
  rankUpAudio = new Audio('/audio/rank-up.mp3');
  rankDownAudio = new Audio('/audio/rank-down.mp3');

  for (const audio of [rankUpAudio, rankDownAudio]) {
    audio.preload = 'auto';
    audio.volume = 0.85;
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // Mobile browsers may still defer audio, but the first user tap gives us the best shot.
    } finally {
      audio.muted = false;
    }
  }
}

async function playRankAudio(direction) {
  const audio = direction === 'up' ? rankUpAudio : rankDownAudio;
  if (!audio) return;

  audio.currentTime = 0;
  audio.volume = 0.85;
  audio.muted = false;
  await audio.play().catch(() => undefined);
}

function updateAura(isBadAttention) {
  const now = performance.now();
  if (!lastAuraTickAt) {
    lastAuraTickAt = now;
    return;
  }

  const elapsedSeconds = Math.min((now - lastAuraTickAt) / 1000, 2);
  lastAuraTickAt = now;
  const previousTitle = auraTitle.value;
  const previousRankLevel = auraRankLevel.value;
  const delta = isBadAttention || forcedPunishment.value ? -18 * elapsedSeconds : 5 * elapsedSeconds;
  auraScore.value = Math.max(-100, Math.min(120, Math.round(auraScore.value + delta)));
  const nextTitle = auraTitle.value;
  const nextRankLevel = auraRankLevel.value;

  if (nextTitle !== previousTitle && nextTitle !== lastAuraTitle) {
    lastAuraTitle = nextTitle;
    showAuraPopup(auraScore.value < 0 ? 'negative' : 'positive');
    playRankAudio(nextRankLevel > previousRankLevel ? 'up' : 'down');
    if (nextRankLevel > previousRankLevel) {
      tierUp.value = true;
      window.setTimeout(() => (tierUp.value = false), 600);
      emitSparkles(8);
      pushToast(`> RANK UP: ${nextTitle.toUpperCase()}`, 'info');
      try {
        navigator.vibrate?.(80);
      } catch {}
    } else {
      pushToast(`> RANK DOWN: ${nextTitle.toUpperCase()}`, 'bad');
      try {
        navigator.vibrate?.([40, 30, 40]);
      } catch {}
    }
  }
}

function startAuraDisplayLoop() {
  window.clearInterval(auraDisplayInterval);
  displayedAuraScore.value = auraScore.value;

  auraDisplayInterval = window.setInterval(() => {
    const diff = auraScore.value - displayedAuraScore.value;
    if (diff === 0) return;

    const step = Math.sign(diff) * Math.max(1, Math.ceil(Math.abs(diff) * 0.25));
    const next = displayedAuraScore.value + step;
    displayedAuraScore.value = diff > 0 ? Math.min(next, auraScore.value) : Math.max(next, auraScore.value);
  }, 120);
}

function startDetectionLoop() {
  window.clearInterval(detectionInterval);
  lastSeenAt = performance.now();
  badAttentionSince = undefined;
  goodAttentionSince = performance.now();
  detectionInterval = window.setInterval(async () => {
    if (!selfieVideo.value || selfieVideo.value.readyState < 2 || !faceReady.value) return;

    try {
      const detection = await faceapi
        .detectSingleFace(selfieVideo.value, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.42 }))
        .withFaceLandmarks(true);
      const attention = getAttentionScore(detection);
      const now = performance.now();
      const bad = attention.score >= 3;
      updateAura(bad);

      if (!bad) {
        lastSeenAt = now;
        looking.value = true;
        badAttentionSince = undefined;
        goodAttentionSince = goodAttentionSince || now;
        if (attentionLost.value && now - goodAttentionSince > 600) {
          attentionLost.value = false;
        }
        status.value = forcedPunishment.value ? 'God mode override' : 'Locked in';
        return;
      }

      looking.value = false;
      goodAttentionSince = undefined;
      badAttentionSince = badAttentionSince || now;
      if (now - badAttentionSince > 700 || now - lastSeenAt > 1100) {
        attentionLost.value = true;
        status.value = forcedPunishment.value ? 'God mode override' : attention.reason;
      }
    } catch {
      status.value = 'Attention scan recovering';
    }
  }, 400);
}

function startVibration() {
  if (!('vibrate' in navigator)) return;
  navigator.vibrate([260, 60, 260, 60, 420, 80]);
  window.clearInterval(vibrationInterval);
  vibrationInterval = window.setInterval(() => {
    navigator.vibrate([260, 60, 260, 60, 420, 80]);
  }, 1180);
}

function stopVibration() {
  window.clearInterval(vibrationInterval);
  vibrationInterval = undefined;
  navigator.vibrate?.(0);
}

async function activatePunishment() {
  punishmentSilenced.value = false;
  await nextTick();
  const video = punishmentVideo.value;
  if (!video) return;

  video.muted = false;
  video.volume = 0.85;
  video.currentTime = 0;
  try {
    await video.play();
  } catch {
    status.value = 'Tap once to unlock punishment audio';
  }
  startVibration();
  pushToast('> SYS: focus.exe terminated', 'bad');
}

function deactivatePunishment() {
  const video = punishmentVideo.value;
  video?.pause();
  if (video) video.currentTime = 0;
  stopVibration();
}

function silencePunishment() {
  const video = punishmentVideo.value;
  if (video) {
    video.muted = true;
    video.volume = 0;
  }
  stopVibration();
  punishmentSilenced.value = true;
}

async function warmMediaElements() {
  const subway = subwayVideo.value;
  const punishment = punishmentVideo.value;

  if (subway) {
    subway.muted = true;
    subway.loop = true;
    subway.playsInline = true;
    await subway.play().catch(() => undefined);
  }

  if (punishment) {
    punishment.muted = false;
    punishment.volume = 0.85;
    punishment.loop = true;
    punishment.playsInline = true;
    await punishment.play().catch(() => undefined);
    punishment.pause();
    punishment.currentTime = 0;
  }
}

async function enterFocusMode() {
  busy.value = true;

  if (unsupportedReason.value) {
    status.value = unsupportedReason.value;
    busy.value = false;
    return;
  }

  try {
    status.value = 'Requesting camera and mic';
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: true,
    });

    started.value = true;
    sessionStartedAt.value = Date.now();
    await nextTick();

    if (selfieVideo.value) {
      selfieVideo.value.srcObject = mediaStream;
      selfieVideo.value.muted = true;
      selfieVideo.value.playsInline = true;
      await selfieVideo.value.play();
    }

    await document.documentElement.requestFullscreen?.().catch(() => undefined);
    await warmMediaElements();
    await warmRankAudio();
    startAuraDisplayLoop();
    pushToast('> SYS: lock-in protocol engaged', 'info');
    await startRealtimeTranscription(mediaStream);

    try {
      await loadFaceModel();
      startDetectionLoop();
      status.value = 'Locked in';
    } catch {
      faceReady.value = false;
      status.value = 'Manual godmode ready';
    }
  } catch (error) {
    status.value = error?.name === 'NotAllowedError' ? 'Camera or microphone blocked' : 'Startup failed';
  } finally {
    busy.value = false;
  }
}

async function triggerPunishment() {
  await setForcePunishment(true);
}

async function releasePunishment() {
  await setForcePunishment(false);
}

async function clearGallery() {
  clearingGallery.value = true;
  try {
    await clearHallOfFame();
  } finally {
    clearingGallery.value = false;
  }
}

watch(punishmentActive, (active) => {
  if (active) {
    if (auraScore.value < 0) {
      showAuraPopup('negative');
    }
    activatePunishment();
  } else {
    deactivatePunishment();
  }
});

// system toast on attention transitions
watch(attentionLost, (lost) => {
  if (lost === lastAttentionLost) return;
  lastAttentionLost = lost;
  if (lost) {
    pushToast('> ATTENTION LOST. AURA DECAY ACTIVE', 'bad');
  } else {
    pushToast('> EYE CONTACT RESTORED', 'info');
  }
});

unsubscribe = subscribeForcePunishment((isForced) => {
  forcedPunishment.value = isForced;
});

unsubscribeGallery = subscribeHallOfFame((items) => {
  hallOfFame.value = items;
});

onMounted(() => {
  reducedMotion.value =
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

  // 1Hz clock for surveillance timestamp + session-time-driven HUD float
  clockInterval = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);

  // pre-start bait copy rotates every 1.4s
  baitInterval = window.setInterval(() => {
    startBaitIndex.value++;
  }, 1400);

  // fake online counter ticks the last digit
  onlineCounterInterval = window.setInterval(() => {
    fakeOnlineCount.value += Math.random() < 0.5 ? 1 : -1;
  }, 220);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribeGallery?.();
  window.clearInterval(detectionInterval);
  window.clearInterval(clockInterval);
  window.clearInterval(baitInterval);
  window.clearInterval(onlineCounterInterval);
  window.clearInterval(auraDisplayInterval);
  window.clearTimeout(auraPopupTimer);
  stopVibration();
  realtimeDataChannel?.close?.();
  realtimePeerConnection?.close?.();
  mediaStream?.getTracks().forEach((track) => track.stop());
});

const formattedOnline = computed(() => fakeOnlineCount.value.toLocaleString('en-US'));

// vignette intensity follows negative aura
const vignetteOpacity = computed(() => {
  if (auraScore.value >= 0) return 0;
  return Math.min(0.7, Math.abs(auraScore.value) / 100);
});

const ctaBait = ['TAP TO COOK', 'ENGAGE LOCK-IN', 'ACTIVATE SIGMA MODE', 'DEPLOY ATTENTION'];
const ctaIndex = computed(() => startBaitIndex.value % ctaBait.length);
const ctaCopy = computed(() => (busy.value ? 'Entering' : ctaBait[ctaIndex.value]));
</script>

<template>
  <main class="app-shell" :class="{ admin: isAdmin, started: started && !isAdmin, punishing: punishmentActive, 'reduced-motion': reducedMotion }">
    <section v-if="isGallery" class="gallery-screen">
      <div v-if="!adminAllowed" class="locked">
        <h1>Locked</h1>
        <p>Open with the admin PIN query string.</p>
      </div>

      <template v-else>
        <header class="gallery-header">
          <div>
            <p>{{ syncMode }}</p>
            <h1>Hall of Fame</h1>
          </div>
          <button class="clear-gallery-button" type="button" :disabled="clearingGallery" @click="clearGallery">
            {{ clearingGallery ? 'Clearing' : 'Clear Gallery' }}
          </button>
        </header>

        <div v-if="hallOfFame.length" class="gallery-grid">
          <article v-for="entry in hallOfFame" :key="entry.id" class="gallery-card" :class="entry.kind">
            <img :src="entry.imageUrl" :alt="entry.auraTitle || 'FocusMaxxer mugshot'" />
            <div class="gallery-card-copy">
              <strong>{{ entry.auraTitle }}</strong>
              <span>{{ entry.offense }}</span>
              <em>{{ entry.auraScore }}</em>
            </div>
          </article>
        </div>

        <div v-else class="gallery-empty">
          <h2>No legends archived yet</h2>
          <p>Rank-change mugshots will appear here during the demo.</p>
        </div>
      </template>
    </section>

    <section v-else-if="isAdmin" class="admin-screen">
      <div v-if="!adminAllowed" class="locked">
        <h1>Locked</h1>
        <p>Open with the admin PIN query string.</p>
      </div>

      <template v-else>
        <header class="admin-header">
          <p>{{ syncMode }}</p>
          <h1>FocusMaxxer Remote</h1>
        </header>

        <div class="button-grid">
          <button class="drop-button danger" type="button" @click="triggerPunishment">
            Force Punishment
          </button>
          <button class="drop-button calm" type="button" @click="releasePunishment">
            Release
          </button>
        </div>
      </template>
    </section>

    <section v-else class="viewer-screen">
      <div v-if="!started" class="start-panel-shell">
        <div class="start-bg" :style="{ backgroundImage: 'url(/images/rabbit.jpg)' }"></div>
        <div class="start-bg-tint"></div>
        <div class="start-panel-content">
          <p class="start-meta">{{ syncMode }}</p>
          <h1 class="start-title">FocusMaxxer</h1>
          <p class="start-bait">{{ startBaitText }}</p>
          <div class="start-online">
            <span class="rec-dot"></span>
            <strong>{{ formattedOnline }}</strong>
            <span>LOCKED IN RN</span>
          </div>
          <button class="start-button" type="button" :disabled="busy" @click="enterFocusMode">
            {{ ctaCopy }}
          </button>
          <p class="start-trust">ALLOW CAMERA. TRUST.</p>
        </div>
      </div>

      <template v-else>
        <video ref="selfieVideo" class="tracking-video" autoplay muted playsinline webkit-playsinline></video>

        <section class="dopamine-pane">
          <video
            ref="subwayVideo"
            class="subway-video"
            :src="subwaySrc"
            autoplay
            muted
            loop
            playsinline
            webkit-playsinline
            preload="auto"
            @error="handleMissingVideo('subway')"
          ></video>

          <div
            class="aura-hud"
            :class="{ negative: auraScore < 0, 'tier-up': tierUp }"
            :style="auraHudStyle"
          >
            <span class="aura-emoji">{{ auraEmoji }}</span>
            <span class="aura-title">{{ auraTitle }}</span>
            <span class="aura-score">
              <span class="aura-score-roll">{{ displayedAuraScore }}</span>
            </span>
            <div class="aura-sparkles">
              <span
                v-for="s in sparkles"
                :key="s.id"
                class="aura-sparkle"
                :style="{ left: s.left, top: s.top, '--sx': s.sx, '--sy': s.sy }"
              >
                {{ s.glyph }}
              </span>
            </div>
          </div>

          <div class="caption-strip">
            <span
              v-for="(word, i) in liveCaptionWords"
              :key="`${i}-${word}`"
              class="caption-word"
              :class="[
                `color-${(i % 4) + 1}`,
                { 'is-active': i === liveCaptionWords.length - 1 },
              ]"
              :style="{ animationDelay: (i * 28) + 'ms' }"
            >
              {{ word }}
            </span>
          </div>
        </section>

        <!-- surveillance HUD -->
        <div class="surveillance-hud">
          <div class="surveillance-row">
            <span class="rec-dot"></span>
            <span>REC</span>
            <span>{{ surveillanceTimestamp }}</span>
          </div>
          <div class="surveillance-row">
            <span>CASE: {{ archiveCaseNumber }}</span>
          </div>
        </div>

        <!-- system toasts -->
        <div class="system-toasts">
          <div
            v-for="t in toasts"
            :key="t.id"
            class="system-toast"
            :class="{ bad: t.kind === 'bad' }"
          >
            {{ t.text }}
          </div>
        </div>

        <!-- aura popup as police archive card -->
        <div v-if="auraPopupVisible" :key="auraPopupKey" class="aura-popup" :class="auraPopupKind">
          <div class="archive-card">
            <div class="archive-card-header">
              <span>FOCUSMAXXER PD</span>
              <span class="archive-case">{{ archiveCaseNumber }}</span>
            </div>
            <canvas ref="mugshotCanvas" class="mugshot-canvas"></canvas>
            <div class="archive-rapsheet">
              <div class="archive-row">
                <span class="archive-label">OFFENSE</span>
                <span>{{ archiveOffense }}</span>
              </div>
              <div class="archive-row">
                <span class="archive-label">{{ auraPopupKind === 'positive' ? 'AURA GAINED' : 'AURA REVOKED' }}</span>
                <span>{{ Math.abs(auraScore) }}</span>
              </div>
              <div class="archive-row">
                <span class="archive-label">RANK</span>
                <span>{{ auraPopupTitle.toUpperCase() }}</span>
              </div>
            </div>
            <div class="archive-barcode">
              <span v-for="(w, i) in archiveBars" :key="i" :style="{ width: w + 'px' }"></span>
            </div>
            <div class="archive-stamp" :class="auraPopupKind === 'positive' ? 'approved' : 'void'">
              {{ auraPopupKind === 'positive' ? 'RIZZED' : 'VOID' }}
            </div>
          </div>
        </div>

        <!-- punishment overlay -->
        <div v-show="punishmentActive" class="punishment-overlay">
          <video
            ref="punishmentVideo"
            class="punishment-video"
            :src="punishmentSrc"
            loop
            playsinline
            webkit-playsinline
            preload="auto"
            @error="handleMissingVideo('punishment')"
          ></video>
          <div class="punishment-siren"></div>

          <!-- fake Win98 error dialog -->
          <div class="fake-error" role="presentation">
            <div class="fake-error-titlebar">
              <span>focus.exe</span>
              <span class="fake-error-x">X</span>
            </div>
            <div class="fake-error-body">
              <span class="fake-error-icon">⚠️</span>
              <span>focus.exe has stopped responding. Aura leaking.</span>
            </div>
            <div class="fake-error-buttons">
              <span class="fake-error-button">OK</span>
              <span class="fake-error-button">CANCEL</span>
            </div>
          </div>

          <div class="punishment-text-stack">
            <div class="punishment-text">LOOK AT THE SCREEN</div>
            <div class="punishment-text tag-secondary">BRO IS COOKED</div>
            <div class="punishment-text tag-tertiary">-10000 AURA</div>
          </div>

          <button
            class="punishment-escape"
            type="button"
            aria-label="Silence punishment"
            @click="silencePunishment"
          >
            X
          </button>
        </div>

        <!-- cursed scanline + danger vignette layer (always present once started) -->
        <div class="cursed-layer"></div>
        <div class="danger-vignette" :style="{ '--vignette-opacity': vignetteOpacity }"></div>
      </template>
    </section>
  </main>
</template>

<style scoped>
/* component-local helpers for the pre-start screen */
.start-panel-shell {
  position: relative;
  width: 100%;
  height: 100svh;
  overflow: hidden;
}

.start-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  filter: contrast(1.15) saturate(1.2) brightness(0.65);
  animation: bg-drift 18s ease-in-out infinite alternate;
}

.start-bg-tint {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 20% 0%, rgba(255, 230, 0, 0.22), transparent 28rem),
    radial-gradient(circle at 90% 20%, rgba(255, 45, 85, 0.28), transparent 24rem),
    rgba(5, 5, 7, 0.55);
}

.start-panel-content {
  position: relative;
  z-index: 2;
  display: grid;
  align-content: center;
  width: min(100%, 560px);
  max-width: 100%;
  height: 100svh;
  margin: 0 auto;
  padding: max(24px, env(safe-area-inset-top)) clamp(14px, 4.5vw, 22px) max(24px, env(safe-area-inset-bottom));
  gap: 14px;
}

.start-meta {
  margin: 0;
  font-family: var(--font-terminal);
  color: var(--c-lime);
  letter-spacing: 0.08em;
  font-size: 1.05rem;
  text-shadow: 0 0 6px rgba(181, 255, 0, 0.5);
}

.start-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(2.4rem, 13vw, 7.2rem);
  line-height: 0.86;
  text-transform: uppercase;
  color: var(--c-yellow);
  word-break: keep-all;
  overflow-wrap: normal;
  text-shadow:
    0 3px 0 #000,
    3px 0 0 #000,
    -3px 0 0 #000,
    0 -3px 0 #000,
    6px 6px 0 var(--c-pink),
    -6px -3px 0 var(--c-cyan);
  animation: title-wobble 2s ease-in-out infinite alternate;
}

.start-bait {
  margin: 0;
  font-family: var(--font-tiktok);
  font-size: clamp(1.2rem, 5vw, 1.9rem);
  color: var(--c-paper);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  text-shadow:
    0 2px 0 #000,
    2px 0 0 #000,
    -2px 0 0 #000,
    0 -2px 0 #000,
    4px 4px 0 var(--c-pink);
  animation: bait-flash 1.4s steps(2, jump-none) infinite;
}

.start-online {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(5, 5, 7, 0.7);
  border: 1px solid rgba(181, 255, 0, 0.4);
  border-radius: 4px;
  font-family: var(--font-terminal);
  color: var(--c-lime);
  font-size: 1.1rem;
  width: max-content;
  text-shadow: 0 0 6px rgba(181, 255, 0, 0.5);
}

.start-online strong {
  color: var(--c-paper);
  font-size: 1.2em;
}

.start-trust {
  margin: 0;
  font-family: var(--font-cursed);
  font-weight: 700;
  font-size: 1rem;
  color: var(--c-pink);
  text-shadow: 0 0 8px rgba(255, 45, 85, 0.6);
  animation: trust-pulse 0.9s ease-in-out infinite alternate;
}

.start-button {
  position: relative;
  isolation: isolate;
  font-family: var(--font-display);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.start-button::before {
  content: '';
  position: absolute;
  inset: -4px;
  z-index: -1;
  border-radius: 12px;
  background: conic-gradient(
    from var(--angle, 0deg),
    var(--c-yellow),
    var(--c-pink),
    var(--c-cyan),
    var(--c-lime),
    var(--c-yellow)
  );
  animation: aura-spin 4s linear infinite;
}

@keyframes bg-drift {
  from {
    transform: scale(1.04) translate(0, 0);
  }
  to {
    transform: scale(1.12) translate(-1.5%, -1%);
  }
}

@keyframes title-wobble {
  from {
    transform: rotate(-1.5deg) translateY(0);
  }
  to {
    transform: rotate(1.5deg) translateY(-3px);
  }
}

@keyframes bait-flash {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0.6;
  }
}

@keyframes trust-pulse {
  from {
    transform: scale(1);
    opacity: 0.85;
  }
  to {
    transform: scale(1.04);
    opacity: 1;
  }
}

.app-shell.reduced-motion .start-bg,
.app-shell.reduced-motion .start-title,
.app-shell.reduced-motion .start-bait,
.app-shell.reduced-motion .start-trust {
  animation: none !important;
}
</style>
