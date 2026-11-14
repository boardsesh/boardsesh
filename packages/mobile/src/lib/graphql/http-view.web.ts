import type { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { sameBrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import type { BrowserHttpView } from '@boardsesh/auth-protocol/browser-backend-http-view';
import type { WebAuthIdentity } from '../auth-store.web';

/** Capture the store and actual central-reader manager together. A manager
 * notification alone cannot publish B while the host still holds A's identity.
 * These private labels never authorize or reconstruct a backend credential. */
export function captureBrowserHttpView(options: {
  readonly backendClient: ReturnType<typeof createBrowserBackendClient>;
  readonly captureGeneration: () => number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly captureIdentity: () => WebAuthIdentity | null;
  readonly confirmedAnonymous: () => boolean;
}): BrowserHttpView {
  const { backendClient, captureGeneration, isGenerationCurrent, captureIdentity, confirmedAnonymous } = options;
  const initial = backendClient.getSnapshot();
  const selected = backendClient.isSelected();
  const generation = captureGeneration();
  const identity = captureIdentity();
  const originalIdentity = identity ? { userId: identity.userId, authSessionId: identity.authSessionId } : null;
  const owner = initial.owner ? { ...initial.owner, cursor: { ...initial.owner.cursor } } : null;
  if (initial.closed || !Number.isSafeInteger(generation) || generation < 0)
    throw new BrowserBackendConsumerError('unavailable');
  const anonymous = confirmedAnonymous();
  const kind =
    selected && owner
      ? 'selected'
      : anonymous && owner === null && identity === null
        ? 'anonymous'
        : !selected && identity
          ? 'legacy'
          : null;
  if (
    kind === null ||
    (kind === 'selected' &&
      (!identity?.browserSelection ||
        !owner ||
        identity.userId !== owner.userId ||
        identity.authSessionId !== owner.authSessionId ||
        !sameBrowserBackendLeaseOwner(identity.browserSelection, owner)))
  )
    throw new BrowserBackendConsumerError('unavailable');
  const isCurrent = () => {
    try {
      const current = backendClient.getSnapshot();
      if (
        current.closed ||
        current.revision !== initial.revision ||
        backendClient.isSelected() !== selected ||
        !isGenerationCurrent(generation)
      )
        return false;
      if (kind === 'anonymous')
        return (
          current.owner === null &&
          captureIdentity() === null &&
          confirmedAnonymous() &&
          (!selected || backendClient.isAnonymous())
        );
      const currentIdentity = captureIdentity();
      if (
        !currentIdentity ||
        currentIdentity.userId !== originalIdentity?.userId ||
        currentIdentity.authSessionId !== originalIdentity.authSessionId
      )
        return false;
      if (kind === 'legacy') return current.owner === null && !confirmedAnonymous();
      return (
        current.owner !== null &&
        owner !== null &&
        currentIdentity.browserSelection !== undefined &&
        sameBrowserBackendLeaseOwner(current.owner, owner) &&
        sameBrowserBackendLeaseOwner(currentIdentity.browserSelection, owner)
      );
    } catch {
      return false;
    }
  };
  if (!isCurrent()) throw new BrowserBackendConsumerError('unavailable');
  return Object.freeze({
    kind,
    key: JSON.stringify([kind, selected, generation, initial.revision, owner, originalIdentity]),
    isCurrent,
  });
}
