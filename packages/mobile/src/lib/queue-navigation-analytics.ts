import {
  queueNavigation,
  queueSheetOpened,
  type QueueNavigationInput,
  type QueueSheetOpenedInput,
} from '@boardsesh/analytics';
import { track } from './analytics';

/**
 * One deliberate Next or Previous (#6940). Fire it from the gesture or the tap,
 * never from `nextClimb` itself: the rest timer and the workout runner call that
 * too, and they are not the climber navigating. Contract:
 * packages/shared/analytics/src/queue-navigation-events.ts.
 */
export function trackQueueNavigation(input: QueueNavigationInput): void {
  const { name, properties } = queueNavigation(input);
  track(name, properties);
}

/** The climber asked for the queue sheet (#6940). */
export function trackQueueSheetOpened(input: QueueSheetOpenedInput): void {
  const { name, properties } = queueSheetOpened(input);
  track(name, properties);
}
