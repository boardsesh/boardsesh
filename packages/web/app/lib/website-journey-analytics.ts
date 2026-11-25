import type { MouseEvent } from 'react';
import type { WebsiteJourneyEvent } from '@boardsesh/analytics';
import { track, trackBeforeNavigation } from './analytics';
import {
  needsMarketingDocumentNavigation,
  withMarketingNavigationCampaign,
} from './i18n/marketing-document-navigation';

type LinkClickProperties = Parameters<typeof track>[1];

/** Uses the existing consent, production-host and excluded-route checks. */
export function trackWebsiteJourneyEvent(event: WebsiteJourneyEvent): void {
  track(event.name, event.properties);
}

/**
 * Track a click on a real anchor without losing the event to the navigation.
 *
 * Keeps native modified-click behavior. A plain click that replaces this
 * document with another origin holds the navigation for the bounded flush,
 * then goes, whether or not the flush worked.
 */
export function trackLinkClick(
  click: MouseEvent<HTMLAnchorElement>,
  name: string,
  properties?: LinkClickProperties,
): void {
  if (click.defaultPrevented) return;
  const anchor = click.currentTarget;
  const isNewContext = anchor.target !== '' && anchor.target !== '_self';
  const isModified = click.metaKey || click.ctrlKey || click.shiftKey || click.altKey || click.button !== 0;
  const isWebNavigation = anchor.protocol === 'http:' || anchor.protocol === 'https:';
  const crossesMarketingDocument =
    anchor.origin === window.location.origin &&
    needsMarketingDocumentNavigation(window.location.pathname, anchor.pathname);
  // Email, phone and custom schemes need the original trusted browser gesture.
  if (
    !isWebNavigation ||
    isNewContext ||
    isModified ||
    (anchor.origin === window.location.origin && !crossesMarketingDocument) ||
    anchor.hasAttribute('download')
  ) {
    track(name, properties);
    return;
  }
  click.preventDefault();
  const destination = crossesMarketingDocument
    ? withMarketingNavigationCampaign(new URL(anchor.href)).href
    : anchor.href;
  const navigate = () => window.location.assign(destination);
  // The shared helper gives capture at most 250 ms. Failure must still navigate.
  void trackBeforeNavigation(name, properties).then(navigate, navigate);
}

/** Keep real anchors and native modified-click behavior; flush departing tabs. */
export function trackWebsiteJourneyLinkClick(click: MouseEvent<HTMLAnchorElement>, event: WebsiteJourneyEvent): void {
  trackLinkClick(click, event.name, event.properties);
}
