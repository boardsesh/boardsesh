import React, { Suspense } from 'react';
import Box from '@mui/material/Box';
import {
  APP_GUIDE_COMPARISON,
  APP_GUIDE_HUB,
  APP_GUIDES,
  isClaimVisible,
  type AppGuidePage as AppGuidePageData,
  type ComparisonGuide,
  type HubGuide,
} from '@/app/lib/seo/app-guides';
import JsonLd from '@/app/lib/seo/json-ld';
import type { AppGuideCopy } from './app-guide-copy';
import { boardDrawing } from './app-guide-assets';
import { buildAppGuideJsonLd } from './app-guide-json-ld';
import ComparisonTable from './comparison-table';
import { GuideBreadcrumb, type T } from './guide-parts';
import {
  BrandCards,
  Byline,
  CompareAnotherBoard,
  ComparisonHero,
  CtaBand,
  Faq,
  LogbookTray,
  Method,
  OnlyTray,
  OtherApps,
  RelatedHelp,
  SessionSteps,
  SourcesDisclosure,
  VerdictCards,
  pageArt,
  type SourceGroup,
} from './guide-sections';
import { BoardTileGrid, EveryBoardTray, HubHero, PlatformTrio, StatsBand } from './hub-sections';
import QuoteStrip from './quote-strip';
import SourcesAutoOpen from './sources-auto-open';
import styles from './app-guide.module.css';

type PageProps = AppGuideCopy & { guide: AppGuidePageData };

function crumbsFor(guide: AppGuidePageData, t: T) {
  const hub = { label: t('appGuides:common.hubCrumb'), path: APP_GUIDE_HUB.path };
  const home = { label: t('appGuides:common.home'), path: '/' };
  return guide.kind === 'hub'
    ? [home, hub]
    : [home, hub, { label: t(`appGuides:common.crumbs.${guide.id}`), path: guide.path }];
}

function faqItems(guide: AppGuidePageData, t: T) {
  return guide.faq
    .filter((item) => isClaimVisible(guide, `faq.items.${item.id}`))
    .map((item) => ({
      id: item.id,
      q: t(`appGuides:pages.${guide.id}.faq.items.${item.id}.q`),
      a: t(`appGuides:pages.${guide.id}.faq.items.${item.id}.a`),
      sourceIds: item.sourceIds,
    }));
}

function heroGroup(guide: AppGuidePageData, t: T): SourceGroup[] {
  return guide.heroSourceIds.length > 0
    ? [{ id: 'sources-hero', title: t('appGuides:common.sources.hero'), sourceIds: guide.heroSourceIds }]
    : [];
}

function faqGroups(items: ReturnType<typeof faqItems>): SourceGroup[] {
  return items
    .filter((item) => item.sourceIds.length > 0)
    .map((item) => ({ id: `sources-faq-${item.id}`, title: item.q, sourceIds: item.sourceIds }));
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <Box component="main" className={styles.page}>
      <Box className={styles.inner}>{children}</Box>
    </Box>
  );
}

