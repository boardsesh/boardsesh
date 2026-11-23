'use client';

import React, { useCallback } from 'react';
import Button from '@mui/material/Button';
import type { SxProps, Theme } from '@mui/material/styles';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track, trackBeforeNavigation } from '@/app/lib/analytics';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';

export type HandoffSurface = 'climb_front_door' | 'list_front_door';
/** Which www route tree the reader came from — the config-tuple tree or `/b/{slug}`. */
export type HandoffTree = 'config-tuple' | 'slug';

/** What `Climb Handoff Clicked` says about the click, and where the link points. */
export type ClimbHandoffTarget = {
  /**
   * The www pathname to hand off, locale prefix included or not — the
   * builder strips it. NOT a full URL and never carries a query string: the
   * CTA contract is "the same pathname on the app origin".
   */
  pathname: string;
  surface: HandoffSurface;
  tree: HandoffTree;
  boardName: string;
  layoutId: number;
  angle: number;
  climbUuid?: string;
  locale: string;
};

type ClimbHandoffLinkProps = ClimbHandoffTarget & {
  /**
   * Leave it out when the visible text names the link well enough: an
   * `aria-label` replaces that text, and must start with it (WCAG 2.5.3).
   */
  ariaLabel?: string;
  /** What the link shows. A server page can pass its own markup: the label spans, an icon. */
  children: React.ReactNode;
  /** The link's look, which is the caller's: a text link on a phone, the filled button on a laptop. */
  sx?: SxProps<Theme>;
  /** Names the link for a page's own tests and styles (`data-cta`). */
  ctaName?: string;
};

/**
 * The hand-off itself: an anchor that opens this exact route in the browser
 * app, and the click handler that measures it.
 *
 * It is a real `<a href>` rendered on the server, so it is crawlable and it
 * works with JavaScript off; the click handler only adds telemetry. The href
 * carries no UTM parameters — `buildAppHandoffUrl`'s contract is the same
 * pathname on the app origin, and a query string would break the app's route
 * match — so campaign attribution rides as event properties instead.
 *
 * How it looks is the caller's: `FrontDoorHeroCta` turns it into a text link on
 * a phone and the filled button on a laptop, on the climb page and the board list.
 */
export function ClimbHandoffLink({
  pathname,
  ariaLabel,
  surface,
  tree,
  boardName,
  layoutId,
  angle,
  climbUuid,
  locale,
  children,
  sx,
  ctaName,
}: ClimbHandoffLinkProps) {
  const href = buildAppHandoffUrl(pathname);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const properties = {
        // A per-event property, deliberately, not a session super property.
        // PostHog resolves per-event properties over super properties, so this
        // survives www later registering an `environment` super property while
        // leaving $pageview / $web_vitals and the ~120 other www events — none of
        // which has ever carried the tag — reading exactly as they do today.
        environment: 'production-web',
        surface,
        tree,
        boardName,
        layoutId,
        angle,
        climbUuid,
        locale,
        campaign: 'front_door',
      };

      // A modified click opens a new tab or window, so THIS document lives on
      // and the event rides the normal batch. Leave the browser to it.
      const keepsThisDocument =
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey;
      if (keepsThisDocument) {
        track(SHARED_EVENTS.ClimbHandoffClicked, properties);
        return;
      }

      // A plain click replaces this document with app.boardsesh.com immediately,
      // and posthog-js-lite would still be holding the event in its batch queue
      // (see `trackBeforeNavigation` for why it has no unload transport). This
      // event IS the hand-off funnel's measurement, so losing it would read as a
      // broken hand-off rather than a broken meter. Hold the navigation for the
      // bounded flush, then go — the anchor keeps its real `href`, so crawlers
      // and JS-off readers never reach this code.
      event.preventDefault();
      void trackBeforeNavigation(SHARED_EVENTS.ClimbHandoffClicked, properties)
        // Telemetry never gets to strand a climber on the page they left.
        .catch(() => {})
        .finally(() => {
          window.location.assign(href);
        });
    },
    [surface, tree, boardName, layoutId, angle, climbUuid, locale, href],
  );

  return (
    <Button
      component="a"
      href={href}
      variant="text"
      size="large"
      aria-label={ariaLabel}
      onClick={handleClick}
      sx={sx}
      data-cta={ctaName}
    >
      {children}
    </Button>
  );
}
