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
