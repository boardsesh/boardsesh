import { useLayoutEffect, type RefObject } from 'react';
import { usePathname } from 'expo-router';
import { useActiveBoard } from '../graphql/use-active-board';
import { useQueueActions, useQueueSessionId } from '../../providers/queue-provider';
import type { BuildMobileFeedbackEnrichmentArgs } from './feedback-enrichment';

export type FeedbackMetadataReader = () => BuildMobileFeedbackEnrichmentArgs;

/** Only mounted while reporting. Route changes update this bridge, not the form. */
export function FeedbackMetadataCollector({ readerRef }: { readerRef: RefObject<FeedbackMetadataReader | null> }) {
  const { data: activeBoard } = useActiveBoard();
  const { getQueueSnapshot } = useQueueActions();
  const { sessionId } = useQueueSessionId();
  const pathname = usePathname();

  useLayoutEffect(() => {
    readerRef.current = () => ({
      activeBoard,
      currentClimbQueueItem: getQueueSnapshot().currentClimbQueueItem,
      sessionId,
      pathname,
    });
  }, [activeBoard, getQueueSnapshot, pathname, readerRef, sessionId]);

  return null;
}