function ComparisonGuidePage({ guide, t, storeLabels }: AppGuideCopy & { guide: ComparisonGuide }) {
  const crumbs = crumbsFor(guide, t);
  const faq = faqItems(guide, t);
  const id = guide.id;
  const groups: SourceGroup[] = [
    ...heroGroup(guide, t),
    ...guide.rows
      .filter((row) => row.sourceIds.length > 0)
      .map((row) => ({
        id: `sources-${row.id}`,
        title: t(`appGuides:pages.${id}.comparison.rows.${row.id}.feature`),
        sourceIds: row.sourceIds,
      })),
    ...guide.tiles
      .filter((tile) => tile.sourceIds.length > 0 && isClaimVisible(guide, `only.tiles.${tile.id}`))
      .map((tile) => ({
        id: `sources-tile-${tile.id}`,
        title: t(`appGuides:pages.${id}.only.tiles.${tile.id}.title`),
        sourceIds: tile.sourceIds,
      })),
    ...guide.brands
      .filter((brand) => brand.sourceIds.length > 0)
      .map((brand) => ({
        id: `sources-brand-${brand.id}`,
        title: t(`appGuides:pages.${id}.brands.items.${brand.id}.name`),
        sourceIds: brand.sourceIds,
      })),
    ...guide.otherApps
      .filter((app) => app.sourceIds.length > 0)
      .map((app) => ({
        id: `sources-app-${app.id}`,
        title: t(`appGuides:pages.${id}.otherApps.items.${app.id}.name`),
        sourceIds: app.sourceIds,
      })),
    ...faqGroups(faq),
  ];
  const h1 = t(`appGuides:pages.${id}.hero.h1`);
  return (
    <Frame>
      <JsonLd
        data={buildAppGuideJsonLd({
          guide,
          name: h1,
          description: t(`appGuides:pages.${id}.meta.description`),
          crumbs,
        })}
      />
      <SourcesAutoOpen />
      <GuideBreadcrumb t={t} crumbs={crumbs} />
      <ComparisonHero guide={guide} t={t} storeLabels={storeLabels} byline={<Byline guide={guide} t={t} />} />
      <VerdictCards guide={guide} t={t} />
      <OnlyTray guide={guide} t={t} />
      <ComparisonTable guide={guide} t={t} />
      <QuoteStrip pageId={guide.id} t={t} />
      <BrandCards guide={guide} t={t} />
      <OtherApps guide={guide} t={t} />
      <SessionSteps guide={guide} t={t} />
      <LogbookTray guide={guide} t={t} />
      <Faq guide={guide} t={t} items={faq} />
      <CtaBand guide={guide} t={t} storeLabels={storeLabels} placement={guide.placement} art={pageArt(guide, t)} />
      <CompareAnotherBoard guide={guide} t={t} />
      <RelatedHelp t={t} links={guide.related} />
      <Method guide={guide} t={t} />
      <SourcesDisclosure guide={guide} t={t} groups={groups} />
    </Frame>
  );
}

function HubGuidePage({ guide, t, storeLabels }: AppGuideCopy & { guide: HubGuide }) {
  const crumbs = crumbsFor(guide, t);
  const faq = faqItems(guide, t);
  const groups: SourceGroup[] = [
    ...heroGroup(guide, t),
    ...guide.everyBoard
      .filter((tile) => tile.sourceIds.length > 0)
      .map((tile) => ({
        id: `sources-tile-${tile.id}`,
        title: t(`appGuides:pages.hub.everyBoard.tiles.${tile.id}.title`),
        sourceIds: tile.sourceIds,
      })),
    ...faqGroups(faq),
  ];
  const guides = [...APP_GUIDES, APP_GUIDE_COMPARISON].map((entry) => ({
    name: t(`appGuides:pages.${entry.id}.hero.h1`),
    path: entry.path,
  }));
  return (
    <Frame>
      <JsonLd
        data={buildAppGuideJsonLd({
          guide,
          name: t('appGuides:pages.hub.hero.h1'),
          description: t('appGuides:pages.hub.meta.description'),
          crumbs,
          items: guides,
        })}
      />
      <SourcesAutoOpen />
      <GuideBreadcrumb t={t} crumbs={crumbs} />
      <HubHero guide={guide} t={t} storeLabels={storeLabels} byline={<Byline guide={guide} t={t} />} />
      <BoardTileGrid guide={guide} t={t} />
      <QuoteStrip pageId={guide.id} t={t} />
      <EveryBoardTray guide={guide} t={t} />
      <PlatformTrio t={t} />
      <Suspense fallback={null}>
        <StatsBand t={t} />
      </Suspense>
      <Faq guide={guide} t={t} items={faq} />
      <CtaBand
        guide={guide}
        t={t}
        storeLabels={storeLabels}
        placement={guide.placement}
        art={boardDrawing('moonboard')}
      />
      <RelatedHelp t={t} links={guide.related} />
      <Method guide={guide} t={t} />
      <SourcesDisclosure guide={guide} t={t} groups={groups} />
    </Frame>
  );
}

export default function AppGuidePage({ guide, ...copy }: PageProps) {
  return guide.kind === 'hub' ? (
    <HubGuidePage guide={guide} {...copy} />
  ) : (
    <ComparisonGuidePage guide={guide} {...copy} />
  );
}
