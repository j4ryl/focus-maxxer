import { initializeApp } from 'firebase/app';
import { getDatabase, onValue, push, ref, remove, set } from 'firebase/database';
import { getDownloadURL, getStorage, ref as storageRef, uploadBytes } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const punishmentPath = import.meta.env.VITE_FORCE_PUNISHMENT_PATH || '/demo/forcePunishment';
const hallOfFamePath = import.meta.env.VITE_HALL_OF_FAME_PATH || '/demo/hallOfFame';
const hasFirebaseConfig = Object.values(firebaseConfig).every(Boolean);
const localKey = 'focusmaxxer.forcePunishment';
const localHallKey = 'focusmaxxer.hallOfFame';
const channelName = 'focusmaxxer-demo';

let app;
let db;
let storage;
let channel;

function getLocalChannel() {
  if (!channel && 'BroadcastChannel' in window) {
    channel = new BroadcastChannel(channelName);
  }
  return channel;
}

async function ensureFirebase() {
  app = app || initializeApp(firebaseConfig);
  db = db || getDatabase(app);
  storage = storage || getStorage(app);
  return { db, storage };
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

    ensureFirebase().then(({ db: database }) => {
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
    const { db: database } = await ensureFirebase();
    await set(ref(database, punishmentPath), isForced === true);
    return;
  }

  localStorage.setItem(localKey, String(isForced === true));
  getLocalChannel()?.postMessage(isForced === true);
}

function readLocalGallery() {
  try {
    return JSON.parse(localStorage.getItem(localHallKey) || '[]');
  } catch {
    return [];
  }
}

export function subscribeHallOfFame(callback) {
  if (hasFirebaseConfig) {
    let disposed = false;
    let remoteUnsubscribe;

    ensureFirebase().then(({ db: database }) => {
      if (disposed) return;
      remoteUnsubscribe = onValue(ref(database, hallOfFamePath), (snapshot) => {
        const value = snapshot.val() || {};
        callback(
          Object.entries(value)
            .map(([id, item]) => ({ id, ...item }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
        );
      });
    });

    return () => {
      disposed = true;
      remoteUnsubscribe?.();
    };
  }

  callback(readLocalGallery());
  return () => {};
}

export async function uploadHallOfFameSnapshot({ blob, auraScore, auraTitle, offense, kind }) {
  const createdAt = Date.now();
  const entry = {
    auraScore,
    auraTitle,
    offense,
    kind,
    createdAt,
  };

  if (hasFirebaseConfig) {
    const { db: database, storage: firebaseStorage } = await ensureFirebase();
    const imagePath = `demo/hallOfFame/${createdAt}-${Math.random().toString(36).slice(2)}.jpg`;
    const imageRef = storageRef(firebaseStorage, imagePath);
    await uploadBytes(imageRef, blob, {
      contentType: blob.type || 'image/jpeg',
      cacheControl: 'public,max-age=31536000',
    });
    const imageUrl = await getDownloadURL(imageRef);
    await push(ref(database, hallOfFamePath), { ...entry, imagePath, imageUrl });
    return;
  }

  const reader = new FileReader();
  await new Promise((resolve, reject) => {
    reader.onload = resolve;
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const localEntry = { id: String(createdAt), ...entry, imageUrl: reader.result };
  const next = [localEntry, ...readLocalGallery()].slice(0, 80);
  localStorage.setItem(localHallKey, JSON.stringify(next));
}

export async function clearHallOfFame() {
  if (hasFirebaseConfig) {
    const { db: database } = await ensureFirebase();
    await remove(ref(database, hallOfFamePath));
    return;
  }

  localStorage.removeItem(localHallKey);
}
