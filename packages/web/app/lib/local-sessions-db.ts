import { v5 as uuidv5 } from 'uuid';
import type { BoardName } from '@/app/lib/types';
import { createIndexedDBStore } from './idb-helper';
import { getInstallationId } from './local-installation-db';

const STORE_NAME = 'local-sessions';
const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

// Same namespace the server-side inferred-session builder uses
// (packages/web/app/lib/data-sync/aurora/inferred-session-builder.ts). Keeping it
// identical means an account-upgrade migration can replay local ticks and end
// up with stable session IDs that match the server's own grouping rules.
const INFERRED_SESSION_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

export type LocalSession = {
  id: string;
  firstTickAt: string;
  lastTickAt: string;
  endedAt: string | null;
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
  boardName: BoardName;
  layoutId: number | null;
  sizeId: number | null;
  setIds: string | null;
  defaultAngle: number | null;
  healthKitWorkoutId?: string | null;
  healthConnectRecordId?: string | null;
};

const getDB = createIndexedDBStore('boardsesh-local-sessions', STORE_NAME);

function generateLocalSessionId(installationId: string, firstTickAt: string): string {
  return uuidv5(`${installationId}:${firstTickAt}`, INFERRED_SESSION_NAMESPACE);
}

export async function listLocalSessions(): Promise<LocalSession[]> {
  const db = await getDB();
  if (!db) return [];
  const all = (await db.getAll(STORE_NAME)) as LocalSession[];
  return all.sort((a, b) => new Date(b.firstTickAt).getTime() - new Date(a.firstTickAt).getTime());
}

export async function getLocalSession(sessionId: string): Promise<LocalSession | null> {
  const db = await getDB();
  if (!db) return null;
  const session = (await db.get(STORE_NAME, sessionId)) as LocalSession | undefined;
  return session ?? null;
}

type AssignSessionInput = {
  climbedAt: string;
  boardName: BoardName;
  layoutId: number | null;
  sizeId: number | null;
  setIds: string | null;
  defaultAngle: number | null;
};

export type AssignSessionResult = {
  sessionId: string;
};

/**
 * Assign a tick to a local session using the same 4-hour-gap rule the server
 * uses for inferred sessions. Creates a new session if none is open within
 * the gap, otherwise extends the existing one. Caller is responsible for
 * persisting the tick itself and then calling `recalculateLocalSessionStats`.
 */
export async function assignLocalSession(input: AssignSessionInput): Promise<AssignSessionResult | null> {
  const installationId = await getInstallationId();
  if (!installationId) return null;

  const db = await getDB();
  if (!db) return null;

  const climbedAtMs = new Date(input.climbedAt).getTime();
  const all = (await db.getAll(STORE_NAME)) as LocalSession[];

  // Find an open session within the 4-hour gap that matches this board config.
  // We scope grouping to a specific board configuration so that switching gyms
  // mid-day starts a new session rather than fusing them.
  const candidate = all
    .filter(
      (s) =>
        s.endedAt === null &&
        s.boardName === input.boardName &&
        s.layoutId === input.layoutId &&
        s.sizeId === input.sizeId &&
        s.setIds === input.setIds,
    )
    .sort((a, b) => new Date(b.lastTickAt).getTime() - new Date(a.lastTickAt).getTime())[0];

  if (candidate) {
    const lastTickMs = new Date(candidate.lastTickAt).getTime();
    const firstTickMs = new Date(candidate.firstTickAt).getTime();
    if (Math.abs(climbedAtMs - lastTickMs) <= SESSION_GAP_MS || Math.abs(climbedAtMs - firstTickMs) <= SESSION_GAP_MS) {
      const updated: LocalSession = {
        ...candidate,
        firstTickAt: climbedAtMs < firstTickMs ? input.climbedAt : candidate.firstTickAt,
        lastTickAt: climbedAtMs > lastTickMs ? input.climbedAt : candidate.lastTickAt,
      };
      await db.put(STORE_NAME, updated, updated.id);
      return { sessionId: updated.id };
    }
  }

  const sessionId = generateLocalSessionId(installationId, input.climbedAt);
  const existing = (await db.get(STORE_NAME, sessionId)) as LocalSession | undefined;
  if (existing) {
    return { sessionId };
  }

  const fresh: LocalSession = {
    id: sessionId,
    firstTickAt: input.climbedAt,
    lastTickAt: input.climbedAt,
    endedAt: null,
    totalSends: 0,
    totalFlashes: 0,
    totalAttempts: 0,
    tickCount: 0,
    boardName: input.boardName,
    layoutId: input.layoutId,
    sizeId: input.sizeId,
    setIds: input.setIds,
    defaultAngle: input.defaultAngle,
    healthKitWorkoutId: null,
    healthConnectRecordId: null,
  };
  await db.put(STORE_NAME, fresh, sessionId);
  return { sessionId };
}

export type SessionStatsDelta = {
  sendsDelta: number;
  flashesDelta: number;
  attemptsDelta: number;
  tickCountDelta: number;
  climbedAt: string;
};

export async function applySessionStatsDelta(sessionId: string, delta: SessionStatsDelta): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const session = (await db.get(STORE_NAME, sessionId)) as LocalSession | undefined;
  if (!session) return;

  const ts = new Date(delta.climbedAt).getTime();
  const firstMs = new Date(session.firstTickAt).getTime();
  const lastMs = new Date(session.lastTickAt).getTime();

  const updated: LocalSession = {
    ...session,
    totalSends: Math.max(0, session.totalSends + delta.sendsDelta),
    totalFlashes: Math.max(0, session.totalFlashes + delta.flashesDelta),
    totalAttempts: Math.max(0, session.totalAttempts + delta.attemptsDelta),
    tickCount: Math.max(0, session.tickCount + delta.tickCountDelta),
    firstTickAt: ts < firstMs ? delta.climbedAt : session.firstTickAt,
    lastTickAt: ts > lastMs ? delta.climbedAt : session.lastTickAt,
  };
  await db.put(STORE_NAME, updated, sessionId);
}

export async function clearAllLocalSessions(): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.clear(STORE_NAME);
}
