// The three printable sheets for one board (#4415): the photo poster, the plain
// poster and the four-card sheet. Server components; the only client islands are
// the code itself (`PosterQr`) and the name fitter (`PosterFitText`).
//
// Plain elements and a stylesheet rather than MUI Typography: every Typography
// variant carries a themed colour, and these sheets are black on white in both
// themes because they are read off paper by a phone camera. Colour appears only
// as SVG fills, an <img>, or text colour — browsers drop CSS backgrounds when
// "background graphics" is unticked, which is the default.

import React from 'react';
import PosterQr from '@/app/components/poster/poster-qr';
import PosterFitText from '@/app/components/poster/poster-fit-text';
import { qrQuietZoneMm } from '@/app/components/poster/qr-geometry';
import { CARD_NAME_FIT, PHOTO_NAME_FIT, PLAIN_NAME_FIT, estimateNameFitStep, type NameFitProfile } from './name-fit';
import styles from './board-poster.module.css';

/**
 * Printed widths of the code, quiet zone included, in millimetres; the sheet
 * reads them through `--poster-qr-box`. The plain poster keeps the design's
 * 110 mm. The photo poster's code grew from 82 to 104 mm and the card's from 62
 * to 68 mm after print QA found both only scanned at arm's length; the photo
 * gave up 20 mm of height to make room. Every code sits wholly inside the
 * sheet, its white quiet zone included.
 */
const PLAIN_QR_MM = 110;
const PHOTO_QR_MM = 104;
const CARD_QR_MM = 68;
/** An LED card also carries the compatibility lines, so its code keeps the 62 mm the design started from. */
const LED_CARD_QR_MM = 62;

/** The brand, never translated. The photo poster sets the mark in front of it. */
const BRAND_NAME = 'Boardsesh';

/** The Boardsesh mark: the 1024 px colour raster. Never traced, recoloured or redrawn. */
const BRAND_MARK_SRC = '/brand/boardsesh-mark.webp';

export type BoardPosterCopy = {
  headline: string;
  steps: readonly [string, string, string];
  justInstalled: string;
  typedUrlLabel: string;
  openSource: string;
  printed: string;
  /** LED boards only: "Works with Kilter." and the non-affiliation line. */
  legal: { compatibility: string; independence: string } | null;
};

export type BoardPosterContent = {
  name: string;
  /** The wall's fixed angle, or null when the board's angle is adjustable. */
  angle: number | null;
  /** The gym (a Spraywall) or the board's own location label (an LED board), or null. */
  place: string | null;
  qrUrl: string;
  typedUrl: string | null;
  photoUrl: string | null;
  copy: BoardPosterCopy;
};

/** A CSS custom property for one sheet's code geometry, which depends on the URL's length. */
function qrGeometryStyle(qrUrl: string, boxMm: number): React.CSSProperties {
  return {
    '--poster-qr-box': `${boxMm}mm`,
    '--poster-qr-quiet': `${qrQuietZoneMm(qrUrl, boxMm).toFixed(3)}mm`,
  } as React.CSSProperties;
}

function FitName({ name, profile, className }: { name: string; profile: NameFitProfile; className: string }) {
  return (
    <PosterFitText
      text={name}
      className={className}
      lineBudgets={profile.lineBudgets}
      initialStep={estimateNameFitStep(name, profile)}
    />
  );
}

/** "25° · Sharma Climbing Gavà", "25°", or nothing at all. */
function Facts({ angle, place, className }: { angle: number | null; place: string | null; className: string }) {
  if (angle === null && !place) return null;
  return (
    <p className={className}>
      {angle !== null && <b>{angle}°</b>}
      {angle !== null && place && (
        <span className={styles.separator} aria-hidden>
          ·
        </span>
      )}
      {place}
    </p>
  );
}

/**
 * The typed fallback, allowed to break after `/b/` and nowhere in the host, so
 * a wrapped line reads `www.boardsesh.com/b/` then the slug. The slug is an
 * inline block: it moves to the next line whole, and only an overlong one
 * wraps inside itself.
 */
