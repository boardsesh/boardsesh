import React from 'react';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { JsonLd } from '@/app/lib/seo/json-ld';

type ProfileJsonLdProps = {
  /** The route's `user_id`, unencoded. */
  userId: string;
  /** Profile display name, then the account name. Null when neither exists. */
  displayName: string | null;
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
export default function ProfileJsonLd({ userId, displayName }: ProfileJsonLdProps) {
  if (!displayName) return null;

  const path = `/profile/${encodeURIComponent(userId)}`;

  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        url: absoluteUrl(path),
        mainEntity: {
          '@type': 'Person',
          name: displayName,
          url: absoluteUrl(path),
        },
      }}
    />
  );
}
