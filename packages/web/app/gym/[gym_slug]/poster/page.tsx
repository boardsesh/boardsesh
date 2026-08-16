// Print-ready QR poster for one gym (#4379).
//
// The physical asset every gym-owner persona committed to: a laminated code by
// the board. It is deliberately its own URL rather than a print stylesheet on
// the gym page — an owner prints this, tapes it to the wall, and the page they
// printed from stays a normal web page.
//
// Chrome-less by construction: `/gym/<slug>/poster` is listed in
// `CHROME_LESS_ROUTE_PATTERNS`, because the root layout's fixed header would
// print over the sheet and the footer would push it onto page two. A nested
// layout cannot take that chrome away.

import React from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata, absoluteUrl } from '@/app/lib/seo/metadata';
import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveGymLogoDisplayUrl } from '@/app/lib/gym-logo-display-url';
import { fetchGymBySlug, isGymViewable } from '../fetch-gym-by-slug';
import GymPosterQr from './gym-poster-qr';
import GymPosterPrintBar from './gym-poster-print-bar';
import styles from './gym-poster.module.css';

type GymPosterRouteProps = {
  params: Promise<{ gym_slug: string }>;
};

/**
 * The line a human types when the code won't scan: `www.boardsesh.com/gym/x`,
 * clean — no `?src=qr&medium=poster`. Someone typing a URL off a wall is not a
 * scan, and asking them to key in two query params would guarantee a typo and
 * mislabel them as a scan if they got it right.
 *
 * Built from `absoluteUrl` so the host tracks the canonical site URL, then
 * stripped of its scheme: `https://` is noise on a printed line, and every
 * browser and phone keyboard adds it back.
 */
function typedFallbackUrl(gymSlug: string): string {
  return absoluteUrl(`/gym/${gymSlug}`).replace(/^https?:\/\//, '');
}

export async function generateMetadata(props: GymPosterRouteProps): Promise<Metadata> {
  const { gym_slug } = await props.params;
  const token = await getServerAuthToken();
  const [gym, { t, locale }] = await Promise.all([fetchGymBySlug(gym_slug, token), getServerTranslation('kiosk')]);

  // NO `path`, deliberately — and this is where the poster parts company with
  // the manage route, which does pass one. `path` is what makes
  // `createPageMetadata` emit `alternates.canonical`, an hreflang `languages`
  // map for all four locales, and `og:url`. All three are indexing signals, and
  // this page is `robots: noindex`: hreflang is only honoured between mutually
  // indexable pages, and a canonical sitting beside a noindex directive is the
  // classic conflicting-signal pair. The gym's indexable surface is
  // `/gym/<slug>`, which carries its own canonical. Omitting `path` yields
  // `alternates: undefined` — nothing to contradict.
  const title = isGymViewable(gym) ? t('gymPage.poster.metaTitle', { gymName: gym.name }) : t('metadata.fallbackTitle');
  return createNoIndexMetadata({
    title,
    description: t('gymPage.poster.metaDescription'),
    locale,
  });
}

export default async function GymPosterPage(props: GymPosterRouteProps) {
  const { gym_slug } = await props.params;
  const token = await getServerAuthToken();
  const gym = await fetchGymBySlug(gym_slug, token);

  // Same viewability contract as the public page: public, or the viewer can
  // edit it. An owner lays the poster out and prints it before the listing goes
  // live; everyone else gets the same 404 a missing gym returns, so a private
  // gym's existence doesn't leak through this route.
  if (!isGymViewable(gym)) {
    notFound();
  }

  // The requested slug belonged to a merged twin — send the poster URL to the
  // canonical one, exactly as the public page does. No attribution query to
  // carry here: this is the page an owner prints from, not a page a scan lands
  // on. Percent-encoded for the same reason `gymQrUrl` encodes.
  if (gym.slug && gym.slug !== gym_slug) {
    permanentRedirect(`/gym/${encodeURIComponent(gym.slug)}/poster`);
  }

  const { t } = await getServerTranslation('kiosk');
  const logoSrc = resolveGymLogoDisplayUrl(gym.logoUrl ?? null, getPublicBackendHttpUrl());

  // The canonical slug, not the one in the address bar: a merged twin 308s onto
  // `gym.slug` above, and a slug-less legacy gym has no canonical to fall back
  // to. `||` rather than `??` — the redirect guard above is a truthiness check,
  // so an empty-string slug reaches here having skipped it.
  const posterSlug = gym.slug || gym_slug;

  // Plain elements and a stylesheet rather than MUI Typography: every Typography
  // variant carries a themed colour, and this sheet is black-on-white in both
  // themes because it is read off paper by a phone camera. The screen-only
  // action bar below is normal MUI.
  return (
    <div className={styles.page}>
      <main className={styles.sheet}>
        {logoSrc && <img className={styles.logo} src={logoSrc} alt={gym.name} />}
        <h1 className={styles.gymName}>{gym.name}</h1>
        <p className={styles.heading}>{t('gymPage.poster.heading')}</p>
        <p className={styles.pitch}>{t('gymPage.poster.pitch')}</p>
        <GymPosterQr gymSlug={posterSlug} />
        <div>
          <p className={styles.typedUrlLabel}>{t('gymPage.poster.typedUrlLabel')}</p>
          <p className={styles.typedUrl}>{typedFallbackUrl(posterSlug)}</p>
        </div>
        <div>
          {/* Brand name — never translated, per the i18n rules. */}
          {/* i18n-ignore-next-line */}
          <p className={styles.wordmark}>Boardsesh</p>
          {/* Compatibility, not endorsement — and this one goes on a physical
              wall, so the wording matters more here than anywhere else. Board
              names describe which hardware the app talks to; the second line
              says plainly that nobody endorsed us. No manufacturer logos,
              no manufacturer colours, no borrowed branding. */}
          <p className={styles.footer}>{t('gymPage.poster.compatibility')}</p>
          <p className={styles.footer}>{t('gymPage.poster.independence')}</p>
        </div>
      </main>

      <GymPosterPrintBar
        gymHref={`/gym/${posterSlug}`}
        printLabel={t('gymPage.poster.printAction')}
        backLabel={t('gymPage.poster.backToGym')}
      />
    </div>
  );
}
