const DB_NAME = 'modforge-studio';
const DB_VERSION = 1;
let opened;

export function openDb() {
  if (opened) return opened;
  opened = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('mods')) db.createObjectStore('mods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = null; reject(request.error); };
  });
  return opened;
}

async function request(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode), req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error || new Error('Транзакция прервана.'));
  });
}

export const getAll = (store) => request(store, 'readonly', (s) => s.getAll());
export const put = (store, value) => request(store, 'readwrite', (s) => s.put(value));
export const deleteOne = (store, key) => request(store, 'readwrite', (s) => s.delete(key));
export async function clearAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['mods', 'profiles'], 'readwrite'); tx.objectStore('mods').clear(); tx.objectStore('profiles').clear();
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
