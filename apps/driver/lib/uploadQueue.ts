/**
 * Offline-tolerant document upload queue.
 *
 * Background: document uploads can't ride the React Query mutation queue
 * because the FormData payload (with a binary file blob) doesn't survive
 * AsyncStorage serialization. Instead we persist the *metadata* — file
 * URI + form fields — and re-construct the FormData at replay time.
 *
 * Flow:
 *   1. Caller invokes enqueueUpload(args) while offline (or always —
 *      see below).
 *   2. The file at `args.fileUri` is copied into the app's document
 *      directory so iOS doesn't purge it from the cache dir before
 *      we get a chance to retry.
 *   3. An entry is appended to AsyncStorage at QUEUE_KEY.
 *   4. drainQueue() is invoked from the NetInfo online listener and at
 *      app start. It walks each entry, attempts uploadDocument, and on
 *      success removes the entry + deletes the copied file. On failure
 *      it bumps `attempts` and surfaces the error to subscribers (e.g.
 *      a "couldn't upload after 5 tries" toast) without dropping.
 *   5. UI components can `subscribe()` to be notified when the queue
 *      changes so a pending-count badge stays in sync.
 *
 * The queue does NOT enforce ordering across drains — if two uploads
 * are queued and one fails mid-drain, the rest still get attempted.
 * Failures stay in the queue for the next drain cycle.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { uploadDocument, type DocumentKind } from "@/lib/api/documents";

const QUEUE_KEY = "fleetcal-upload-queue-v1";
const COPY_DIR  = `${FileSystem.documentDirectory ?? ""}upload-queue/`;

export interface PendingUpload {
  id:         string;
  fileUri:    string;     // points into COPY_DIR after enqueue
  fileName:   string;
  mimeType:   string;
  eventId:    string;
  orgId:      string;
  driverId:   number;
  driverName?: string;
  kind:       DocumentKind;
  enqueuedAt: number;
  attempts:   number;
  lastError?: string;
}

type Listener = (queue: PendingUpload[]) => void;
const listeners = new Set<Listener>();

async function ensureCopyDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(COPY_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(COPY_DIR, { intermediates: true });
    }
  } catch (err) {
    console.warn("uploadQueue: ensureCopyDir failed", err);
  }
}

async function readQueue(): Promise<PendingUpload[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: PendingUpload[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  for (const l of listeners) l(queue);
}

/** Subscribe to queue mutations. Returns an unsubscribe fn. */
export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  // Fire once with current state so the subscriber doesn't have to
  // race the first writeQueue.
  void readQueue().then(cb);
  return () => { listeners.delete(cb); };
}

export async function getPending(): Promise<PendingUpload[]> {
  return readQueue();
}

/**
 * Enqueue a pending upload. Copies the source file into the app's
 * documents directory so it survives a cache purge. Returns the
 * persisted entry.
 */
export async function enqueueUpload(args: {
  fileUri:    string;
  fileName:   string;
  mimeType:   string;
  eventId:    string;
  orgId:      string;
  driverId:   number;
  driverName?: string;
  kind:       DocumentKind;
}): Promise<PendingUpload> {
  await ensureCopyDir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = args.fileName.includes(".") ? args.fileName.slice(args.fileName.lastIndexOf(".")) : "";
  const copyUri = `${COPY_DIR}${id}${ext}`;
  try {
    await FileSystem.copyAsync({ from: args.fileUri, to: copyUri });
  } catch (err) {
    console.warn("uploadQueue: copy failed, falling back to original uri", err);
  }
  const entry: PendingUpload = {
    id,
    fileUri:    copyUri,
    fileName:   args.fileName,
    mimeType:   args.mimeType,
    eventId:    args.eventId,
    orgId:      args.orgId,
    driverId:   args.driverId,
    driverName: args.driverName,
    kind:       args.kind,
    enqueuedAt: Date.now(),
    attempts:   0,
  };
  const queue = await readQueue();
  queue.push(entry);
  await writeQueue(queue);
  return entry;
}

async function removeFromQueue(id: string): Promise<void> {
  const queue = await readQueue();
  const next = queue.filter(e => e.id !== id);
  await writeQueue(next);
  // Clean up the copied file — best-effort, ignore failures.
  const removed = queue.find(e => e.id === id);
  if (removed && removed.fileUri.startsWith(COPY_DIR)) {
    try { await FileSystem.deleteAsync(removed.fileUri, { idempotent: true }); } catch {}
  }
}

async function markAttemptFailed(id: string, error: string): Promise<void> {
  const queue = await readQueue();
  const next = queue.map(e => e.id === id ? { ...e, attempts: e.attempts + 1, lastError: error } : e);
  await writeQueue(next);
}

let draining = false;

/**
 * Attempt to upload every pending entry. Safe to call concurrently —
 * a per-process flag prevents overlapping drains so we don't double-
 * upload. Returns the count of uploads that succeeded.
 *
 * The `onUploaded` callback fires once per successful upload so the
 * caller (in _layout) can invalidate the documents query.
 */
export async function drainQueue(onUploaded?: (entry: PendingUpload) => void): Promise<number> {
  if (draining) return 0;
  draining = true;
  let succeeded = 0;
  try {
    const queue = await readQueue();
    for (const entry of queue) {
      try {
        await uploadDocument({
          fileUri:    entry.fileUri,
          fileName:   entry.fileName,
          mimeType:   entry.mimeType,
          eventId:    entry.eventId,
          orgId:      entry.orgId,
          driverId:   entry.driverId,
          driverName: entry.driverName,
          kind:       entry.kind,
        });
        await removeFromQueue(entry.id);
        succeeded++;
        onUploaded?.(entry);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markAttemptFailed(entry.id, msg);
        // Don't abort the loop on a single failure — other entries
        // may target different events and still succeed.
      }
    }
  } finally {
    draining = false;
  }
  return succeeded;
}
