'use client';

import React, { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useConsent } from '@/app/components/consent/consent-state-provider';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { useQrLandingMedium } from '@/app/hooks/use-qr-landing-medium';
import type { HeroInstallStore } from '@/app/lib/hero-install';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { smartAppBannerShows } from '@/app/lib/smart-app-banner';
import { buildStoreUrl } from '@/app/lib/store-links';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { trackAppInstallClick } from '@/app/lib/track-app-install-click';
import { themeTokens } from '@/app/theme/theme-config';
import { STICKY_INSTALL_HIDE_ATTRIBUTE } from './sticky-install-markers';

/** The wording, translated by the server page so this island needs no i18n bundle. */
export type StickyInstallBarLabels = {
  free: string;
  cta: string;
  dismiss: string;
  /** Which store the button opens, for a screen reader. */
  ctaAria: Record<HeroInstallStore, string>;
};

type StickyInstallBarProps = {
  labels: StickyInstallBarLabels;
  /** The Boardsesh mark, resolved on the server so this island skips the asset catalog. */
  markUrl: string;
  /** Which kind of code lands on this page, so the link id names it after a scan. */
  qrLanding?: QrLandingKind;
};

// Dismissal lasts for this document, across client-side visits to other climbs,
// and is never written anywhere: a reload brings the bar back.
let dismissedThisVisit = false;

/** Test-only: the dismissal outlives every unmount. */
export function __resetStickyInstallBarForTests(): void {
  dismissedThisVisit = false;
}

/**
 * Which store the bar offers in this browser, or null where it stays away.
 *
 * Android gets it. iOS gets it only where Safari's Smart App Banner does not
 * show (Chrome, Firefox, in-app browsers): the banner is already Safari's own
 * install strip, and two would be one too many. Desktops get nothing.
 *
 * Reads `navigator` itself, never `useInstallPlatform`'s first value: that one
 * starts from the user agent of the request that rendered the page, and a
 * cached climb page was rendered for whoever asked first.
 */
function stickyBarStoreForThisBrowser(): HeroInstallStore | null {
  const { userAgent, maxTouchPoints } = navigator;
  const browser = classifyMarketingBrowser(userAgent, maxTouchPoints);
  if (browser.desktop) return null;
  if (browser.platform === 'android') return 'android';
  return smartAppBannerShows(userAgent, maxTouchPoints) ? null : 'ios';
}

const barSx = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: themeTokens.zIndex.fixed,
  display: { xs: 'flex', md: 'none' },
  alignItems: 'center',
  gap: `${themeTokens.spacing[3]}px`,
  // Set on the climb page's `<main>` (`climb-front-door.module.css`), which
  // reserves the same height below md: border, padding, row and safe-area inset.
  minHeight: 'var(--sticky-install-bar-height)',
  boxSizing: 'border-box',
  paddingTop: `${themeTokens.spacing[3]}px`,
  paddingBottom: `calc(${themeTokens.spacing[3]}px + env(safe-area-inset-bottom))`,
  paddingLeft: `max(${themeTokens.spacing[2]}px, env(safe-area-inset-left))`,
  paddingRight: `max(${themeTokens.spacing[4]}px, env(safe-area-inset-right))`,
  backgroundColor: 'var(--semantic-surface-overlay)',
  backdropFilter: 'blur(14px)',
  borderTop: '1px solid var(--separator)',
  // Transform only: the bar is fixed, so sliding it moves nothing else on the page.
  transform: 'translateY(110%)',
  visibility: 'hidden',
  transition: 'transform var(--motion-normal) var(--ease-standard), visibility 0s linear var(--motion-normal)',
  '&[data-open="true"]': {
    transform: 'none',
    visibility: 'visible',
    transition: 'transform var(--motion-normal) var(--ease-standard), visibility 0s',
  },
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'none',
    '&[data-open="true"]': { transition: 'none' },
  },
} as const;

const markSx = {
  flex: '0 0 auto',
  width: 36,
  height: 36,
  overflow: 'hidden',
  borderRadius: `${themeTokens.borderRadius.md}px`,
  '& > img': { display: 'block' },
};

const nameSx = {
  color: 'var(--neutral-900)',
  fontWeight: themeTokens.typography.fontWeight.bold,
  fontSize: themeTokens.typography.fontSize.base,
  lineHeight: 1.2,
};

const freeSx = { color: 'var(--neutral-500)', fontSize: themeTokens.typography.fontSize.sm };

const ctaSx = { ...brandCtaSx({ size: 'medium' }), marginLeft: 'auto' };

const dismissSx = { color: 'var(--neutral-500)', width: 44, height: 44, flex: '0 0 auto' };

const endMarkerSx = { height: 0 };

/**
 * The install strip at the bottom of a phone's screen once the page's own store
 * button has scrolled away (`sticky-bar` placement).
 *
 * Rendered after mount only, and only below md: the page's shared HTML carries
 * just the zero-height end marker, so a crawler, a desktop and Safari on an
 * iPhone (which shows its own Smart App Banner) never get a second store link.
 *
 * It stays down while:
 *
 *  - the consent card is up, or may still come up because the region lookup
 *    is out (`promptShowing`), or the privacy dialog is open: the card sits at
 *    the bottom of the screen, and the reader's answer comes first. A browser
 *    that never gets the card (outside the prompt regions, Global Privacy
 *    Control included) gets the bar once the lookup has answered;
 *  - any of the page's store badges (`data-sticky-install-hide`) is on screen,
 *    or none has been scrolled past yet. A block that streams in after mount
 *    (the climb page's app module, inside `<Suspense>`) counts too;
 *  - the end of `<main>` has reached the bar. Below md `<main>` carries a bottom
 *    padding the bar's height, so the last line of content is above the bar
 *    when it leaves, and the footer is never covered.
 *
 * A dismissal is kept in memory for this visit only.
 */
