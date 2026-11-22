import { Fragment, type ReactNode } from 'react';
import { useAuth } from '../../providers/auth-provider';
import { useStoredUserId } from '../../hooks/use-current-user-id';

/** A resumed login owns local recovery too; a changed account starts a new editor session. */
export function SprayHoldEditorSessionBoundary({
  wallUuid,
  versionId,
  children,
}: {
  wallUuid: string;
  versionId: string;
  children: (storageUserId: string | null) => ReactNode;
}) {
  const { isAuthenticated } = useAuth();
  const { userId } = useStoredUserId(isAuthenticated);
  // Disabled queries can retain cached data until auth cleanup finishes.
  const storageUserId = isAuthenticated ? (userId ?? null) : null;
  return (
    <Fragment key={`${storageUserId ?? 'signed-out'}:${wallUuid}:${versionId}`}>{children(storageUserId)}</Fragment>
  );
}
