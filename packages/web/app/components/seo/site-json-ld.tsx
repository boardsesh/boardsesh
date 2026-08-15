import React from 'react';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { SITE_NAME } from '@/app/lib/seo/metadata';

/**
 * The only two external profiles Boardsesh actually publishes — the repo linked
 * from `/about` and `/legal`, and the Discord invite linked from the homepage
 * and `/help`. `sameAs` is a claim of identity, so nothing goes in here that a
 * reader cannot already find on the site.
 */
const SAME_AS = ['https://github.com/marcodejongh/boardsesh', 'https://discord.gg/YXA8GsXfQK'];

/**
 * `Organization` + `WebSite` for the homepage, as one `@graph`.
 *
 * Deliberately **no** `potentialAction` / `SearchAction`. www has no site search
 * after the W-16 teardown, and a search action pointing at an endpoint that does
 * not exist is a fabricated capability — Google follows it, gets a 404, and
 * learns the markup is unreliable. Pinned by a deep-scan test.
 */
export default async function SiteJsonLd() {
  const { t, locale } = await getServerTranslation('marketing');

  const siteUrl = absoluteUrl('/');

  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Organization',
            // Brand name — not translated, per the trademark rules.
            name: SITE_NAME,
            url: siteUrl,
            logo: absoluteUrl('/opengraph-image'),
            sameAs: SAME_AS,
          },
          {
            '@type': 'WebSite',
            name: SITE_NAME,
            url: siteUrl,
            inLanguage: locale,
            // The vetted marketing copy, reused rather than re-written: it is
            // already compatible-not-affiliative about Kilter, Tension and
            // MoonBoard, and it is already translated into all four locales.
            description: t('metadata.home.description'),
          },
        ],
      }}
    />
  );
}
