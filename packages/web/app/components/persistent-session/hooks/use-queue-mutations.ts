import { useRef } from 'react';
import {
  useQueueMutations as useSharedQueueMutations,
  type QueueMutationsActions as SharedQueueMutationsActions,
} from '@boardsesh/queue-react';
import type { ClimbQueueItemInput } from '@boardsesh/shared-schema';
import type { Client } from '../../graphql-queue/graphql-client';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { type Session, toClimbQueueItemInput } from '../types';

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
  // Refs keep the injected getters reading live values without recreating the
  // shared hook's callbacks on every render.
  const clientRef = useRef(client);
  const sessionRef = useRef(session);
  clientRef.current = client;
  sessionRef.current = session;

  // No `ensureReady`: web sessions are already joined (see use-session-lifecycle),
  // so the core actions throw 'Not connected to session' when disconnected —
  // exactly as before.
  return useSharedQueueMutations<LocalClimbQueueItem>({
    getClient: () => clientRef.current,
    getSessionId: () => sessionRef.current?.id ?? null,
    toQueueItemInput: (item) => toClimbQueueItemInput(item) as ClimbQueueItemInput,
    onBestEffortError: (action, error) => {
      console.error(`Failed to ${action}:`, error);
    },
  });
}
