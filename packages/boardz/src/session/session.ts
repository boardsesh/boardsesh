import type { TickStatus } from '@boardsesh/shared-schema';

// A Boardz session lives on the phone. Ticks are saved to Boardsesh as they are
// logged, and Boardsesh groups them into sessions on its own from their
// timestamps, so nothing here has to be sent to the server.

export type SessionTick = {
  /** Local id, stable from the moment the climber logs. */
  id: string;
  /** Boardsesh's tick uuid once saved; lets the climber undo it. */
  serverUuid: string | null;
  climbUuid: string;
  climbName: string;
  /** The climb's catalogue grade, when it has one. */
  difficultyId: number | null;
  status: TickStatus;
  attempts: number;
  loggedAt: string;
};

export type Session = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  boardLabel: string;
  angle: number;
  ticks: SessionTick[];
};

export type SessionSummary = {
  durationMs: number;
  /** Sends including flashes. */
  sends: number;
  flashes: number;
  /** Every try across every climb, sends included. */
  attempts: number;
  /** Distinct climbs logged. */
  climbs: number;
  hardestSendDifficultyId: number | null;
};

export function startSession(input: { id: string; now: Date; boardLabel: string; angle: number }): Session {
  return {
    id: input.id,
    startedAt: input.now.toISOString(),
    endedAt: null,
    boardLabel: input.boardLabel,
    angle: input.angle,
    ticks: [],
  };
}

export function withTick(session: Session, tick: SessionTick): Session {
  return { ...session, ticks: [...session.ticks, tick] };
}

export function withoutTick(session: Session, tickId: string): Session {
  return { ...session, ticks: session.ticks.filter((tick) => tick.id !== tickId) };
}

export function withServerUuid(session: Session, tickId: string, serverUuid: string): Session {
  return {
    ...session,
    ticks: session.ticks.map((tick) => (tick.id === tickId ? { ...tick, serverUuid } : tick)),
  };
}

export function endSession(session: Session, now: Date): Session {
  return session.endedAt ? session : { ...session, endedAt: now.toISOString() };
}

export function summarizeSession(session: Session, now: Date): SessionSummary {
  const endMs = session.endedAt ? Date.parse(session.endedAt) : now.getTime();
  let sends = 0;
  let flashes = 0;
  let attempts = 0;
  let hardestSendDifficultyId: number | null = null;
  for (const tick of session.ticks) {
    attempts += tick.attempts;
    if (tick.status === 'attempt') continue;
    sends += 1;
    if (tick.status === 'flash') flashes += 1;
    if (
      tick.difficultyId !== null &&
      (hardestSendDifficultyId === null || tick.difficultyId > hardestSendDifficultyId)
    ) {
      hardestSendDifficultyId = tick.difficultyId;
    }
  }
  return {
    durationMs: Math.max(0, endMs - Date.parse(session.startedAt)),
    sends,
    flashes,
    attempts,
    climbs: new Set(session.ticks.map((tick) => tick.climbUuid)).size,
    hardestSendDifficultyId,
  };
}

/**
 * How each climb went this session, by climb uuid. A send stays a send even
 * when later tries on the same climb were logged as attempts.
 */
export function climbStatuses(ticks: readonly SessionTick[]): Map<string, TickStatus> {
  const statuses = new Map<string, TickStatus>();
  for (const tick of ticks) {
    const current = statuses.get(tick.climbUuid);
    if (current === undefined || current === 'attempt') statuses.set(tick.climbUuid, tick.status);
  }
  return statuses;
}

/** "1:05:09" or "4:07" for a session clock. */
export function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`;
}

const TICK_STATUSES: readonly string[] = ['flash', 'send', 'attempt'] satisfies TickStatus[];

function isSessionTick(value: unknown): value is SessionTick {
  if (typeof value !== 'object' || value === null) return false;
  const tick = value as Record<string, unknown>;
  return (
    typeof tick.id === 'string' &&
    (tick.serverUuid === null || typeof tick.serverUuid === 'string') &&
    typeof tick.climbUuid === 'string' &&
    typeof tick.climbName === 'string' &&
    (tick.difficultyId === null || typeof tick.difficultyId === 'number') &&
    typeof tick.status === 'string' &&
    TICK_STATUSES.includes(tick.status) &&
    typeof tick.attempts === 'number' &&
    typeof tick.loggedAt === 'string'
  );
}

export function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.id === 'string' &&
    typeof session.startedAt === 'string' &&
    (session.endedAt === null || typeof session.endedAt === 'string') &&
    typeof session.boardLabel === 'string' &&
    typeof session.angle === 'number' &&
    Array.isArray(session.ticks) &&
    session.ticks.every(isSessionTick)
  );
}
