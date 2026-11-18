import type { MouseEvent } from 'react';
import type { WebsiteJourneyEvent } from '@boardsesh/analytics';
import { track, trackBeforeNavigation } from './analytics';

/** Uses the existing consent, production-host and excluded-route checks. */
export function trackWebsiteJourneyEvent(event: WebsiteJourneyEvent): void {
  track(event.name, event.properties);
}

/** Keep real anchors and native modified-click behavior; flush departing tabs. */
export function trackWebsiteJourneyLinkClick(click: MouseEvent<HTMLAnchorElement>, event: WebsiteJourneyEvent): void {
  if (click.defaultPrevented) return;
  const anchor = click.currentTarget;
  const isNewContext = anchor.target !== '' && anchor.target !== '_self';
  const isModified = click.metaKey || click.ctrlKey || click.shiftKey || click.altKey || click.button !== 0;
  const isWebNavigation = anchor.protocol === 'http:' || anchor.protocol === 'https:';
  // Email, phone and custom schemes need the original trusted browser gesture.
  if (
    !isWebNavigation ||
    isNewContext ||
    isModified ||
    anchor.origin === window.location.origin ||
    anchor.hasAttribute('download')
  ) {
    trackWebsiteJourneyEvent(event);
    return;
  }
  click.preventDefault();
  const destination = anchor.href;
  const navigate = () => window.location.assign(destination);
  // The shared helper gives capture at most 250 ms. Failure must still navigate.
  void trackBeforeNavigation(event.name, event.properties).then(navigate, navigate);
}
