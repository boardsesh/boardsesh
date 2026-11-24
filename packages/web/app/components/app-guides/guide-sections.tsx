import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { boardTypeLabel } from '@boardsesh/board-constants';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import { brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import {
  BOARDSESH_APP_STORE_RATING,
  hubBoardHref,
  isClaimVisible,
  tileArt,
  type AppGuidePage,
  type ComparisonGuide,
  type GuideLink,
  type GuidePlacement,
} from '@/app/lib/seo/app-guides';
import {
  HUB_BOARD_SLUGS,
  type AppGuidePageId,
  type GuideShot,
  type HubBoardSlug,
  type StepArt,
} from '@/app/lib/seo/app-guide-model';
import {
  boardDrawing,
  boardseshMark,
  browserCapture,
  guideShot,
  sprayWallPhoto,
  type GuideImage,
} from './app-guide-assets';
import { TileDiagram } from './diagrams';
import {
  CtaRow,
  DeviceFrame,
  ProofLines,
  RatingLine,
  RunsOnStrip,
  SectionHead,
  SourcePending,
  WorksWithPill,
  dateFormat,
  type T,
} from './guide-parts';
import HoldRing, { type HoldRole } from './hold-ring';
import styles from './app-guide.module.css';

const OUTLINED_SX = brandCtaOutlinedSx();
const LINK_SX = { display: 'inline-flex', alignItems: 'center', minHeight: 44 } as const;
const STEP_RINGS: readonly HoldRole[] = ['start', 'hand', 'hand', 'finish'];

/** The board-type key for the hub tile slug (`so-ill` is `soill` in the catalogue). */
export function hubBoardType(slug: HubBoardSlug) {
  return slug === 'so-ill' ? 'soill' : slug;
}

/** The drawing or photo that stands for a comparison page's board(s). */
export function pageArt(guide: ComparisonGuide, t: T): GuideImage & { alt: string; caption: string } {
  if (!guide.boardType) {
    const photo = sprayWallPhoto();
    return { ...photo, alt: t('appGuides:common.sprayPhotoAlt'), caption: t('appGuides:common.sprayPhotoCaption') };
  }
  const drawing = boardDrawing(guide.boardType);
  const values = { board: boardTypeLabel(guide.boardType), layout: drawing.caption };
  return {
    ...drawing,
    alt: t('appGuides:common.boardAlt', values),
    caption: t('appGuides:common.boardCaption', values),
  };
}

export function shotAlt(t: T, shot: GuideShot) {
  return t(`appGuides:common.shots.${shot}`);
}

// ---------- Hero ----------

export function ComparisonHero({
  guide,
  t,
  storeLabels,
  byline,
}: {
  guide: ComparisonGuide;
  t: T;
  storeLabels: StoreButtonLabels;
  byline: React.ReactNode;
}) {
  const back = guideShot(guide.hero.back);
  const front = guide.hero.front;
  return (
    <Box component="section" className={styles.hero} aria-labelledby="page-title">
      <Box className={styles.heroCopy}>
        <WorksWithPill>{t(`appGuides:pages.${guide.id}.hero.pill`)}</WorksWithPill>
        <Typography variant="h1" id="page-title" className={styles.title}>
          {t(`appGuides:pages.${guide.id}.hero.h1`)}
        </Typography>
        <Typography variant="lead" component="p" className={styles.lead}>
          {t(`appGuides:pages.${guide.id}.hero.lead`)}
        </Typography>
        {byline}
        <RunsOnStrip t={t} runsOn={guide.runsOn} />
        <CtaRow
          t={t}
          storeLabels={storeLabels}
          placement={guide.placement}
          pageId={guide.id}
          action={guide.primaryAction}
        />
        <ProofLines t={t} />
      </Box>
      <Box className={styles.heroArt}>
        <DeviceFrame image={back} alt="" className={styles.deviceBack} sizes="(max-width: 600px) 176px, 272px" />
        {front.kind === 'shot' ? (
          <DeviceFrame
            image={guideShot(front.shot)}
            alt={shotAlt(t, front.shot)}
            className={styles.deviceFront}
            sizes="(max-width: 600px) 176px, 272px"
            priority
          />
        ) : (
          <HeroBoardCard guide={guide} t={t} />
        )}
      </Box>
    </Box>
  );
}

function HeroBoardCard({ guide, t }: { guide: ComparisonGuide; t: T }) {
  const art = pageArt(guide, t);
  return (
    <Box component="figure" className={styles.boardCard}>
      <Image
        src={art.src}
        alt={art.alt}
        width={art.width}
        height={art.height}
        sizes="300px"
        preload
        fetchPriority="high"
        loading="eager"
      />
      <figcaption>{art.caption}</figcaption>
    </Box>
  );
}

/** "A guide from Boardsesh. We make Boardsesh…" with the updated date beside it. */
export function Byline({ guide, t }: { guide: AppGuidePage; t: T }) {
  return (
    <Typography variant="body2" color="text.secondary" component="p" className={styles.byline}>
      {guide.hasByline ? t(`appGuides:pages.${guide.id}.hero.byline`) : t('appGuides:common.publisher')}
      {' · '}
      <time dateTime={guide.updatedAt}>
        {t('appGuides:common.updatedAt', { date: dateFormat.format(new Date(guide.updatedAt)) })}
      </time>
    </Typography>
  );
}

// ---------- Verdict ----------

export function VerdictCards({ guide, t }: { guide: ComparisonGuide; t: T }) {
  const mark = boardseshMark();
  const keepHeading =
    guide.competitors.length === 1
      ? t('appGuides:common.verdict.keepOfficial', { app: guide.competitorNames[guide.competitors[0]] })
      : t('appGuides:common.verdict.keepOther');
  return (
    <Box component="section" id="verdict" className={styles.section} aria-labelledby="verdict-title">
      <SectionHead
        id="verdict-title"
        eyebrow={t('appGuides:common.eyebrows.verdict')}
        ring="start"
        title={t(`appGuides:pages.${guide.id}.verdict.heading`)}
      />
      <Box className={styles.verdict}>
        <Box component="article" className={`${styles.verdictCard} ${styles.verdictCardOurs}`}>
          <Box className={styles.verdictHeader}>
            <Image src={mark.src} alt="" width={40} height={40} className={styles.verdictMark} />
            <Typography component="h3" className={styles.h3}>
              {t('appGuides:common.verdict.pickBoardsesh')}
            </Typography>
          </Box>
          <Box component="ul" className={styles.checks}>
            {guide.pickIf
              .filter((key) => isClaimVisible(guide, `verdict.pickIf.${key}`))
              .map((key) => (
                <li key={key}>
                  <HoldRing role="start" size="sm" />
                  <span>{t(`appGuides:pages.${guide.id}.verdict.pickIf.${key}`)}</span>
                </li>
              ))}
          </Box>
        </Box>
        <Box className={styles.verdictSide}>
          <Box component="article" className={styles.verdictCard}>
            <Box className={styles.verdictHeader}>
              <Typography component="h3" className={styles.h3}>
                {keepHeading}
              </Typography>
            </Box>
            <Box component="ul" className={styles.checks}>
              {guide.keepIf
                .filter((key) => isClaimVisible(guide, `verdict.keepIf.${key}`))
                .map((key) => (
                  <li key={key}>
                    <HoldRing role="unlit" size="sm" />
                    <span>{t(`appGuides:pages.${guide.id}.verdict.keepIf.${key}`)}</span>
                  </li>
                ))}
            </Box>
          </Box>
          <Box className={styles.bottomLine}>
            <HoldRing role="finish" size="md" />
            <p>{t(`appGuides:pages.${guide.id}.verdict.bottomLine`)}</p>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// ---------- Feature tiles ----------

export type ResolvedTile = { id: string; title: string; body: string; pending?: boolean };

export function FeatureTiles({
  t,
  tiles,
  pageId,
  layout = 'columns',
}: {
  t: T;
  tiles: readonly ResolvedTile[];
  /** Picks page-specific art, such as the Kilter browser capture. */
  pageId?: AppGuidePageId;
  /** `columns`: art on top (board pages). `rows`: art beside the text, two up (hub). */
  layout?: 'columns' | 'rows';
}) {
  const gridClass = layout === 'rows' ? styles.tilesTwo : tiles.length === 4 ? styles.tilesFour : '';
  return (
    <Box component="ul" className={`${styles.tiles} ${gridClass}`}>
      {tiles.map((tile) => {
        const art = tileArt(tile.id, pageId);
        const artClass =
          art.kind === 'profile-card'
            ? `${styles.tileArt} ${styles.tileArtCard}`
            : art.kind === 'browser-shot'
              ? `${styles.tileArt} ${styles.tileArtBrowser}`
              : styles.tileArt;
        return (
          <li key={tile.id} className={styles.tile}>
            <Box className={artClass}>
              {art.kind === 'profile-card' ? <ProfileCard t={t} /> : null}
              {art.kind === 'browser-shot' ? <BrowserShot t={t} sizes="(max-width: 600px) 100vw, 360px" /> : null}
              {art.kind === 'shot' ? (
                <Box className={styles.tileCrop}>
                  <TileShot t={t} shot={art.shot} />
                </Box>
              ) : null}
              {art.kind === 'diagram' ? <TileDiagram t={t} art={art} /> : null}
            </Box>
            <Box className={styles.tileBody}>
              <Typography component="h3" className={styles.h3}>
                {tile.title}
              </Typography>
              <Typography component="p" color="text.secondary">
                {tile.body}
                {tile.pending ? <SourcePending t={t} /> : null}
              </Typography>
            </Box>
          </li>
        );
      })}
    </Box>
  );
}

/**
 * The iPhone profile capture, cropped to its "Across your boards" card (about 21% to
 * 67% of the capture: the climb count, MoonBoard Masters 2017, Kilter Homewall,
 * MoonBoard Masters 2019 and "Show all 9 boards"). The box takes that window's
 * 736:730 shape and `object-position` lines it up, so nothing is stretched.
 */
function ProfileCard({ t }: { t: T }) {
  const image = guideShot('profile');
  return (
    <Image
      src={image.src}
      alt={t('appGuides:common.profileCardAlt')}
      width={image.width}
      height={image.height}
      sizes="(max-width: 600px) 100vw, 360px"
      loading="lazy"
      className={styles.profileCard}
    />
  );
}

/** The real browser app on a Kilter wall, in its own landscape frame (never cropped to a phone). */
export function BrowserShot({ t, sizes, className }: { t: T; sizes: string; className?: string }) {
  const image = browserCapture();
  return (
    <Image
      src={image.src}
      alt={t('appGuides:common.browserShotAlt')}
      width={image.width}
      height={image.height}
      sizes={sizes}
      loading="lazy"
      className={className ?? styles.browserShot}
    />
  );
}

/** A real screen (the queue, the workout builder) carries information: it gets the shot's own alt text. */
function TileShot({ t, shot }: { t: T; shot: GuideShot }) {
  const image = guideShot(shot);
  return (
    <Image
      src={image.src}
      alt={shotAlt(t, shot)}
      width={image.width}
      height={image.height}
      sizes="230px"
      loading="lazy"
    />
  );
}

export function OnlyTray({ guide, t }: { guide: ComparisonGuide; t: T }) {
  const tiles = guide.tiles
    .filter((tile) => isClaimVisible(guide, `only.tiles.${tile.id}`))
    .map((tile) => ({
      id: tile.id,
      title: t(`appGuides:pages.${guide.id}.only.tiles.${tile.id}.title`),
      body: t(`appGuides:pages.${guide.id}.only.tiles.${tile.id}.body`),
      pending: tile.pending,
    }));
  return (
    <Box
      component="section"
      id="differences"
      className={`${styles.section} ${styles.tray}`}
      aria-labelledby="only-title"
    >
      <SectionHead
        id="only-title"
        eyebrow={t('appGuides:common.eyebrows.only')}
        ring="finish"
        title={t(`appGuides:pages.${guide.id}.only.heading`)}
        lead={t(`appGuides:pages.${guide.id}.only.lead`)}
      />
      <FeatureTiles t={t} tiles={tiles} pageId={guide.id} />
    </Box>
  );
}

// ---------- Aurora brands ----------

const BRAND_FACTS = ['layouts', 'sizes', 'angles', 'benchmarks', 'officialApp'] as const;

export function BrandCards({ guide, t }: { guide: ComparisonGuide; t: T }) {
  if (guide.brands.length === 0) return null;
  return (
    <Box component="section" id="brands" className={styles.section} aria-labelledby="brands-title">
      <SectionHead
        id="brands-title"
        eyebrow={t('appGuides:common.eyebrows.brands')}
        ring="start"
        title={t(`appGuides:pages.${guide.id}.brands.heading`)}
        lead={t(`appGuides:pages.${guide.id}.brands.lead`)}
      />
      <Box component="ul" className={styles.brands}>
        {guide.brands.map((brand) => {
          const drawing = boardDrawing(hubBoardType(brand.id as HubBoardSlug) as Parameters<typeof boardDrawing>[0]);
          const name = t(`appGuides:pages.${guide.id}.brands.items.${brand.id}.name`);
          return (
            <li key={brand.id} id={brand.id} className={styles.brand}>
              <Box className={styles.brandArt}>
                <Image
                  src={drawing.src}
                  alt={t('appGuides:common.boardAlt', { board: name, layout: drawing.caption })}
                  width={drawing.width}
                  height={drawing.height}
                  sizes="(max-width: 600px) 100vw, 200px"
                  loading="lazy"
                />
              </Box>
              <Box className={styles.brandBody}>
                <Typography component="h3" className={styles.h3}>
                  {name}
                </Typography>
                <Typography component="p" color="text.secondary">
                  {t(`appGuides:pages.${guide.id}.brands.items.${brand.id}.summary`)}
                  {brand.pending ? <SourcePending t={t} /> : null}
                </Typography>
                <Box component="dl" className={styles.brandFacts}>
                  {BRAND_FACTS.map((fact) => (
                    <div key={fact}>
                      <dt>{t(`appGuides:common.brandFacts.${fact}`)}</dt>
                      <dd>{t(`appGuides:pages.${guide.id}.brands.items.${brand.id}.${fact}`)}</dd>
                    </div>
                  ))}
                </Box>
              </Box>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}

// ---------- Other spray wall apps ----------

export function OtherApps({ guide, t }: { guide: ComparisonGuide; t: T }) {
  if (guide.otherApps.length === 0) return null;
  return (
    <Box component="section" id="other-apps" className={styles.section} aria-labelledby="other-apps-title">
      <SectionHead
        id="other-apps-title"
        eyebrow={t('appGuides:common.eyebrows.otherApps')}
        ring="foot"
        title={t(`appGuides:pages.${guide.id}.otherApps.heading`)}
        lead={t(`appGuides:pages.${guide.id}.otherApps.lead`)}
      />
      <Box component="ul" className={styles.otherApps}>
        {guide.otherApps.map((app) => {
          const name = t(`appGuides:pages.${guide.id}.otherApps.items.${app.id}.name`);
          return (
            <li key={app.id}>
              <Typography component="h3" className={styles.h3}>
                {name}
              </Typography>
              <Typography component="p" color="text.secondary">
                {t(`appGuides:pages.${guide.id}.otherApps.items.${app.id}.summary`)}
                {app.pending ? <SourcePending t={t} /> : null}
              </Typography>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}

// ---------- A session, step by step ----------

function stepImage(
  guide: ComparisonGuide,
  t: T,
  art: StepArt,
): (GuideImage & { alt: string; drawing: boolean }) | null {
  if (art === null) return null;
  if (art === 'board') return guide.boardType ? { ...pageArt(guide, t), drawing: true } : null;
  return { ...guideShot(art), alt: shotAlt(t, art), drawing: art === 'spray-photo' };
}

export function SessionSteps({ guide, t }: { guide: ComparisonGuide; t: T }) {
  return (
    <Box component="section" id="session" className={styles.section} aria-labelledby="session-title">
      <SectionHead
        id="session-title"
        eyebrow={t('appGuides:common.eyebrows.session')}
        ring="hand"
        title={t(`appGuides:pages.${guide.id}.session.heading`)}
      />
      <Box component="ol" className={styles.steps}>
        {guide.steps.map((step, index) => {
          const image = stepImage(guide, t, step.screenshot);
          return (
            <li key={step.id} className={styles.step}>
              {image ? (
                <Box className={`${styles.stepShot} ${image.drawing ? styles.stepShotDrawing : ''}`}>
                  <Image
                    src={image.src}
                    alt={image.alt}
                    width={image.width}
                    height={image.height}
                    sizes="(max-width: 600px) 112px, 300px"
                    loading="lazy"
                  />
                </Box>
              ) : (
                // No capture fits this step: an empty wall, never a screen from another board.
                <Box className={`${styles.stepShot} ${styles.stepShotEmpty}`} aria-hidden="true" />
              )}
              <Box className={styles.stepTitle}>
                <HoldRing role={STEP_RINGS[index % STEP_RINGS.length]} size="number">
                  {index + 1}
                </HoldRing>
                <Typography component="h3" className={styles.h3}>
                  {t(`appGuides:pages.${guide.id}.session.steps.${step.id}.title`)}
                </Typography>
              </Box>
              <Typography component="p" color="text.secondary">
                {t(`appGuides:pages.${guide.id}.session.steps.${step.id}.body`)}
              </Typography>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}

// ---------- Bring your logbook ----------

export function LogbookTray({ guide, t }: { guide: ComparisonGuide; t: T }) {
  const capture = guideShot('logbook');
  const importCta = guide.logbookCta === 'import';
  return (
    <Box
      component="section"
      id="logbook"
      className={`${styles.section} ${styles.tray}`}
      aria-labelledby="logbook-title"
    >
      <Box className={styles.importGrid}>
        <Box>
          <SectionHead
            id="logbook-title"
            eyebrow={t('appGuides:common.eyebrows.logbook')}
            ring="start"
            title={t(`appGuides:pages.${guide.id}.logbook.heading`)}
            lead={t(`appGuides:pages.${guide.id}.logbook.lead`)}
          />
          <Button
            component={LocaleLink}
            href={importCta ? '/bring-your-logbook' : '/help/logbook'}
            locale={DEFAULT_LOCALE}
            variant="outlined"
            sx={OUTLINED_SX}
          >
            {importCta ? t('appGuides:common.logbookCta') : t('appGuides:common.logbookHelpCta')}
          </Button>
          <Box className={styles.importArt}>
            <Image
              src={capture.src}
              alt={shotAlt(t, 'logbook')}
              width={capture.width}
              height={capture.height}
              sizes="300px"
              loading="lazy"
            />
          </Box>
        </Box>
        <Box className={styles.paths}>
          {guide.paths.map((path) => (
            <Box component="article" key={path.id} className={styles.path}>
              <Typography component="h3" className={styles.h3}>
                {t(`appGuides:pages.${guide.id}.logbook.paths.${path.id}.title`)}
              </Typography>
              <Typography component="p" color="text.secondary" className={styles.pathWhen}>
                {t(`appGuides:pages.${guide.id}.logbook.paths.${path.id}.subtitle`)}
              </Typography>
              <Box component="ol" className={styles.pathSteps}>
                {path.steps.map((step) => (
                  <li key={step}>{t(`appGuides:pages.${guide.id}.logbook.paths.${path.id}.steps.${step}`)}</li>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// ---------- FAQ (no FAQPage markup: the answers are content, not a rich result) ----------

export function Faq({
  guide,
  t,
  items,
}: {
  guide: AppGuidePage;
  t: T;
  items: readonly { id: string; q: string; a: string }[];
}) {
  return (
    <Box component="section" id="faq" className={styles.section} aria-labelledby="faq-title">
      <SectionHead
        id="faq-title"
        eyebrow={t('appGuides:common.eyebrows.faq')}
        ring="hand"
        title={t(`appGuides:pages.${guide.id}.faq.heading`)}
      />
      <Box className={styles.faq}>
        {items.map((item, index) => (
          <details key={item.id} open={index === 0}>
            {/* The question is the item's heading (an <h3> under the FAQ's <h2>); it keeps the summary's look. */}
            <summary>
              <Typography component="h3" className={styles.faqQuestion}>
                {item.q}
              </Typography>
            </summary>
            <Typography component="p" color="text.secondary">
              {item.a}
            </Typography>
          </details>
        ))}
      </Box>
    </Box>
  );
}

export function Method({ guide, t }: { guide: AppGuidePage; t: T }) {
  return (
    <Box
      component="section"
      id="method"
      className={`${styles.section} ${styles.method}`}
      aria-labelledby="method-title"
    >
      <Typography variant="h4" component="h2" id="method-title" className={styles.title}>
        {t(`appGuides:pages.${guide.id}.method.heading`)}
      </Typography>
      <Typography component="p" color="text.secondary">
        {t(`appGuides:pages.${guide.id}.method.body`)}
      </Typography>
    </Box>
  );
}

// ---------- Closing band ----------

export function CtaBand({
  guide,
  t,
  storeLabels,
  placement,
  art,
}: {
  guide: AppGuidePage;
  t: T;
  storeLabels: StoreButtonLabels;
  placement: GuidePlacement;
  art: GuideImage;
}) {
  return (
    <Box
      component="section"
      className={`${styles.section} ${styles.tray} ${styles.ctaBand}`}
      aria-labelledby="cta-title"
    >
      <Box>
        <Typography variant="marketingH2" component="h2" id="cta-title">
          {t(`appGuides:pages.${guide.id}.cta.heading`)}
        </Typography>
        <Typography variant="lead" component="p" className={styles.lead}>
          {t(`appGuides:pages.${guide.id}.cta.body`)}
        </Typography>
        <CtaRow t={t} storeLabels={storeLabels} placement={placement} pageId={guide.id} action={guide.primaryAction} />
        <RatingLine t={t} />
      </Box>
      <Box className={styles.ctaBoard} aria-hidden="true">
        <Image src={art.src} alt="" width={art.width} height={art.height} sizes="340px" loading="lazy" />
      </Box>
    </Box>
  );
}

// ---------- Other comparisons + help ----------

/** Board tiles this page does not already cover, then the spray wall comparison. */
export function CompareAnotherBoard({ guide, t }: { guide: ComparisonGuide; t: T }) {
  const covered = new Set<string>(guide.id === 'aurora' ? guide.brands.map((brand) => brand.id) : [guide.id]);
  const boards = HUB_BOARD_SLUGS.filter((slug) => !covered.has(slug));
  return (
    <Box component="section" className={styles.section} aria-labelledby="more-title">
      <Typography component="h2" id="more-title" className={styles.h3}>
        {t('appGuides:common.otherBoards')}
      </Typography>
      <Box component="ul" className={styles.boardLinks}>
        {boards.map((slug) => {
          const drawing = boardDrawing(hubBoardType(slug) as Parameters<typeof boardDrawing>[0]);
          return (
            <li key={slug}>
              <Box
                component={LocaleLink}
                href={hubBoardHref(slug)}
                locale={DEFAULT_LOCALE}
                className={styles.boardLink}
              >
                <Image src={drawing.src} alt="" width={44} height={44} sizes="44px" loading="lazy" />
                <span>{t(`appGuides:pages.hub.boards.tiles.${slug}.name`)}</span>
              </Box>
            </li>
          );
        })}
        {guide.boardType ? (
          <li>
            <Box
              component={LocaleLink}
              href="/compare/spray-wall-apps"
              locale={DEFAULT_LOCALE}
              className={styles.boardLink}
            >
              <Image src={sprayWallPhoto().src} alt="" width={44} height={44} sizes="44px" loading="lazy" />
              <span>{t('appGuides:common.sprayLink')}</span>
            </Box>
          </li>
        ) : null}
      </Box>
    </Box>
  );
}

export function RelatedHelp({ t, links }: { t: T; links: readonly GuideLink[] }) {
  return (
    <Box component="section" className={styles.section} aria-labelledby="help-title">
      <Typography component="h2" id="help-title" className={styles.h3}>
        {t('appGuides:common.related')}
      </Typography>
      <Box component="ul" className={styles.related}>
        {links.map((link) => (
          <li key={link.id}>
            <MuiLink component={LocaleLink} href={link.href} locale={DEFAULT_LOCALE} sx={LINK_SX}>
              {t(`appGuides:common.relatedLinks.${link.id}`)}
            </MuiLink>
          </li>
        ))}
      </Box>
    </Box>
  );
}

// ---------- Sources: one quiet disclosure, grouped by the claim they back ----------

export type SourceGroup = { id: string; title: string; sourceIds: readonly string[] };

export function SourcesDisclosure({ guide, t, groups }: { guide: AppGuidePage; t: T; groups: readonly SourceGroup[] }) {
  const byId = new Map(guide.sources.map((source) => [source.id, source]));
  const grouped = new Set(groups.flatMap((group) => group.sourceIds));
  const other = guide.sources.filter((source) => !grouped.has(source.id)).map((source) => source.id);
  const allGroups = [
    ...groups,
    ...(other.length > 0
      ? [{ id: 'sources-other', title: t('appGuides:common.sources.other'), sourceIds: other }]
      : []),
  ];
  // One link per URL on the page: a store listing cited by six rows is linked
  // under the first row that cites it, and later rows name it as plain text.
  const linkedAt = new Map<string, string>();
  for (const group of allGroups) {
    for (const sourceId of group.sourceIds) {
      const url = byId.get(sourceId)?.url;
      if (url && !linkedAt.has(url)) linkedAt.set(url, `${group.id}:${sourceId}`);
    }
  }
  const dates = guide.sources.map((source) => source.checkedAt).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  const checked =
    from === to
      ? t('appGuides:common.sources.checkedOn', { date: dateFormat.format(new Date(from)) })
      : t('appGuides:common.sources.checkedBetween', {
          from: dateFormat.format(new Date(from)),
          to: dateFormat.format(new Date(to)),
        });
  return (
    <Box component="details" id="sources" className={styles.sources}>
      <summary>
        {t('appGuides:common.sources.title')}
        <span className={styles.sourcesMeta}>
          {t('appGuides:common.sources.count', { count: guide.sources.length })}
          {' · '}
          {checked}
          {' · '}
          {t('appGuides:common.sources.rating', {
            date: dateFormat.format(new Date(BOARDSESH_APP_STORE_RATING.verifiedAt)),
          })}
        </span>
      </summary>
      <Box className={styles.sourcesBody}>
        <Typography component="p" color="text.secondary" variant="body2">
          {t('appGuides:common.independence')}
        </Typography>
        {allGroups.map((group) => (
          <React.Fragment key={group.id}>
            {/* A label, not a heading: as h3s these repeated every section title in the outline. */}
            <Typography component="p" id={group.id} className={styles.sourceGroup}>
              {group.title}
            </Typography>
            <Box component="ul" className={styles.sourceList}>
              {group.sourceIds.map((sourceId) => {
                const source = byId.get(sourceId);
                if (!source) return null;
                const label = t(`appGuides:pages.${guide.id}.sources.${sourceId}`);
                return (
                  <li key={sourceId}>
                    {linkedAt.get(source.url) === `${group.id}:${sourceId}` ? (
                      <MuiLink href={source.url}>{label}</MuiLink>
                    ) : (
                      <>
                        {label}
                        {' · '}
                        {t('appGuides:common.sources.linkedAbove')}
                      </>
                    )}
                    {' · '}
                    <time dateTime={source.checkedAt}>
                      {t('appGuides:common.checkedAt', { date: dateFormat.format(new Date(source.checkedAt)) })}
                    </time>
                  </li>
                );
              })}
            </Box>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
}
