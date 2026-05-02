import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, onValue, ref, set } from 'firebase/database';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const punishmentPath = import.meta.env.VITE_FORCE_PUNISHMENT_PATH || '/demo/forcePunishment';
const hasFirebaseConfig = Object.values(firebaseConfig).every(Boolean);
const localKey = 'focusmaxxer.forcePunishment';
const channelName = 'focusmaxxer-demo';

let app;
let auth;
let db;
let authPromise;
let channel;

function getLocalChannel() {
  if (!channel && 'BroadcastChannel' in window) {
    channel = new BroadcastChannel(channelName);
  }
  return channel;
}

async function ensureFirebase() {
  app = app || initializeApp(firebaseConfig);
  auth = auth || getAuth(app);
  db = db || getDatabase(app);
  authPromise = authPromise || signInAnonymously(auth).catch(() => undefined);
  await authPromise;
  return db;
}

function readLocalPunishment() {
  return localStorage.getItem(localKey) === 'true';
}

export function isFirebaseEnabled() {
  return hasFirebaseConfig;
}

export function subscribeForcePunishment(callback) {
  if (hasFirebaseConfig) {
    let disposed = false;
    let remoteUnsubscribe;

    ensureFirebase().then((database) => {
      if (disposed) return;
      remoteUnsubscribe = onValue(ref(database, punishmentPath), (snapshot) => {
        callback(snapshot.val() === true);
      });
    });

    return () => {
      disposed = true;
      remoteUnsubscribe?.();
    };
  }

  callback(readLocalPunishment());

  const localChannel = getLocalChannel();
  const onStorage = (event) => {
    if (event.key === localKey) callback(event.newValue === 'true');
  };
  const onMessage = (event) => callback(event.data === true);

  window.addEventListener('storage', onStorage);
  localChannel?.addEventListener('message', onMessage);

  return () => {
    window.removeEventListener('storage', onStorage);
    localChannel?.removeEventListener('message', onMessage);
  };
}

export async function setForcePunishment(isForced) {
  if (hasFirebaseConfig) {
    const database = await ensureFirebase();
    await set(ref(database, punishmentPath), isForced === true);
    return;
  }

  localStorage.setItem(localKey, String(isForced === true));
  getLocalChannel()?.postMessage(isForced === true);
}
