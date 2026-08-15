import type { Climb } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

/** Minimal Climb shape the queue accessory and board-art thumbnail need. */
export function boardPresenceClimbToClimb(presenceClimb: BoardPresenceClimb): Climb {
  return {
    uuid: presenceClimb.climbUuid,
    name: presenceClimb.name ?? '',
    frames: presenceClimb.frames ?? '',
    setter_username: presenceClimb.setter ?? '',
    angle: presenceClimb.angle ?? 0,
    ascensionist_count: 0,
    difficulty: presenceClimb.grade ?? '',
    quality_average: '',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  };
}

/** Who lit a climb, ready to render. */
export type WallDriver = {
  /** Text shown beside the avatar. */
  label: string;
  /**
   * Name the avatar derives its initials from. Null for a climber we have no
   * name for, so the avatar renders its neutral placeholder disc instead of an
   * initial taken from the fallback label.
   */
  avatarName: string | null;
  /** True when we know a climber sent it but have no name to show. */
  isUnnamed: boolean;
};

/**
 * Resolve the attribution shown on a wall-feed entry, or null when nothing is
 * known about who sent it (an anonymous client, or a deleted account).
 *
 * A send whose climber has no display name still gets attribution. Around 7% of
 * `board_climb_events` rows were sent by accounts carrying no `users.name` and
 * no profile — Apple private-relay signups, mostly — and hiding the whole
 * avatar-plus-name block for those made older history read as though the rows
 * had lost their metadata.
 */
export function wallDriverForClimb(
  climb: Pick<BoardPresenceClimb, 'sentByDisplayName' | 'sentByUserId'>,
  unnamedLabel: string,
): WallDriver | null {
  const named = climb.sentByDisplayName?.trim();
  if (named) return { label: named, avatarName: named, isUnnamed: false };
  if (!climb.sentByUserId) return null;
  return { label: unnamedLabel, avatarName: null, isUnnamed: true };
}
