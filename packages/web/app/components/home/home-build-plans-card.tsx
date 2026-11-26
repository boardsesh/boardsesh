import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { buildPlansPathClicked } from '@boardsesh/analytics';
import { PageCard } from '@/app/components/ui/page-shell';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { WebsiteJourneyButton } from '@/app/components/marketing/website-journey-link';
import BuildPlansDrawing from './build-plans-drawing';
import styles from './home-build-plans-card.module.css';

export type HomeBuildPlansCardCopy = {
  title: string;
  lead: string;
  /** Read by screen readers as the list's name; the four items are what the pack contains. */
  includedLabel: string;
  included: ReadonlyArray<{ id: string; label: string; body: string }>;
  cta: string;
  compatibility: string;
  drawingCaption: string;
};

// Hoisted: brandCtaSx returns a plain object.
const CTA_SX = brandCtaSx({ size: 'medium' });

// Fixed ids: the card renders once, on the homepage, from a server component
// (no `useId` there). The caption is the drawing's accessible name.
const TITLE_ID = 'home-build-plans-title';
const CAPTION_ID = 'home-build-plans-drawing-caption';

/**
 * "Building your own board?" — the homepage's way into the free build-plan
 * generator at /build-plans.
 *
 * Plain server markup with the copy handed in: the homepage is prerendered,
 * anonymous HTML, so nothing here reads a flag, a cookie or the visitor. The
 * link goes to the locale's own /build-plans (the middleware rewrites
 * `/es/build-plans` to the same route with Spanish copy from the `cnc`
 * catalogue), so no visitor takes a redirect on the way.
 */
export default function HomeBuildPlansCard({ copy }: { copy: HomeBuildPlansCardCopy }) {
  return (
    <PageCard component="section" padding="lg" radius="xl" className={styles.card} aria-labelledby={TITLE_ID}>
      <Box className={styles.copy}>
        <Typography component="h2" id={TITLE_ID} className={styles.title}>
          {copy.title}
        </Typography>
        <Typography component="p" className={styles.lead}>
          {copy.lead}
        </Typography>
        <Box component="ul" className={styles.included} aria-label={copy.includedLabel}>
          {copy.included.map((item) => (
            <li key={item.id} className={styles.includedItem}>
              <Typography component="span" className={styles.includedLabel}>
                {item.label}
              </Typography>
              <Typography component="span" className={styles.includedBody}>
                {item.body}
              </Typography>
            </li>
          ))}
        </Box>
        <Box className={styles.actions}>
          <WebsiteJourneyButton
            href="/build-plans"
            event={buildPlansPathClicked('home')}
            variant="contained"
            disableElevation
            sx={CTA_SX}
          >
            {copy.cta}
          </WebsiteJourneyButton>
          <Typography component="p" className={styles.compatibility}>
            {copy.compatibility}
          </Typography>
        </Box>
      </Box>
      <Box component="figure" className={styles.figure}>
        <Box className={styles.sheet}>
          <BuildPlansDrawing labelledBy={CAPTION_ID} />
        </Box>
        <Typography component="figcaption" id={CAPTION_ID} className={styles.caption}>
          {copy.drawingCaption}
        </Typography>
      </Box>
    </PageCard>
  );
}
