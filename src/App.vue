<script setup>
import * as faceapi from 'face-api.js';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { isFirebaseEnabled, setForcePunishment, subscribeForcePunishment } from './sync';

const adminPin = import.meta.env.VITE_ADMIN_PIN || 'face-rot';
const route = ref(window.location.pathname);
const params = new URLSearchParams(window.location.search);
const isAdmin = computed(() => route.value.startsWith('/godmode'));
const adminAllowed = computed(() => !isAdmin.value || params.get('pin') === adminPin);
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
const caption = ref('WHEN THE PROFESSOR SAYS THIS WILL BE ON THE FINAL');
const auraScore = ref(20);
const auraPopupVisible = ref(false);
const auraPopupKind = ref('negative');
const auraPopupTitle = ref('Beta Status');
const auraPopupKey = ref(0);

const selfieVideo = ref(null);
const mugshotCanvas = ref(null);
const subwayVideo = ref(null);
const punishmentVideo = ref(null);

let unsubscribe;
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

const punishmentActive = computed(() => forcedPunishment.value || attentionLost.value);
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
const unsupportedReason = computed(() => {
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const isSecure = window.isSecureContext || isLocalhost;

  if (!isSecure) return 'Open over HTTPS so camera and microphone permissions work.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not expose camera access.';
  return '';
});

const fakeCaptions = [
  'BRO IS SPEAKING IN 1.25X SPEED',
  'POV: YOU ARE LOCKED IN ACADEMICALLY',
  'THE SLIDES ARE OPTIONAL BUT THE LORE IS NOT',
  'AVERAGE GROUP PROJECT SURVIVAL TECHNIQUE',
  'FOCUS LEVELS REACHING LEGALLY CONCERNING NUMBERS',
  'WHEN THE EXAMPLE HAS THREE EDGE CASES AND A DREAM',
];

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
    .slice(-120);
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

  context.textAlign = 'center';
  context.lineWidth = 10;
  context.strokeStyle = '#050507';
  context.fillStyle = kind === 'positive' ? '#ffe600' : '#ff2d55';
  context.font = '900 74px Impact, system-ui';
  context.strokeText(kind === 'positive' ? '😎' : '🤡', width / 2, 100);
  context.fillText(kind === 'positive' ? '😎' : '🤡', width / 2, 100);

  if (kind === 'negative') {
    context.fillStyle = '#ff2d55';
    context.beginPath();
    context.arc(width / 2, height * 0.48, 18, 0, Math.PI * 2);
    context.fill();
    context.font = '900 38px Impact, system-ui';
    context.strokeStyle = '#000';
    context.fillStyle = '#ffe600';
    context.strokeText('AURA DEBT', width / 2, height - 34);
    context.fillText('AURA DEBT', width / 2, height - 34);
  } else {
    context.font = '900 42px Impact, system-ui';
    context.strokeStyle = '#000';
    context.fillStyle = '#ffe600';
    context.strokeText('RIZZ RESTORED', width / 2, height - 34);
    context.fillText('RIZZ RESTORED', width / 2, height - 34);
  }
}

async function showAuraPopup(kind) {
  auraPopupKind.value = kind;
  auraPopupTitle.value = auraTitle.value;
  auraPopupKey.value += 1;
  auraPopupVisible.value = true;
  await nextTick();
  drawMugshotOverlay(kind);
  window.clearTimeout(auraPopupTimer);
  auraPopupTimer = window.setTimeout(() => {
    auraPopupVisible.value = false;
  }, 1500);
}

async function warmRankAudio() {
  rankUpAudio = new Audio('/audio/rank-up.mp3');
  rankDownAudio = new Audio('/audio/rank-down.mp3');

  for (const audio of [rankUpAudio, rankDownAudio]) {
    audio.preload = 'auto';
    audio.volume = 1;
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
  audio.volume = 1;
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
  }
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
  await nextTick();
  const video = punishmentVideo.value;
  if (!video) return;

  video.muted = false;
  video.volume = 1;
  video.currentTime = 0;
  try {
    await video.play();
  } catch {
    status.value = 'Tap once to unlock punishment audio';
  }
  startVibration();
}

function deactivatePunishment() {
  const video = punishmentVideo.value;
  video?.pause();
  if (video) video.currentTime = 0;
  stopVibration();
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
    punishment.volume = 1;
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

unsubscribe = subscribeForcePunishment((isForced) => {
  forcedPunishment.value = isForced;
});

onBeforeUnmount(() => {
  unsubscribe?.();
  window.clearInterval(detectionInterval);
  window.clearTimeout(auraPopupTimer);
  stopVibration();
  realtimeDataChannel?.close?.();
  realtimePeerConnection?.close?.();
  mediaStream?.getTracks().forEach((track) => track.stop());
});
</script>

<template>
  <main class="app-shell" :class="{ admin: isAdmin, started: started && !isAdmin, punishing: punishmentActive }">
    <section v-if="isAdmin" class="admin-screen">
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
      <div v-if="!started" class="start-panel">
        <p>{{ syncMode }}</p>
        <h1>FocusMaxxer</h1>
        <button class="start-button" type="button" :disabled="busy" @click="enterFocusMode">
          {{ busy ? 'Entering' : 'Enter Focus Mode' }}
        </button>
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
          <div class="aura-hud" :class="{ negative: auraScore < 0 }">
            <span>{{ auraTitle }}</span>
            <strong>{{ auraScore }}</strong>
          </div>
          <div class="caption-strip">{{ caption }}</div>
        </section>

        <div v-if="auraPopupVisible" :key="auraPopupKey" class="aura-popup" :class="auraPopupKind">
          <canvas ref="mugshotCanvas" class="mugshot-canvas"></canvas>
          <div class="aura-popup-copy">
            <span>{{ auraPopupKind === 'positive' ? '+ AURA' : '- AURA' }}</span>
            <strong>{{ auraPopupTitle }}</strong>
          </div>
        </div>

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
          <div class="punishment-text">LOOK AT THE SCREEN</div>
        </div>
      </template>
    </section>
  </main>
</template>
