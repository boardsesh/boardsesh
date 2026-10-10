import { useAuth } from '../providers/auth-provider';
import { useProfile } from '../lib/graphql/hooks';
import { useStoredUserId } from './use-current-user-id';

/**
 * The signed-in climber's id, for an ownership check against a board's
 * `ownerId`.
 *
 * The profile's when it has loaded, else the one the device holds
 * (`useStoredUserId`), so a start with no signal still knows whose wall this
 * is. Null when signed out and while neither has answered, which a caller must
 * read as "not known to be the owner", never as "somebody else".
 */
export function useViewerUserId(): string | null {
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId } = useStoredUserId(isAuthenticated && !profile?.id);
  return profile?.id ?? storedUserId ?? null;
}
