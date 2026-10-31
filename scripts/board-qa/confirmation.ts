import type { CatalogClimb } from './config';
import type { FixtureBoard } from './fixture';
import type { Snapshot } from './backend';
import { canonical, QaFailure } from './evidence';

/** A takeover must displace the peer's live writer, not reconnect a free wall. */
export function requireTakeoverBaseline(
  physical: FixtureBoard,
  presence: Snapshot,
  climb: CatalogClimb,
  expectedPeer: string,
  angle: number,
): void {
  const current = presence.recent[0];
  if (
    physical.connections !== 1 ||
    physical.handles.length !== 1 ||
    !physical.handles.includes(physical.connectionHandle) ||
    physical.connectionGeneration <= 0 ||
    physical.sequence <= 0 ||
    canonical(physical.commands) !== canonical(climb.commands) ||
    presence.holder?.userId !== expectedPeer ||
    current?.climbUuid !== climb.uuid ||
    current.sentByUserId !== expectedPeer ||
    current.angle !== angle ||
    current.mirrored !== false
  )
    throw new QaFailure('Takeover requires the expected peer actively holding and lighting this same climb', 'blocked');
}

export function requireSessionIdentity(
  users: Record<string, unknown>[],
  expected: { userId: string; displayName: string; avatarUrl: string | null },
): void {
  if (
    !users.some(
      (user) =>
        user.userId === expected.userId &&
        user.connectionState === 'CONNECTED' &&
        user.username === expected.displayName &&
        (expected.avatarUrl === null || user.avatarUrl === expected.avatarUrl),
    )
  )
    throw new QaFailure('Session roster lost the signed-in profile identity');
}

/** Check peripheral evidence before using any app/backend signal as success. */
export function requirePhysicalDelivery(
  before: FixtureBoard,
  after: FixtureBoard,
  climb: CatalogClimb,
  newConnection: boolean,
  multiChunk: boolean,
): void {
  if (
    after.uuid !== before.uuid ||
    after.sequence <= before.sequence ||
    after.updates <= before.updates ||
    after.writes <= before.writes
  )
    throw new QaFailure('No fresh complete payload for the intended board');
  if (canonical(after.commands) !== canonical(climb.commands))
    throw new QaFailure('Decoded physical payload differs from the selected climb');
  if (after.rejected !== before.rejected || after.connections !== 1 || !after.handles.includes(after.connectionHandle))
    throw new QaFailure('Unexpected parser rejection or physical writer ownership');
  if (
    newConnection
      ? after.connectionGeneration <= before.connectionGeneration
      : after.connectionGeneration !== before.connectionGeneration || after.connectionHandle !== before.connectionHandle
  )
    throw new QaFailure('Confirmed command came from an unexpected BLE connection generation');
  if (multiChunk && after.writes - before.writes < 2)
    throw new QaFailure('Multi-chunk scenario delivered fewer than two physical writes');
}
