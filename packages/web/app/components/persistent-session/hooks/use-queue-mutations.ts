import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useQueueMutations as useSharedQueueMutations,
  type QueueMutationsActions as SharedQueueMutationsActions,
} from '@boardsesh/queue-react';
import { useSnackbar } from '../../providers/snackbar-provider';
import type { Client } from '../../graphql-queue/graphql-client';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { type Session, toClimbQueueItemInput } from '../types';

const RATE_LIMIT_TOAST_DEBOUNCE_MS = 10_000;

type UseQueueMutationsArgs = {
  client: Client | null;
  session: Session | null;
};

// The queue-session mutations, typed with the web's own ClimbQueueItem. The
// implementation lives in `@boardsesh/queue-react` (shared with mobile); this
// hook is the web binding — it supplies the connection-manager client, the
// active Session id, and web's rich item->input mapper. See that package for
// the coalescer + cross-session-leak semantics.
export type QueueMutationsActions = SharedQueueMutationsActions<LocalClimbQueueItem>;

export function useQueueMutations({ client, session }: UseQueueMutationsArgs): QueueMutationsActions {
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('session');
  // Refs keep the injected getters reading live values without recreating the
  // shared hook's callbacks on every render.
  const clientRef = useRef(client);
  const sessionRef = useRef(session);
  const lastRateLimitToastAtRef = useRef(0);
  clientRef.current = client;
  sessionRef.current = session;

  // No `ensureReady`: web sessions are already joined (see use-session-lifecycle),
  // so the core actions throw 'Not connected to session' when disconnected —
  // exactly as before.
  return useSharedQueueMutations<LocalClimbQueueItem>({
    getClient: () => clientRef.current,
    getSessionId: () => sessionRef.current?.id ?? null,
    toQueueItemInput: toClimbQueueItemInput,
    onBestEffortError: (action, error) => {
      console.error(`Failed to ${action}:`, error);
    },
    onRateLimited: ({ attempt }) => {
      if (attempt < 2) return;
      const now = Date.now();
      if (now - lastRateLimitToastAtRef.current < RATE_LIMIT_TOAST_DEBOUNCE_MS) return;
      lastRateLimitToastAtRef.current = now;
      showMessage(t('queueProvider.rateLimitCatchUp'), 'warning');
    },
  });
}
