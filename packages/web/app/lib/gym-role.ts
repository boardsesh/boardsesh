import type { Gym } from '@boardsesh/shared-schema';

/**
 * The viewer's standing at a gym, in precedence order. `owner` outranks any
 * `myRole` (owners are reported as gym admins by the backend), so the owner
 * check comes first.
 */
export type GymRoleKind = 'owner' | 'admin' | 'editor' | 'member';

/**
 * Resolve the viewer's standing at a gym. Returns null for a gym the viewer
 * only follows. Shared by the My Gyms drawer and the homepage gym card so both
 * surface the same role.
 *
 * Admin/editor rows only become reachable once `myGyms` includes gym_members
 * (staff-roles PR); until then every listed gym resolves to `owner`.
 */
export function resolveGymRole(gym: Gym, currentUserId: string | null): GymRoleKind | null {
  if (currentUserId && gym.ownerId === currentUserId) return 'owner';
  if (gym.myRole === 'admin') return 'admin';
  if (gym.myRole === 'editor') return 'editor';
  if (gym.myRole === 'member') return 'member';
  return null;
}
