import React from 'react';
import { absoluteLocaleUrl } from '@/app/lib/seo/base-url';
import type { Locale } from '@/app/lib/i18n/config';
import { JsonLd } from '@/app/lib/seo/json-ld';

type ProfileJsonLdProps = {
  /** The route's `user_id`, unencoded. */
  userId: string;
  /** Profile display name, then the account name. Null when neither exists. */
  displayName: string | null;
  /** The locale this page is rendering on — the canonical is locale-prefixed. */
  locale: Locale;
};

/**
 * `ProfilePage` for a public profile.
 *
 * Rendered only on the success path. The `notFound()` and the metadata catch
 * branch both emit `noindex, follow` (see `generateMetadata`), and structured
 * data on a page we are asking Google not to index is at best noise.
 *
 * Nothing here that the page does not already show: no email, no follower
 * counts we would have to keep in step, no `interactionStatistic`. `mainEntity`
 * is the person, `url` is the profile's own canonical path.
 */
export default function ProfileJsonLd({ userId, displayName, locale }: ProfileJsonLdProps) {
  if (!displayName) return null;

  // Locale-prefixed, the same call `createPageMetadata` makes: on `/es/profile/…`
  // the page canonicalises to the `/es` URL, and naming the en-US one here would
  // have the structured data contradict the canonical beside it.
  const url = absoluteLocaleUrl(`/profile/${encodeURIComponent(userId)}`, locale);

  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        url,
        mainEntity: {
          '@type': 'Person',
          name: displayName,
          url,
        },
      }}
    />
  );
}