function TypedUrl({ label, url, className }: { label: string; url: string; className: string }) {
  const boardPathAt = url.indexOf('/b/');
  const host = boardPathAt === -1 ? url : url.slice(0, boardPathAt + 3);
  const slug = boardPathAt === -1 ? '' : url.slice(boardPathAt + 3);
  return (
    <div className={className}>
      <p className={styles.typedLabel}>{label}</p>
      <p className={styles.typedUrl}>
        <span className={styles.typedHost}>{host}</span>
        <wbr />
        {slug && <span className={styles.typedSlug}>{slug}</span>}
      </p>
    </div>
  );
}

/** Compatibility, not endorsement — LED boards only. Same wording as the gym poster's footer. */
function Legal({ legal, className }: { legal: BoardPosterCopy['legal']; className: string }) {
  if (!legal) return null;
  return (
    <p className={className}>
      {legal.compatibility} {legal.independence}
    </p>
  );
}

function Wordmark({ className }: { className: string }) {
  return <span className={className}>{BRAND_NAME}</span>;
}

/**
 * The headline split around the brand, so the photo poster can set the mark in
 * front of "Boardsesh" in any language: every locale's headline ends in the
 * untranslated brand name, wherever the sentence puts it.
 */
export function splitHeadlineAtBrand(headline: string): { lead: string; trail: string } | null {
  const brandAt = headline.lastIndexOf(BRAND_NAME);
  if (brandAt === -1) return null;
  return { lead: headline.slice(0, brandAt).trimEnd(), trail: headline.slice(brandAt + BRAND_NAME.length) };
}

function StepBadge({ number }: { number: number }) {
  return (
    <svg className={styles.badge} viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#5B22F2" />
      <text x="10" y="14.3" textAnchor="middle" fontSize="12.5" fontWeight="800" fill="#ffffff">
        {number}
      </text>
    </svg>
  );
}

/**
 * The photo poster ("Wall Portrait"): climbers recognise the wall before they
 * read a word. Masthead, the wall's photo, then the name and three steps beside
 * a code sized for walking up to.
 */
