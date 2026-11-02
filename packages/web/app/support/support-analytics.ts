import { supportCtaClicked, type SupportCtaClickedInput } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';

/**
 * One `Support CTA Clicked` per button that leaves for Stripe or GitHub.
 * `track()` is consent-gated and production-host-gated, so this is a no-op for
 * a visitor who declined analytics. Every button opens a new tab, so the
 * document stays alive long enough for the event to send.
 */
export function trackSupportCta(input: SupportCtaClickedInput): void {
  const { name, properties } = supportCtaClicked(input);
  track(name, properties);
}
