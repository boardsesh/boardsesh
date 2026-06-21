// Session types

export type SessionConnectionState = 'CONNECTED' | 'RECONNECTING';

export type SessionUser = {
  id: string;
  username: string;
  isLeader: boolean;
  avatarUrl?: string;
  /** Stable database user UUID (null for unauthenticated connections) */
  userId?: string | null;
  connectionState: SessionConnectionState;
};

export type SessionGradeCount = {
  grade: string;
  /** Total ascents (flash + send). Deprecated — kept additive for old clients. */
  count: number;
  flash: number;
  send: number;
  attempt: number;
};

export type SessionHardestClimb = {
  climbUuid: string;
  climbName: string;
  grade: string;
  /** Lit-hold frames string for rendering a thumbnail; null for legacy climbs. */
  frames?: string | null;
  /** Board layout id, needed to render the thumbnail. */
  layoutId?: number | null;
  /** Board type the send was logged on (e.g. 'kilter', 'tension'). */
  boardType?: string | null;
  /** Whether the send was on the mirrored climb. */
  isMirror?: boolean | null;
};

export type SessionParticipant = {
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  sends: number;
  flashes: number;
  attempts: number;
};

export type SessionSummary = {
  sessionId: string;
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  gradeDistribution: SessionGradeCount[];
  hardestClimb?: SessionHardestClimb | null;
  participants: SessionParticipant[];
  startedAt?: string | null;
  endedAt?: string | null;
  durationMinutes?: number | null;
  goal?: string | null;
};

export type SessionHealthExportLap = {
  tickUuid: string;
  climbUuid: string;
  climbName?: string | null;
  grade?: string | null;
  status: string;
  attemptCount: number;
  boardType: string;
  angle?: number | null;
  climbedAt: string;
};

export type SessionHealthExport = {
  sessionId: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMinutes?: number | null;
  boardType: string;
  totalSends: number;
  totalAttempts: number;
  hardestClimb?: SessionHardestClimb | null;
  laps: SessionHealthExportLap[];
  healthKitWorkoutId?: string | null;
};

/**
 * Durable session lifecycle status. Only 'active' and 'ended' are ever
 * written: live presence moved to Redis, so the abandoned 'inactive' value
 * survives only in the legacy DB CHECK (backend migration
 * 0005_session_status_tracking.sql). The sessionStatus resolver normalizes
 * any such legacy row to 'active'.
 */
export type SessionStatus = 'active' | 'ended';
