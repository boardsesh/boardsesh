import { useCallback, useRef, type RefObject } from 'react';
import { Platform } from 'react-native';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type {
  LiveActivityUpdateOptions,
  LiveActivityClimbUpdateOptions,
} from '../../../modules/live-activity/src/index';
import { captureToSentry } from '../sentry';
import { updateLiveActivity, updateLiveActivityClimb } from './live-activity-plugin';

type SessionUpdate =
  | { method: 'full'; options: LiveActivityUpdateOptions }
  | { method: 'climb'; options: LiveActivityClimbUpdateOptions };

type SessionRefs = {
  isActiveRef: RefObject<boolean>;
  generationRef: RefObject<number>;
  sessionIdRef: RefObject<string | null>;
  currentClimbRef: RefObject<ClimbQueueItem | null>;
  queueRef: RefObject<ClimbQueueItem[]>;
};

// Fixed keys and types only: never attach queue contents, names, IDs, or paths.
const OPTION_FIELDS = [
  'sessionId',
  'queueItemUuid',
  'supportsMirroring',
  'mirrored',
  'climbName',
  'climbDifficulty',
  'angle',
  'currentIndex',
  'totalClimbs',
  'hasNext',
  'hasPrevious',
  'boardConnection',
  'holderDisplayName',
  'androidThumbnailOverlayPath',
  'androidThumbnailBackgroundPaths',
] as const;

function optionShape(options: SessionUpdate['options']): Record<string, string> {
  return Object.fromEntries(
    OPTION_FIELDS.map((field) => {
      if (!Object.hasOwn(options, field)) return [field, 'missing'];
      const fieldContent = options[field];
      return [field, fieldContent === null ? 'null' : Array.isArray(fieldContent) ? 'array' : typeof fieldContent];
    }),
  );
}

// One retry per update. A newer update cancels it; a native failure never tears
// down a working session or prevents the next queue/climb change from updating.
export function useSessionPresenceUpdates(refs: SessionRefs) {
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const refsRef = useRef(refs);
  refsRef.current = refs;

  const cancelUpdateRetry = useCallback(() => {
    requestRef.current += 1;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const sendUpdate = useCallback(
    (update: SessionUpdate) => {
      cancelUpdateRetry();
      const request = requestRef.current;
      const { generationRef, sessionIdRef } = refsRef.current;
      const generation = generationRef.current;
      const sessionId = sessionIdRef.current;
      const stillCurrent = () => {
        const currentRefs = refsRef.current;
        const displayItem = currentRefs.currentClimbRef.current ?? currentRefs.queueRef.current[0];
        return (
          currentRefs.isActiveRef.current &&
          currentRefs.generationRef.current === generation &&
          currentRefs.sessionIdRef.current === sessionId &&
          requestRef.current === request &&
          displayItem?.uuid === update.options.queueItemUuid &&
          currentRefs.queueRef.current.some((item) => item.uuid === update.options.queueItemUuid)
        );
      };
      const attemptUpdate = async (retry: boolean): Promise<void> => {
        try {
          if (update.method === 'full') await updateLiveActivity(update.options);
          else await updateLiveActivityClimb(update.options);
        } catch {
          // The native cause is still unknown. Report a fixed message rather than
          // an arbitrary rejection string, which could contain payload values.
          captureToSentry(new Error('Session presence update rejected'), {
            tags: { source: 'session-presence-update', platform: Platform.OS, method: update.method },
            extra: { optionShape: optionShape(update.options), retry },
          });
          if (!retry && stillCurrent()) {
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              if (stillCurrent()) void attemptUpdate(true);
            }, 1000);
          }
        }
      };
      void attemptUpdate(false);
    },
    [cancelUpdateRetry],
  );

  return { sendUpdate, cancelUpdateRetry };
}
