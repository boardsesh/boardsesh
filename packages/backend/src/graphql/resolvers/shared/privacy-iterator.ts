import { pubsub } from '../../../pubsub';
import { createEagerAsyncIterator } from './async-iterators';

/** A privacy invalidation wakes quiet subscriptions so access is rechecked. */
export function createPrivacyAwareIterator<Event>(
  subscribe: (push: (event: Event) => void) => Promise<() => void>,
  name: string,
) {
  return createEagerAsyncIterator<Event | null>(async (push) => {
    const unsubscribePrivacy = await pubsub.subscribePrivacy(() => push(null));
    try {
      const unsubscribe = await subscribe(push);
      return () => {
        unsubscribe();
        unsubscribePrivacy();
      };
    } catch (error) {
      unsubscribePrivacy();
      throw error;
    }
  }, name);
}
