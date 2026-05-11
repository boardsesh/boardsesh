import type { BoardName } from '@/app/lib/types';
import type { TickStatus } from '@/app/hooks/use-logbook';
import { createIndexedDBStore } from './idb-helper';
import { assignLocalSession, applySessionStatsDelta, type SessionStatsDelta } from './local-sessions-db';

const STORE_NAME = 'local-ticks';

export type LocalTick = {
  uuid: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  comment: string;
  climbedAt: string;
  videoUrl: string | null;
  boardName: BoardName;
  layoutId: number | null;
  sizeId: number | null;
  setIds: string | null;
  localSessionId: string;
};

const getDB = createIndexedDBStore('boardsesh-local-ticks', STORE_NAME, 1, (db) => {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    const store = db.createObjectStore(STORE_NAME, { keyPath: 'uuid' });
    store.createIndex('climbUuid', 'climbUuid');
    store.createIndex('climbedAt', 'climbedAt');
    store.createIndex('localSessionId', 'localSessionId');
  }
});

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function deltaForStatus(status: TickStatus, climbedAt: string): SessionStatsDelta {
  let sends = 0;
  let flashes = 0;
  let attempts = 0;
  if (status === 'flash') {
    sends = 1;
    flashes = 1;
  } else if (status === 'send') {
    sends = 1;
  } else {
    attempts = 1;
  }
  return {
    sendsDelta: sends,
    flashesDelta: flashes,
    attemptsDelta: attempts,
    tickCountDelta: 1,
    climbedAt,
  };
}

export type SaveLocalTickInput = Omit<LocalTick, 'uuid' | 'localSessionId'>;

let persistRequested = false;

async function requestPersistentStorage(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  try {
    await navigator.storage.persist();
  } catch {
    // Best-effort — browser may decline. The data is still in IndexedDB.
  }
}

export async function saveLocalTick(input: SaveLocalTickInput): Promise<LocalTick | null> {
  const db = await getDB();
  if (!db) return null;

  // Ask the browser to mark our storage as persistent so it doesn't get
  // evicted under pressure. Safe to call repeatedly — we no-op after first try.
  void requestPersistentStorage();

  const assignment = await assignLocalSession({
    climbedAt: input.climbedAt,
    boardName: input.boardName,
    layoutId: input.layoutId,
    sizeId: input.sizeId,
    setIds: input.setIds,
    defaultAngle: input.angle,
  });
  if (!assignment) return null;

  const tick: LocalTick = {
    ...input,
    uuid: randomUuid(),
    localSessionId: assignment.sessionId,
  };
  await db.put(STORE_NAME, tick);
  await applySessionStatsDelta(assignment.sessionId, deltaForStatus(input.status, input.climbedAt));
  return tick;
}

export async function listAllLocalTicks(): Promise<LocalTick[]> {
  const db = await getDB();
  if (!db) return [];
  return (await db.getAll(STORE_NAME)) as LocalTick[];
}

export async function listLocalTicksForClimbs(climbUuids: readonly string[]): Promise<LocalTick[]> {
  if (climbUuids.length === 0) return [];
  const db = await getDB();
  if (!db) return [];
  const tx = db.transaction(STORE_NAME, 'readonly');
  const index = tx.store.index('climbUuid');
  const lookups = await Promise.all(climbUuids.map((uuid) => index.getAll(uuid)));
  await tx.done;
  return lookups.flat() as LocalTick[];
}

export async function deleteLocalTick(uuid: string): Promise<LocalTick | null> {
  const db = await getDB();
  if (!db) return null;
  const tick = (await db.get(STORE_NAME, uuid)) as LocalTick | undefined;
  if (!tick) return null;
  await db.delete(STORE_NAME, uuid);
  const reverseDelta = deltaForStatus(tick.status, tick.climbedAt);
  await applySessionStatsDelta(tick.localSessionId, {
    sendsDelta: -reverseDelta.sendsDelta,
    flashesDelta: -reverseDelta.flashesDelta,
    attemptsDelta: -reverseDelta.attemptsDelta,
    tickCountDelta: -reverseDelta.tickCountDelta,
    climbedAt: tick.climbedAt,
  });
  return tick;
}

export async function clearAllLocalTicks(): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.clear(STORE_NAME);
}
