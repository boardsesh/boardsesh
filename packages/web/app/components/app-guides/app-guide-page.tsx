import React, { Suspense } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { getBoardGalleryLayouts } from '@/app/boards/board-gallery';
import CommunityProofLine from '@/app/components/climb-front-door/community-proof-line';
import LocaleLink from '@/app/components/i18n/locale-link';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { PageCard, PageSection, PageShell, Prose, ProseList } from '@/app/components/ui/page-shell';
import { quietLinkSx } from '@/app/components/ui/quiet-link';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { marketingScreenshot } from '@/app/lib/marketing-screenshots';
import {
  APP_GUIDE_COMPARISON,
  APP_GUIDE_HUB,
  APP_GUIDES,
  BOARDSESH_APP_STORE_RATING,
  type AppGuidePage as AppGuidePageData,
} from '@/app/lib/seo/app-guides';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import JsonLd from '@/app/lib/seo/json-ld';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import AppGuideComparison from './app-guide-comparison';
import type { AppGuideCopy } from './app-guide-copy';
import styles from './app-guide.module.css';

type AppGuidePageProps = AppGuideCopy & { guide: AppGuidePageData };
type GuideSectionProps = { guide: AppGuidePageData; t: AppGuideCopy['t'] };

const dateFormat = new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: 'medium', timeZone: 'UTC' });
const ratingFormat = new Intl.NumberFormat(DEFAULT_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const WEB_APP_SX = brandCtaOutlinedSx();
const SUPPORTING_LINK_SX = { display: 'inline-flex', alignItems: 'center', minHeight: 44 } as const;

function AppGuideRating({ t }: Pick<AppGuideCopy, 't'>) {
  const storeRating = BOARDSESH_APP_STORE_RATING;
  return (
    <Typography variant="body2" color="text.secondary" component="p">
      <MuiLink href={storeRating.source}>
        {t('appGuides:common.rating', { rating: ratingFormat.format(storeRating.rating), count: storeRating.count })}
      </MuiLink>
      {' · '}
      <time dateTime={storeRating.verifiedAt}>
        {t('appGuides:common.ratingCheckedAt', { date: dateFormat.format(new Date(storeRating.verifiedAt)) })}
      </time>
    </Typography>
  );
}

function AppGuidePicker({ t }: Pick<AppGuideCopy, 't'>) {
  return (
    <PageSection id="choose-board" title={t('appGuides:common.chooseBoard')}>
      <Box component="ul" role="list" className={styles.guidePicker}>
        {[...APP_GUIDES, APP_GUIDE_COMPARISON].map((guide) => (
          <PageCard key={guide.id} component="li" padding="sm">
            <Typography component="h3" variant="h6">
              <MuiLink component={LocaleLink} locale={DEFAULT_LOCALE} href={guide.path} sx={SUPPORTING_LINK_SX}>
                {t(`appGuides:pages.${guide.id}.heading`)}
              </MuiLink>
            </Typography>
            <Typography component="p" variant="body2" color="text.secondary">
              {t(`appGuides:pages.${guide.id}.description`)}
            </Typography>
          </PageCard>
        ))}
      </Box>
    </PageSection>
  );
}

function AppGuideDetails({ guide, t }: GuideSectionProps) {
  return (
    <>
      <AppGuideComparison guide={guide} t={t} />
      <PageSection id="in-session" title={t(`appGuides:pages.${guide.id}.workflowTitle`)}>
        {guide.workflow.map((section) => (
          <PageSection key={section.id} id={`guide-${section.id}`}>
            <Typography component="h3" variant="h6" sx={{ mb: 1 }}>
              {t(`appGuides:pages.${guide.id}.workflow.${section.id}.title`)}
            </Typography>
            <Prose>{t(`appGuides:pages.${guide.id}.workflow.${section.id}.body`)}</Prose>
          </PageSection>
        ))}
      </PageSection>
    </>
  );
}

function AppGuideNavigation({ t }: Pick<AppGuideCopy, 't'>) {
  return (
    <Box component="nav" aria-label={t('appGuides:common.navigation')} className={styles.guideNavigation}>
      <MuiLink href="#comparison" sx={SUPPORTING_LINK_SX}>
        {t('appGuides:common.comparison')}
      </MuiLink>
      <MuiLink href="#in-session" sx={SUPPORTING_LINK_SX}>
        {t('appGuides:common.workflow')}
      </MuiLink>
      <MuiLink href="#compatibility" sx={SUPPORTING_LINK_SX}>
        {t('appGuides:common.compatibility')}
      </MuiLink>
      <MuiLink href="#download" sx={SUPPORTING_LINK_SX}>
        {t('appGuides:common.downloadHeading')}
      </MuiLink>
      <MuiLink href="#sources" sx={SUPPORTING_LINK_SX}>
        {t('appGuides:common.sources')}
      </MuiLink>
    </Box>
  );
}

function AppGuideReferences({ guide, t }: GuideSectionProps) {
  return (
    <>
      {guide.sources.length > 0 && (
        <PageSection id="sources" title={t('appGuides:common.sources')}>
          <Prose>{t('appGuides:common.independence')}</Prose>
          <ProseList ordered>
            {guide.sources.map((source) => (
              <li key={source.id} id={`app-guide-source-${source.id}`} className={styles.source}>
                <MuiLink href={source.url}>{t(`appGuides:pages.${guide.id}.sources.${source.id}`)}</MuiLink>
                {' · '}
                <time dateTime={source.checkedAt}>
                  {t('appGuides:common.checkedAt', { date: dateFormat.format(new Date(source.checkedAt)) })}
                </time>
              </li>
            ))}
          </ProseList>
        </PageSection>
      )}
      <PageSection title={t('appGuides:common.related')}>
        <ProseList>
          {guide.related.map((related) => (
            <li key={related.id}>
              <MuiLink component={LocaleLink} locale={DEFAULT_LOCALE} href={related.href} sx={SUPPORTING_LINK_SX}>
                {t(`appGuides:pages.${guide.id}.related.${related.id}`)}
              </MuiLink>
            </li>
          ))}
        </ProseList>
      </PageSection>
    </>
  );
}

export default function AppGuidePage({ guide, t, storeLabels }: AppGuidePageProps) {
  const heading = t(`appGuides:pages.${guide.id}.heading`);
  const intro = t(`appGuides:pages.${guide.id}.intro`);
  const hubLabel = t('appGuides:common.hubLink');
  const openWebLabel = t('appGuides:common.openWebApp');
  const isHub = guide.id === 'hub';
  const placement = guide.id === 'spray-wall-apps' ? 'compare-spray' : (`compare-${guide.id}` as const);
  const guideImage = guide.screenshot
    ? marketingScreenshot('android', DEFAULT_LOCALE, guide.screenshot)
    : getBoardGalleryLayouts(guide.boardType)[0];
  if (!guideImage) throw new Error(`Missing board gallery art for ${guide.id}`);
  const imageSrc = resolveStaticAssetUrl(guideImage.src);
  const canonical = absoluteUrl(guide.path);
  const breadcrumbs = [
    { label: t('appGuides:common.home'), path: '/' },
    { label: hubLabel, path: APP_GUIDE_HUB.path },
    ...(isHub ? [] : [{ label: heading, path: guide.path }]),
  ];
  const breadcrumbId = `${canonical}#breadcrumb`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': canonical,
        url: canonical,
        name: heading,
        description: intro,
        inLanguage: DEFAULT_LOCALE,
        breadcrumb: { '@id': breadcrumbId },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': breadcrumbId,
        itemListElement: breadcrumbs.map((crumb, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: crumb.label,
          item: absoluteUrl(crumb.path),
        })),
      },
      ...(guide.id === 'spray-wall-apps'
        ? [
            {
              '@type': 'Article',
              headline: heading,
              description: intro,
              image: imageSrc.startsWith('/') ? absoluteUrl(imageSrc) : imageSrc,
              author: { '@type': 'Organization', name: t('appGuides:common.boardsesh'), url: absoluteUrl() },
              dateModified: guide.updatedAt,
              inLanguage: DEFAULT_LOCALE,
              mainEntityOfPage: { '@id': canonical },
            },
          ]
        : []),
    ],
  };

  return (
    <PageShell
      width="wide"
      title={heading}
      lead={intro}
      headerClassName={styles.guideHeader}
      breadcrumb={
        <Breadcrumbs aria-label={t('appGuides:common.breadcrumbLabel')}>
          {breadcrumbs.map((crumb, index) =>
            index === breadcrumbs.length - 1 ? (
              <Typography key={crumb.path} variant="inherit" color="text.primary" aria-current="page">
                {crumb.label}
              </Typography>
            ) : (
              <MuiLink
                key={crumb.path}
                component={LocaleLink}
                href={crumb.path}
                locale={DEFAULT_LOCALE}
                sx={quietLinkSx}
              >
                {crumb.label}
              </MuiLink>
            ),
          )}
        </Breadcrumbs>
      }
    >
      <JsonLd data={structuredData} />
      <Typography component="p" variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {t('appGuides:common.publisher')}
        {' · '}
        <time dateTime={guide.updatedAt}>
          {t('appGuides:common.updatedAt', { date: dateFormat.format(new Date(guide.updatedAt)) })}
        </time>
      </Typography>
      {isHub ? (
        <AppGuidePicker t={t} />
      ) : (
        <>
          <PageSection id="recommendation" title={t(`appGuides:pages.${guide.id}.verdictTitle`)}>
            <Prose>{t(`appGuides:pages.${guide.id}.tradeoffs`)}</Prose>
            <AppGuideRating t={t} />
          </PageSection>
          <AppGuideNavigation t={t} />
          <AppGuideDetails guide={guide} t={t} />
        </>
      )}
      <Box className={styles.hero}>
        <Box>
          <PageSection id="compatibility" title={t('appGuides:common.compatibility')}>
            <Prose>{t(`appGuides:pages.${guide.id}.compatibility`)}</Prose>
            {isHub && <Prose>{t('appGuides:pages.hub.tradeoffs')}</Prose>}
          </PageSection>
          <PageSection id="download" title={t('appGuides:common.downloadHeading')}>
            <Box className={styles.downloadActions}>
              <StoreInstallButtons placement={placement} labels={storeLabels} align="start" sharedHtml />
              <StartClimbingButton
                label={openWebLabel}
                ariaLabel={openWebLabel}
                placement={placement}
                variant="outlined"
                sx={WEB_APP_SX}
              />
            </Box>
            <Box sx={{ display: 'grid', gap: 1.5, mt: 2 }}>
              {isHub && <AppGuideRating t={t} />}
              <Suspense fallback={null}>
                <CommunityProofLine locale={DEFAULT_LOCALE} />
              </Suspense>
            </Box>
          </PageSection>
        </Box>
        <Box className={styles.heroImage}>
          <Image
            src={imageSrc}
            alt={t(`appGuides:pages.${guide.id}.screenshotAlt`)}
            width={guideImage.width}
            height={guideImage.height}
            sizes="(max-width: 760px) 156px, 210px"
            className={styles.image}
          />
        </Box>
      </Box>
      <AppGuideReferences guide={guide} t={t} />
    </PageShell>
  );
}
