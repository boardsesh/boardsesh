import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import { BOARDSESH_APP_STORE_RATING, BOARDSESH_PLAY_RATING, quotesFor } from '@/app/lib/seo/app-guides';
import type { AppGuidePageId } from '@/app/lib/seo/app-guide-model';
import { SectionHead, type T } from './guide-parts';
import styles from './app-guide.module.css';

const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * "What climbers say": verbatim public store reviews picked for this page.
 *
 * The quotes are user-generated: shown in full, never translated (`lang="en"`),
 * with no stars and no Review or AggregateRating markup. Each one links to its
 * store's listing, not to the review. Only the heading and labels are catalog text.
 */
export default function QuoteStrip({ pageId, t }: { pageId: AppGuidePageId; t: T }) {
  const quotes = quotesFor(pageId);
  if (quotes.length === 0) return null;
  const listing = { appStore: BOARDSESH_APP_STORE_RATING.source, googlePlay: BOARDSESH_PLAY_RATING.source };
  return (
    <Box
      component="section"
      id="quotes"
      className={`${styles.section} ${styles.quotesSection}`}
      aria-labelledby="quotes-title"
    >
      <SectionHead
        id="quotes-title"
        eyebrow={t('appGuides:common.quotes.eyebrow')}
        ring="start"
        title={t('appGuides:common.quotes.heading')}
      />
      {/* A swipeable row on phones: focusable so the keyboard can scroll it too. */}
      <Box component="ul" className={styles.quotes} tabIndex={0} aria-label={t('appGuides:common.quotes.listLabel')}>
        {quotes.map((quote) => (
          <li key={quote.id}>
            <figure className={styles.quote}>
              <blockquote lang="en">
                <p>“{quote.text}”</p>
              </blockquote>
              <figcaption>
                <span className={styles.quoteAuthor} lang="en">
                  {quote.author}
                </span>
                <span className={styles.quoteMeta}>
                  <MuiLink href={listing[quote.store]}>
                    {quote.store === 'appStore'
                      ? t('appGuides:common.quotes.appStore')
                      : t('appGuides:common.quotes.googlePlay')}
                  </MuiLink>
                  {quote.country ? (
                    <>
                      {' · '}
                      <span lang="en">{quote.country}</span>
                    </>
                  ) : null}
                  {' · '}
                  <time dateTime={quote.date}>{monthFormat.format(new Date(quote.date))}</time>
                </span>
              </figcaption>
            </figure>
          </li>
        ))}
      </Box>
    </Box>
  );
}