export function PhotoPoster({ content }: { content: BoardPosterContent }) {
  const { copy } = content;
  const headline = splitHeadlineAtBrand(copy.headline);
  return (
    <main className={`${styles.sheet} ${styles.photoSheet}`}>
      <header className={styles.mast}>
        {headline ? (
          <p className={styles.mastHeadline}>
            <span className={styles.mastLead}>{headline.lead}</span>
            {/* `alt=""`: the brand name is the very next word. */}
            <img className={styles.mastMark} src={BRAND_MARK_SRC} alt="" />
            <Wordmark className={styles.mastWordmark} />
            {headline.trail}
          </p>
        ) : (
          <p className={styles.mastHeadline}>{copy.headline}</p>
        )}
      </header>
      {/* `alt=""`: the wall's name is the heading right below the photo. */}
      {content.photoUrl && <img className={styles.photo} src={content.photoUrl} alt="" />}
      <section className={styles.photoRow} style={qrGeometryStyle(content.qrUrl, PHOTO_QR_MM)}>
        <div className={styles.photoInfo}>
          <div>
            <FitName name={content.name} profile={PHOTO_NAME_FIT} className={styles.photoName} />
            <Facts angle={content.angle} place={content.place} className={styles.photoFacts} />
          </div>
          <div>
            <ol className={styles.badgeSteps}>
              {copy.steps.map((step, index) => (
                <li key={step}>
                  <StepBadge number={index + 1} />
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className={styles.photoNote}>{copy.justInstalled}</p>
          </div>
        </div>
        <div className={styles.photoQr}>
          <PosterQr value={content.qrUrl} className={styles.qrSvg} />
        </div>
      </section>
      {content.typedUrl && <TypedUrl label={copy.typedUrlLabel} url={content.typedUrl} className={styles.photoTyped} />}
      <footer className={styles.photoFoot}>
        <span>{copy.openSource}</span>
        <span>{copy.printed}</span>
      </footer>
    </main>
  );
}

/**
 * The plain poster ("Tag"): a label, not an ad. Black only, low ink, the
 * biggest code of the three. Whitespace is shared out by weight so the page
 * keeps one rhythm whatever the content.
 */
export function PlainPoster({ content }: { content: BoardPosterContent }) {
  const { copy } = content;
  return (
    <main className={`${styles.sheet} ${styles.plainSheet}`}>
      <p className={styles.plainKicker}>{copy.headline}</p>
      <div className={`${styles.gap} ${styles.plainGapKicker}`} />
      <FitName name={content.name} profile={PLAIN_NAME_FIT} className={styles.plainName} />
      <Facts angle={content.angle} place={content.place} className={styles.plainFacts} />
      <div className={`${styles.gap} ${styles.plainGapAbove}`} />
      <div className={styles.rule} />
      <section className={styles.plainScan} style={qrGeometryStyle(content.qrUrl, PLAIN_QR_MM)}>
        <PosterQr value={content.qrUrl} className={`${styles.qrSvg} ${styles.plainQr}`} />
        <div className={styles.plainStepsColumn}>
          <ol className={styles.plainSteps}>
            {copy.steps.map((step, index) => (
              <li key={step}>
                <span className={styles.plainStepNumber}>{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className={styles.plainNote}>{copy.justInstalled}</p>
        </div>
      </section>
      <div className={`${styles.gap} ${styles.plainGapBelow}`} />
      {content.typedUrl && <TypedUrl label={copy.typedUrlLabel} url={content.typedUrl} className={styles.plainTyped} />}
      <div className={`${styles.gap} ${styles.plainGapFoot}`} />
      <Legal legal={copy.legal} className={styles.plainLegal} />
      <footer className={styles.plainFoot}>
        <Wordmark className={styles.plainWordmark} />
        <span className={styles.plainMeta}>
          {copy.openSource}
          <br />
          {copy.printed}
        </span>
      </footer>
    </main>
  );
}

function Card({ content }: { content: BoardPosterContent }) {
  const { copy } = content;
  const qrMm = copy.legal ? LED_CARD_QR_MM : CARD_QR_MM;
  return (
    <article className={styles.card} style={qrGeometryStyle(content.qrUrl, qrMm)}>
      <p className={styles.cardKicker}>{copy.headline}</p>
      <div className={`${styles.gap} ${styles.cardGapKicker}`} />
      <FitName name={content.name} profile={CARD_NAME_FIT} className={styles.cardName} />
      <Facts angle={content.angle} place={content.place} className={styles.cardFacts} />
      <div className={`${styles.gap} ${styles.cardGapAbove}`} />
      <PosterQr value={content.qrUrl} className={`${styles.qrSvg} ${styles.cardQr}`} />
      <div className={`${styles.gap} ${styles.cardGapBelow}`} />
      {content.typedUrl && <TypedUrl label={copy.typedUrlLabel} url={content.typedUrl} className={styles.cardTyped} />}
      <div className={`${styles.gap} ${styles.cardGapFoot}`} />
      <footer className={styles.cardFoot}>
        <Wordmark className={styles.cardWordmark} />
        <span className={styles.cardMeta}>{copy.printed}</span>
      </footer>
      <Legal legal={copy.legal} className={styles.cardLegal} />
    </article>
  );
}

/**
 * Four cards on one sheet, 93 × 124 mm each, with dashed cut lines: for hold
 * boxes, posts, a home wall's door, a front desk.
 */
export function CardSheet({ content }: { content: BoardPosterContent }) {
  return (
    <main className={`${styles.sheet} ${styles.cardSheet}`}>
      <Card content={content} />
      <Card content={content} />
      <Card content={content} />
      <Card content={content} />
      {/* Cut lines: the outer frame and the centre cross, drawn once each, as
          SVG strokes so they print with background graphics off. */}
      <svg className={styles.cutLines} viewBox="0 0 186 248" preserveAspectRatio="none" aria-hidden>
        <g fill="none" stroke="#000000" strokeWidth="0.2" strokeDasharray="2 1.6" strokeOpacity="0.55">
          <rect x="0.1" y="0.1" width="185.8" height="247.8" />
          <line x1="93" y1="0" x2="93" y2="248" />
          <line x1="0" y1="124" x2="186" y2="124" />
        </g>
      </svg>
    </main>
  );
}