export default function StickyInstallBar({ labels, markUrl, qrLanding }: StickyInstallBarProps) {
  const { platform } = useInstallPlatform();
  const { promptShowing, dialogOpen } = useConsent();
  const inboundCampaign = useInboundCampaign();
  const qrMedium = useQrLandingMedium(qrLanding ?? null);
  const endMarkerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [store, setStore] = useState<HeroInstallStore | null>(null);
  const [scrolledPastButtons, setScrolledPastButtons] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedThisVisit);

  // After mount only, from the browser itself. `platform` is read for one thing:
  // the retired native app, which only `useInstallPlatform` can recognise.
  useEffect(() => {
    setStore(platform === 'native' ? null : stickyBarStoreForThisBrowser());
  }, [platform]);

  useEffect(() => {
    if (!store || dismissed || typeof IntersectionObserver === 'undefined') return;

    const buttonPositions = new Map<Element, { visible: boolean; above: boolean }>();
    const settle = () => {
      const positions = [...buttonPositions.values()];
      setScrolledPastButtons(positions.some(({ above }) => above) && !positions.some(({ visible }) => visible));
    };
    const buttonObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        buttonPositions.set(entry.target, {
          visible: entry.isIntersecting,
          // A `display: none` button has an empty box at 0,0: it is not "above".
          above: !entry.isIntersecting && entry.boundingClientRect.height > 0 && entry.boundingClientRect.bottom <= 0,
        });
      }
      settle();
    });
    const hideSelector = `[${STICKY_INSTALL_HIDE_ATTRIBUTE}]`;
    const markersIn = (node: Node): Element[] => {
      if (!(node instanceof Element)) return [];
      return [...(node.matches(hideSelector) ? [node] : []), ...node.querySelectorAll(hideSelector)];
    };
    for (const button of document.querySelectorAll(hideSelector)) {
      buttonObserver.observe(button);
    }

    // A page can stream a store block in after this effect has run: the climb
    // page's app module renders inside <Suspense>. Watch <main> for markers that
    // arrive (observing one twice is harmless) and forget the ones that leave.
    const markerWatcher = new MutationObserver((mutations) => {
      let forgot = false;
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          for (const marker of markersIn(added)) buttonObserver.observe(marker);
        }
        for (const removed of mutation.removedNodes) {
          for (const marker of markersIn(removed)) {
            buttonObserver.unobserve(marker);
            forgot = buttonPositions.delete(marker) || forgot;
          }
        }
      }
      if (forgot) settle();
    });
    const watchedRoot = endMarkerRef.current?.closest('main') ?? document.body;
    markerWatcher.observe(watchedRoot, { childList: true, subtree: true });

    // The end counts as reached once it is above the bar's top edge.
    const barHeight = barRef.current?.offsetHeight ?? 0;
    const endObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry) setReachedEnd(entry.isIntersecting || entry.boundingClientRect.top <= 0);
      },
      { rootMargin: `0px 0px -${barHeight}px 0px` },
    );
    if (endMarkerRef.current) endObserver.observe(endMarkerRef.current);

    return () => {
      buttonObserver.disconnect();
      endObserver.disconnect();
      markerWatcher.disconnect();
    };
  }, [store, dismissed]);

  const consentInTheWay = promptShowing || dialogOpen;
  const open = Boolean(store) && !dismissed && !consentInTheWay && scrolledPastButtons && !reachedEnd;

  return (
    <>
      <Box ref={endMarkerRef} aria-hidden sx={endMarkerSx} data-sticky-install-end="" />
      {store && !dismissed ? (
        <Box ref={barRef} sx={barSx} data-open={open} data-testid="sticky-install-bar">
          <IconButton
            aria-label={labels.dismiss}
            sx={dismissSx}
            onClick={() => {
              dismissedThisVisit = true;
              setDismissed(true);
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
          <Box sx={markSx}>
            <Image src={markUrl} alt="" width={36} height={36} loading="lazy" />
          </Box>
          <Box>
            <Box sx={nameSx}>
              {/* i18n-ignore-next-line — brand name, never translated */}
              Boardsesh
            </Box>
            <Box sx={freeSx}>{labels.free}</Box>
          </Box>
          <Button
            href={buildStoreUrl(store, { placement: 'sticky-bar', inbound: inboundCampaign, qrMedium })}
            target="_blank"
            rel="noopener noreferrer"
            variant="contained"
            aria-label={labels.ctaAria[store]}
            sx={ctaSx}
            onClick={() => {
              trackAppInstallClick({
                platform: store,
                source: store === 'ios' ? 'app-store' : 'google-play',
                placement: 'sticky-bar',
                mode: 'install',
                ...(qrMedium ? { qrMedium } : {}),
              });
            }}
          >
            {labels.cta}
          </Button>
        </Box>
      ) : null}
    </>
  );
}
