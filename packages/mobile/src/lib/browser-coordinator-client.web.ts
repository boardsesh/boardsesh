import { createCanonicalBrowserCoordinatorFrame } from '@boardsesh/auth-protocol/browser-coordinator-dom';
import { requireCoordinatorOrigin } from '@boardsesh/auth-protocol/browser-coordinator';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { WEB_BASE_URL } from './env';
import { publicExpoBrowserConsumersReady } from './browser-consumer-readiness.web';

let current: {
  readonly origin: string;
  readonly frame: ReturnType<typeof createCanonicalBrowserCoordinatorFrame>;
} | null = null;
/** Control metadata never establishes the Expo account. Its separate actual
 * central session response and backend lease must still pass owner fences. */
export async function coordinateExpoBrowserSession(signal: AbortSignal): Promise<void> {
  try {
    if (!publicExpoBrowserConsumersReady() || signal.aborted || typeof window === 'undefined')
      throw new BrowserBackendConsumerError('unavailable');
    const origin = requireCoordinatorOrigin(WEB_BASE_URL);
    if (current && current.origin !== origin) throw new BrowserBackendConsumerError('unavailable');
    if (!current || current.frame.isClosed())
      current = { origin, frame: createCanonicalBrowserCoordinatorFrame({ window, canonicalOrigin: origin }) };
    const result = await current.frame.renew(signal);
    if (!publicExpoBrowserConsumersReady() || signal.aborted || result.status !== 'ready')
      throw new BrowserBackendConsumerError('unavailable');
  } catch {
    throw new BrowserBackendConsumerError('unavailable');
  }
}
