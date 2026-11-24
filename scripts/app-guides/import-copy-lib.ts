/**
 * Turns one writer copy file (`<page>.json`, the shape in the writer brief)
 * into the two things the website reads:
 *
 * - catalog text for `pages.<page>` in `appGuides.json`, keyed by stable ids;
 * - registry structure for `app-guide-registry.generated.ts`: verdicts, source
 *   ids, source URLs and dates, screenshots and counts.
 *
 * Every rule a writer can break is checked here, so a bad file fails the import
 * instead of shipping: length caps, counts, verdict values, source ids and the
 * `[PENDING-…]` placeholders the editors use for unverified claims.
 */
import {
  APP_GUIDE_PAGE_IDS,
  AURORA_BRAND_SLUGS,
  COMPETITOR_NAMES,
  GATEABLE_PATH,
  GATED_CLAIM_PAGES,
  GATED_CLAIM_PATTERNS,
  GUIDE_SHOTS,
  HUB_BOARD_SLUGS,
  NEUTRAL_STEP_SHOTS,
  STEP_SHOTS,
  hubBoardHref,
  type AppGuidePageId,
  type ComparisonPageId,
  type ComparisonPageRegistry,
  type GatedClaimId,
  type GuideQuote,
  type GuideItem,
  type GuideRow,
  type StepArt,
  type GuideSource,
  type GuideVerdict,
  type HubBoardSlug,
  type HubPageRegistry,
  type VerificationDate,
} from '../../packages/web/app/lib/seo/app-guide-model';

export type CatalogNode = string | { [key: string]: CatalogNode };
export type CatalogPage = { [key: string]: CatalogNode };

export type ImportIssue = { page: string; path: string; message: string; severity: 'error' | 'warning' };

export type ImportResult = {
  catalog: CatalogPage;
  registry: Omit<ComparisonPageRegistry, 'updatedAt'> | Omit<HubPageRegistry, 'updatedAt'>;
  issues: ImportIssue[];
};

export type ImportOptions = {
  /** Keep `[PENDING-…]` placeholders (dev previews). Without it they are errors. */
  allowPending: boolean;
  /**
   * Report every rule as a warning so an unedited draft can be previewed on the
   * dev server. Never commit a `--draft` import: the release import runs without it.
   */
  draft?: boolean;
};

/** Writer values, mapped to the registry's. `competitor` is the spray page's `official`. */
const VERDICTS: Record<string, GuideVerdict> = {
  boardsesh: 'boardsesh',
  'only-boardsesh': 'only',
  tie: 'same',
  official: 'competitor',
  competitor: 'competitor',
  // The competitor doesn't document it: shown as a neutral fact, never a win.
  unlisted: 'unlisted',
};

/**
 * Which competitor does a `competitor` row better, when the copy file does not
 * say (`winners`). Only needed on a page with more than one competitor; an
 * editor's call made from the cells, recorded here so the chip can name the app.
 */
const COMPETITOR_WINNERS: Partial<Record<ComparisonPageId, Record<string, readonly string[]>>> = {
  'spray-wall-apps': {
    setup: ['stokt'],
    community: ['stokt'],
    symmetry: ['stokt', 'retroFlash'],
    'gym-walls': ['crux'],
  },
};

export const CAPS = {
  metaTitle: 60,
  metaDescription: [140, 155],
  cell: 90,
  pickIf: 80,
  faqSentences: 2,
  stepSentences: 1,
} as const;

const COUNTS = {
  pickIf: [5, 5],
  keepIf: [2, 3],
  tiles: [3, 4],
  rows: [7, 12],
  steps: [4, 4],
  paths: [1, 2],
  pathSteps: [3, 3],
  faq: [5, 7],
  hubTiles: [3, 5],
} as const;

const PENDING_TOKEN = /\[PENDING-[A-Z0-9-]+\]/g;
const isPendingId = (id: string) => id.startsWith('PENDING-');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "One sentence. Two." -> 2. Decimals ("1.8"), domains and initials-free copy split cleanly. */
export function countSentences(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?])\s+(?=["'(A-Z0-9])/)
    .filter((part) => part.trim().length > 0).length;
}

type Json = Record<string, unknown>;

class PageReader {
  readonly issues: ImportIssue[] = [];

  constructor(
    readonly page: string,
    readonly options: ImportOptions,
  ) {}

  error(path: string, message: string) {
    this.issues.push({ page: this.page, path, message, severity: this.options.draft ? 'warning' : 'error' });
  }

  warn(path: string, message: string) {
    this.issues.push({ page: this.page, path, message, severity: 'warning' });
  }

  /** A `[PENDING-…]` placeholder: fine in a dev preview (`--allow-pending`), never in a release. */
  pending(path: string, message: string) {
    if (this.options.allowPending) this.warn(path, message);
    else this.error(path, `${message}; editors must replace it (or import with --allow-pending for a preview)`);
  }

  object(source: unknown, path: string): Json {
    if (source && typeof source === 'object' && !Array.isArray(source)) return source as Json;
    this.error(path, 'is missing or not an object');
    return {};
  }

  array(source: unknown, path: string, [min, max]: readonly [number, number]): Json[] {
    if (!Array.isArray(source)) {
      this.error(path, 'is missing or not a list');
      return [];
    }
    if (source.length < min || source.length > max) {
      this.error(path, `has ${source.length} entries; expected ${min === max ? min : `${min} to ${max}`}`);
    }
    return source as Json[];
  }

  /** Read a required string. Returns it with surrounding space trimmed; records placeholders. */
  text(source: unknown, path: string, { cap, optional = false }: { cap?: number; optional?: boolean } = {}): string {
    if (typeof source === 'number' && Number.isFinite(source)) return String(source);
    if (typeof source !== 'string' || source.trim() === '') {
      if (!optional) this.error(path, 'is missing or empty');
      return '';
    }
    const value = source.trim();
    if (PENDING_TOKEN.test(value)) {
      this.pending(path, `holds a placeholder (${value.match(PENDING_TOKEN)?.join(', ')})`);
    }
    PENDING_TOKEN.lastIndex = 0;
    if (cap !== undefined && !isPendingText(value) && value.length > cap) {
      this.error(path, `is ${value.length} characters (cap ${cap})`);
    }
    return value;
  }

  id(source: unknown, path: string): string {
    const value = this.text(source, path);
    if (value && !/^[a-z][a-zA-Z0-9-]*$/.test(value))
      this.error(path, `id "${value}" must be lowercase letters, digits and hyphens`);
    return value;
  }

  sourceIds(source: unknown, path: string, known: ReadonlySet<string>): { ids: string[]; pending: boolean } {
    if (source === undefined) return { ids: [], pending: false };
    if (!Array.isArray(source) || source.some((id) => typeof id !== 'string')) {
      this.error(path, 'must be a list of source ids');
      return { ids: [], pending: false };
    }
    const ids: string[] = [];
    let pending = false;
    for (const id of source as string[]) {
      if (isPendingId(id)) {
        pending = true;
        this.pending(path, `cites a placeholder source (${id})`);
      } else if (!known.has(id)) {
        this.error(path, `cites unknown source "${id}"`);
      } else if (!ids.includes(id)) {
        ids.push(id);
      }
    }
    return { ids, pending };
  }

  /** Stable keyed map from a list of `{ id }` entries; duplicate ids are an error. */
  keyed<T>(entries: Json[], path: string, read: (entry: Json, entryPath: string, id: string) => T): Map<string, T> {
    const result = new Map<string, T>();
    entries.forEach((entry, index) => {
      const id = this.id(entry.id ?? entry.slug, `${path}[${index}].id`);
      const entryPath = `${path}.${id || index}`;
      if (result.has(id)) this.error(entryPath, `repeats id "${id}"`);
      result.set(id, read(entry, entryPath, id));
    });
    return result;
  }
}

export function isPendingText(value: string): boolean {
  return value.replace(PENDING_TOKEN, '').trim() === '';
}

function readSources(
  reader: PageReader,
  json: Json,
): { sources: GuideSource[]; labels: CatalogPage; known: Set<string> } {
  const sources: GuideSource[] = [];
  const labels: CatalogPage = {};
  const entries = reader.array(json.sources, 'sources', [1, 60]);
  for (const [id, entry] of reader.keyed(entries, 'sources', (entry, path) => ({ entry, path }))) {
    const { entry: source, path } = entry;
    const url = reader.text(source.url, `${path}.url`);
    const checkedAt = reader.text(source.checkedAt, `${path}.checkedAt`);
    if (url && !url.startsWith('https://')) reader.error(`${path}.url`, `must be an https URL (${url})`);
    if (checkedAt && !DATE.test(checkedAt)) reader.error(`${path}.checkedAt`, `must be YYYY-MM-DD (${checkedAt})`);
    labels[id] = reader.text(source.label, `${path}.label`);
    sources.push({ id, url: url as GuideSource['url'], checkedAt: checkedAt as VerificationDate });
  }
  return { sources, labels, known: new Set(sources.map((source) => source.id)) };
}

function readFaq(reader: PageReader, json: Json, known: ReadonlySet<string>) {
  const faq = reader.object(json.faq, 'faq');
  const items = reader.array(faq.items, 'faq.items', COUNTS.faq);
  const registry: GuideItem[] = [];
  const text: CatalogPage = {};
  for (const [id, entry] of reader.keyed(items, 'faq.items', (entry, path) => ({ entry, path }))) {
    const answer = reader.text(entry.entry.a, `${entry.path}.a`);
    if (answer && countSentences(answer) > CAPS.faqSentences) {
      reader.error(`${entry.path}.a`, `has ${countSentences(answer)} sentences (cap ${CAPS.faqSentences})`);
    }
    const cited = reader.sourceIds(entry.entry.sourceIds, `${entry.path}.sourceIds`, known);
    text[id] = { q: reader.text(entry.entry.q, `${entry.path}.q`), a: answer };
    registry.push(item(id, cited.ids, cited.pending || isPendingAny(answer)));
  }
  return { registry, catalog: { heading: reader.text(faq.heading, 'faq.heading'), items: text } };
}

function isPendingAny(...values: string[]): boolean {
  return values.some((value) => /\[PENDING-/.test(value));
}

function item(id: string, sourceIds: string[], pending: boolean): GuideItem {
  return pending ? { id, sourceIds, pending: true } : { id, sourceIds };
}

function readMeta(reader: PageReader, json: Json) {
  const meta = reader.object(json.meta, 'meta');
  const title = reader.text(meta.title, 'meta.title', { cap: CAPS.metaTitle });
  const description = reader.text(meta.description, 'meta.description');
  const [min, max] = CAPS.metaDescription;
  if (description && (description.length < min || description.length > max)) {
    reader.error('meta.description', `is ${description.length} characters (want ${min} to ${max})`);
  }
  return { title, description };
}

function readHero(reader: PageReader, json: Json, known: ReadonlySet<string>) {
  const hero = reader.object(json.hero, 'hero');
  const byline = reader.text(hero.byline, 'hero.byline', { optional: true });
  const cited = reader.sourceIds(hero.sourceIds, 'hero.sourceIds', known);
  return {
    text: {
      pill: reader.text(hero.pill, 'hero.pill'),
      h1: reader.text(hero.h1, 'hero.h1'),
      lead: reader.text(hero.lead, 'hero.lead'),
      ...(byline ? { byline } : {}),
    },
    sourceIds: cited.ids,
  };
}

function headingBlock(reader: PageReader, json: Json, key: string, fields: readonly string[]) {
  const block = reader.object(json[key], key);
  return Object.fromEntries(fields.map((field) => [field, reader.text(block[field], `${key}.${field}`)]));
}

/** Find every catalog string that makes a gated claim, at the granularity a renderer can hide. */
export function findClaims(page: CatalogPage): { path: string; claim: GatedClaimId }[] {
  const claims: { path: string; claim: GatedClaimId }[] = [];
  const seen = new Set<string>();
  const visit = (node: CatalogNode, segments: string[]) => {
    if (typeof node !== 'string') {
      for (const [key, child] of Object.entries(node)) visit(child, [...segments, key]);
      return;
    }
    for (const [claim, pattern] of Object.entries(GATED_CLAIM_PATTERNS) as [GatedClaimId, RegExp][]) {
      if (!pattern.test(node)) continue;
      const grouped = ['rows', 'tiles', 'items', 'paths', 'pickIf', 'keepIf', 'captions'].includes(segments[1] ?? '');
      const path = (grouped ? segments.slice(0, 3) : segments).join('.');
      if (!seen.has(`${claim}:${path}`)) claims.push({ path, claim });
      seen.add(`${claim}:${path}`);
    }
  };
  visit(page, []);
  return claims;
}

/** A gated claim off its allowed pages must sit where the renderer can hide it. */
function checkClaims(reader: PageReader, page: AppGuidePageId, claims: { path: string; claim: GatedClaimId }[]) {
  for (const { path, claim } of claims) {
    if (GATED_CLAIM_PAGES[claim].includes(page) || GATEABLE_PATH.test(path)) continue;
    reader.error(path, `makes the ${claim} claim where it can't be hidden; move it into a row, tile, FAQ or bullet`);
  }
}

export function importComparisonPage(page: ComparisonPageId, json: Json, options: ImportOptions): ImportResult {
  const reader = new PageReader(page, options);
  if (json.page !== page) reader.error('page', `says "${String(json.page)}", expected "${page}"`);
  const { sources, labels, known } = readSources(reader, json);
  const competitorNames: Record<string, string> = COMPETITOR_NAMES[page];
  const competitors = Object.keys(competitorNames);

  // Verdict
  const verdict = reader.object(json.verdict, 'verdict');
  const pickIf = reader.array(verdict.pickIf, 'verdict.pickIf', COUNTS.pickIf).map((value, index) => {
    const path = `verdict.pickIf[${index}]`;
    const text = reader.text(value, path, { cap: CAPS.pickIf });
    if (text && !/^(You|Your)\b/.test(text)) reader.error(path, 'must start with the climber ("You…" or "Your…")');
    return text;
  });
  const keepIf = reader
    .array(verdict.keepIf, 'verdict.keepIf', COUNTS.keepIf)
    .map((value, index) => reader.text(value, `verdict.keepIf[${index}]`));

  // Tiles
  const only = reader.object(json.only, 'only');
  const tileEntries = reader.array(only.tiles, 'only.tiles', COUNTS.tiles);
  const tiles: GuideItem[] = [];
  const tileText: CatalogPage = {};
  for (const [id, { entry, path }] of reader.keyed(tileEntries, 'only.tiles', (entry, path) => ({ entry, path }))) {
    const cited = reader.sourceIds(entry.sourceIds, `${path}.sourceIds`, known);
    const title = reader.text(entry.title, `${path}.title`);
    const body = reader.text(entry.body, `${path}.body`);
    tileText[id] = { title, body };
    tiles.push(item(id, cited.ids, cited.pending || isPendingAny(title, body)));
  }

  // Comparison
  const comparison = reader.object(json.comparison, 'comparison');
  const rowEntries = reader.array(comparison.rows, 'comparison.rows', COUNTS.rows);
  const rows: GuideRow[] = [];
  const rowText: CatalogPage = {};
  for (const [id, { entry, path }] of reader.keyed(rowEntries, 'comparison.rows', (entry, path) => ({ entry, path }))) {
    const writerVerdict = typeof entry.verdict === 'string' ? entry.verdict : '';
    const rowVerdict = VERDICTS[writerVerdict];
    if (!rowVerdict)
      reader.error(`${path}.verdict`, `"${writerVerdict}" is not one of ${Object.keys(VERDICTS).join(', ')}`);
    if (writerVerdict === 'official' && page === 'spray-wall-apps')
      reader.error(`${path}.verdict`, 'use "competitor" on the spray page');
    if (writerVerdict === 'competitor' && page !== 'spray-wall-apps')
      reader.error(`${path}.verdict`, 'use "official" on a board page');

    const cells: Record<string, unknown> =
      page === 'spray-wall-apps'
        ? reader.object(entry.competitors, `${path}.competitors`)
        : { official: entry.official };
    for (const key of Object.keys(cells)) {
      if (!competitors.includes(key))
        reader.error(
          `${path}.competitors.${key}`,
          `is not a known competitor (${competitors.join(', ')}); add its name to COMPETITOR_NAMES`,
        );
    }
    const text: CatalogPage = {
      feature: reader.text(entry.feature, `${path}.feature`),
      boardsesh: reader.text(entry.boardsesh, `${path}.boardsesh`, { cap: CAPS.cell }),
    };
    const pendingCells: string[] = [];
    for (const competitor of competitors) {
      const cellPath = page === 'spray-wall-apps' ? `${path}.competitors.${competitor}` : `${path}.official`;
      const value = reader.text(cells[competitor], cellPath, { cap: CAPS.cell });
      if (isPendingAny(value)) pendingCells.push(competitor);
      // A tie whose competitor cell says the feature is missing contradicts its own chip.
      if (rowVerdict === 'same' && /^no\b|not documented|isn't documented|not found/i.test(value)) {
        reader.warn(cellPath, `reads "${value}" on a tie row; is this a Boardsesh win (with sharedWith)?`);
      }
      text[competitor] = value;
    }
    const cited = reader.sourceIds(entry.sourceIds, `${path}.sourceIds`, known);
    if (rowVerdict === 'only' && cited.ids.length === 0 && !cited.pending) {
      reader.error(`${path}.sourceIds`, 'an "only-boardsesh" row needs at least one source');
    }

    let winners: readonly string[] = [];
    if (rowVerdict === 'competitor') {
      if (
        entry.winners !== undefined &&
        (!Array.isArray(entry.winners) || entry.winners.some((winner) => typeof winner !== 'string'))
      ) {
        reader.error(`${path}.winners`, 'must be a list of competitor ids');
      }
      const declared = Array.isArray(entry.winners)
        ? entry.winners.filter((winner): winner is string => typeof winner === 'string')
        : undefined;
      winners = declared ?? (competitors.length === 1 ? competitors : (COMPETITOR_WINNERS[page]?.[id] ?? []));
      if (winners.length === 0) {
        reader.error(
          `${path}.winners`,
          'a "competitor" row must name which apps win (winners) or have one in COMPETITOR_WINNERS',
        );
      }
      for (const winner of winners) {
        if (!competitors.includes(winner))
          reader.error(`${path}.winners`, `"${winner}" is not a competitor on this page`);
      }
    }
    // A Boardsesh win another app shares ("Boardsesh and Crux do it best").
    let sharedWith: string[] = [];
    if (entry.sharedWith !== undefined) {
      if (!Array.isArray(entry.sharedWith) || entry.sharedWith.some((shared) => typeof shared !== 'string')) {
        reader.error(`${path}.sharedWith`, 'must be a list of competitor ids');
      } else {
        sharedWith = entry.sharedWith as string[];
        if (rowVerdict !== 'boardsesh') reader.error(`${path}.sharedWith`, 'is only allowed on a "boardsesh" row');
        for (const shared of sharedWith) {
          if (!competitors.includes(shared))
            reader.error(`${path}.sharedWith`, `"${shared}" is not a competitor on this page`);
        }
      }
    }
    rowText[id] = text;
    rows.push({
      id,
      verdict: rowVerdict ?? 'same',
      winners,
      ...(sharedWith.length > 0 ? { sharedWith } : {}),
      sourceIds: cited.ids,
      pendingCells,
      ...(cited.pending || pendingCells.length > 0 || isPendingAny(text.boardsesh as string) ? { pending: true } : {}),
    });
  }
  if (!rows.some((row) => row.verdict === 'same' || row.verdict === 'competitor')) {
    reader.error('comparison.rows', 'needs at least one row the other app wins or ties');
  }

  // Other apps (spray)
  let otherApps: GuideItem[] = [];
  let otherAppsText: CatalogPage | undefined;
  if (json.otherApps !== undefined) {
    const block = reader.object(json.otherApps, 'otherApps');
    const entries = reader.array(block.items, 'otherApps.items', [1, 8]);
    const itemsText: CatalogPage = {};
    for (const [id, { entry, path }] of reader.keyed(entries, 'otherApps.items', (entry, path) => ({ entry, path }))) {
      const cited = reader.sourceIds(entry.sourceIds, `${path}.sourceIds`, known);
      const summary = reader.text(entry.summary, `${path}.summary`);
      itemsText[id] = { name: reader.text(entry.name, `${path}.name`), summary };
      otherApps.push(item(id, cited.ids, cited.pending || isPendingAny(summary)));
    }
    otherAppsText = {
      heading: reader.text(block.heading, 'otherApps.heading'),
      lead: reader.text(block.lead, 'otherApps.lead'),
      items: itemsText,
    };
  }

  // Brands (Aurora page): one card per white-label build of the same app.
  const brands: GuideItem[] = [];
  let brandsText: CatalogPage | undefined;
  if (page === 'aurora' || json.brands !== undefined) {
    const block = reader.object(json.brands, 'brands');
    const entries = reader.array(block.items, 'brands.items', [AURORA_BRAND_SLUGS.length, AURORA_BRAND_SLUGS.length]);
    const itemsText: CatalogPage = {};
    for (const [slug, { entry, path }] of reader.keyed(entries, 'brands.items', (entry, path) => ({ entry, path }))) {
      if (!(AURORA_BRAND_SLUGS as readonly string[]).includes(slug)) {
        reader.error(`${path}.slug`, `"${slug}" is not an Aurora brand (${AURORA_BRAND_SLUGS.join(', ')})`);
      }
      const cited = reader.sourceIds(entry.sourceIds, `${path}.sourceIds`, known);
      const fields = ['name', 'summary', 'layouts', 'sizes', 'angles', 'benchmarks', 'officialApp'] as const;
      const text = Object.fromEntries(fields.map((field) => [field, reader.text(entry[field], `${path}.${field}`)]));
      itemsText[slug] = text;
      brands.push(item(slug, cited.ids, cited.pending || isPendingAny(...Object.values(text))));
    }
    for (const slug of AURORA_BRAND_SLUGS) {
      if (!itemsText[slug]) reader.error('brands.items', `is missing ${slug}`);
    }
    brandsText = {
      heading: reader.text(block.heading, 'brands.heading'),
      lead: reader.text(block.lead, 'brands.lead'),
      items: itemsText,
    };
  }

  // Session
  const session = reader.object(json.session, 'session');
  const stepEntries = reader.array(session.steps, 'session.steps', COUNTS.steps);
  const steps: { id: string; screenshot: StepArt }[] = [];
  const allowedShots: readonly string[] = [
    ...NEUTRAL_STEP_SHOTS,
    ...STEP_SHOTS[page],
    ...(page === 'spray-wall-apps' ? [] : ['board']),
  ];
  const stepText: CatalogPage = {};
  for (const [id, { entry, path }] of reader.keyed(stepEntries, 'session.steps', (entry, path) => ({ entry, path }))) {
    const body = reader.text(entry.body, `${path}.body`);
    if (body && countSentences(body) > CAPS.stepSentences)
      reader.error(`${path}.body`, `has ${countSentences(body)} sentences (cap 1)`);
    // null: no capture fits this step, and none is borrowed.
    const screenshot = entry.screenshot === null ? null : typeof entry.screenshot === 'string' ? entry.screenshot : '';
    if (screenshot !== null && ![...GUIDE_SHOTS, 'board'].includes(screenshot)) {
      reader.error(
        `${path}.screenshot`,
        `"${screenshot}" is not one of ${[...GUIDE_SHOTS, 'board'].join(', ')} or null`,
      );
    } else if (screenshot !== null && !allowedShots.includes(screenshot)) {
      reader.error(
        `${path}.screenshot`,
        `"${screenshot}" shows another board or screen; this page may use ${allowedShots.join(', ')} or null`,
      );
    }
    stepText[id] = { title: reader.text(entry.title, `${path}.title`), body };
    steps.push({ id, screenshot: screenshot as StepArt });
  }

  // Logbook
  const logbook = reader.object(json.logbook, 'logbook');
  const pathEntries = reader.array(logbook.paths, 'logbook.paths', COUNTS.paths);
  const paths: { id: string; steps: string[] }[] = [];
  const pathText: CatalogPage = {};
  for (const [id, { entry, path }] of reader.keyed(pathEntries, 'logbook.paths', (entry, path) => ({ entry, path }))) {
    const stepTexts = reader
      .array(entry.steps, `${path}.steps`, COUNTS.pathSteps)
      .map((value, index) => reader.text(value, `${path}.steps[${index}]`));
    const stepIds = stepTexts.map((_, index) => `s${index + 1}`);
    pathText[id] = {
      title: reader.text(entry.title, `${path}.title`),
      subtitle: reader.text(entry.subtitle, `${path}.subtitle`),
      steps: Object.fromEntries(stepIds.map((stepId, index) => [stepId, stepTexts[index]])),
    };
    paths.push({ id, steps: stepIds });
  }

  // "Check your board" was dropped (Boardsesh supports the same boards as each
  // official app, so it said nothing). Older copy files may still carry it.
  if (json.checkBoard !== undefined) reader.warn('checkBoard', 'is no longer rendered; ignored');

  const faq = readFaq(reader, json, known);
  const pickIfKeys = pickIf.map((_, index) => `p${index + 1}`);
  const keepIfKeys = keepIf.map((_, index) => `k${index + 1}`);

  const hero = readHero(reader, json, known);
  const catalog: CatalogPage = {
    meta: readMeta(reader, json),
    hero: hero.text,
    verdict: {
      heading: reader.text(verdict.heading, 'verdict.heading'),
      pickIf: Object.fromEntries(pickIfKeys.map((key, index) => [key, pickIf[index]])),
      keepIf: Object.fromEntries(keepIfKeys.map((key, index) => [key, keepIf[index]])),
      bottomLine: reader.text(verdict.bottomLine, 'verdict.bottomLine'),
    },
    only: {
      heading: reader.text(only.heading, 'only.heading'),
      lead: reader.text(only.lead, 'only.lead'),
      tiles: tileText,
    },
    comparison: {
      heading: reader.text(comparison.heading, 'comparison.heading'),
      lead: reader.text(comparison.lead, 'comparison.lead'),
      rows: rowText,
    },
    ...(otherAppsText ? { otherApps: otherAppsText } : {}),
    ...(brandsText ? { brands: brandsText } : {}),
    session: { heading: reader.text(session.heading, 'session.heading'), steps: stepText },
    logbook: {
      heading: reader.text(logbook.heading, 'logbook.heading'),
      lead: reader.text(logbook.lead, 'logbook.lead'),
      paths: pathText,
    },
    faq: faq.catalog,
    method: headingBlock(reader, json, 'method', ['heading', 'body']),
    cta: headingBlock(reader, json, 'cta', ['heading', 'body']),
    sources: labels,
  };
  warnUncited(reader, sources, [
    ...tiles,
    ...rows,
    ...otherApps,
    ...brands,
    ...faq.registry,
    item('hero', hero.sourceIds, false),
  ]);

  const claims = findClaims(catalog);
  checkClaims(reader, page, claims);
  return {
    catalog,
    registry: {
      id: page,
      hasByline: 'byline' in hero.text,
      heroSourceIds: hero.sourceIds,
      pickIf: pickIfKeys,
      keepIf: keepIfKeys,
      tiles,
      competitors,
      rows,
      otherApps,
      steps,
      paths,
      brands,
      faq: faq.registry,
      sources,
      claims,
    },
    issues: reader.issues,
  };
}

export function importHubPage(json: Json, options: ImportOptions): ImportResult {
  const reader = new PageReader('hub', options);
  if (json.page !== 'hub') reader.error('page', `says "${String(json.page)}", expected "hub"`);
  const { sources, labels, known } = readSources(reader, json);

  const boards = reader.object(json.boards, 'boards');
  const tileEntries = reader.array(boards.tiles, 'boards.tiles', [HUB_BOARD_SLUGS.length, HUB_BOARD_SLUGS.length]);
  const boardOrder: string[] = [];
  const boardText: CatalogPage = {};
  for (const [slug, { entry, path }] of reader.keyed(tileEntries, 'boards.tiles', (entry, path) => ({ entry, path }))) {
    if (!(HUB_BOARD_SLUGS as readonly string[]).includes(slug))
      reader.error(`${path}.slug`, `"${slug}" is not a hub board`);
    const name = reader.text(entry.name, `${path}.name`);
    const linkText = reader.text(entry.linkText, `${path}.linkText`);
    // Search engines read the anchor text; "Compare the apps" eight times says nothing.
    if (name && linkText && !linkText.includes(name.replace(/ Board$/, ''))) {
      reader.error(`${path}.linkText`, `must name the board ("${name}") so the link describes its page`);
    }
    // The tile's link is structure, derived from the slug; the copy may state it, and must agree.
    if (entry.href !== undefined && entry.href !== hubBoardHref(slug as HubBoardSlug)) {
      reader.error(
        `${path}.href`,
        `is ${JSON.stringify(entry.href)}; the ${slug} tile links to ${hubBoardHref(slug as HubBoardSlug)}`,
      );
    }
    boardText[slug] = { name, layouts: reader.text(entry.layouts, `${path}.layouts`), linkText };
    boardOrder.push(slug);
  }
  for (const slug of HUB_BOARD_SLUGS) {
    if (!boardOrder.includes(slug)) reader.error('boards.tiles', `is missing ${slug}`);
  }
  const spray = reader.object(boards.spray, 'boards.spray');
  // Optional: the makers' call to action under the tiles. Its link is a path on www.
  const makers = boards.makers === undefined ? null : reader.object(boards.makers, 'boards.makers');
  let makersHref: `/${string}` | null = null;
  if (makers) {
    const href = reader.text(makers.href, 'boards.makers.href');
    if (/^\/(?!\/)[^\s?]*$/.test(href)) makersHref = href as `/${string}`;
    else if (href) reader.error('boards.makers.href', `is ${JSON.stringify(href)}; use a path on boardsesh.com`);
  }

  const everyBoard = reader.object(json.everyBoard, 'everyBoard');
  const everyBoardLead = reader.text(everyBoard.lead, 'everyBoard.lead', { optional: true });
  const everyEntries = reader.array(everyBoard.tiles, 'everyBoard.tiles', COUNTS.hubTiles);
  const everyTiles: GuideItem[] = [];
  const everyText: CatalogPage = {};
  for (const [id, { entry, path }] of reader.keyed(everyEntries, 'everyBoard.tiles', (entry, path) => ({
    entry,
    path,
  }))) {
    const cited = reader.sourceIds(entry.sourceIds, `${path}.sourceIds`, known);
    const title = reader.text(entry.title, `${path}.title`);
    const body = reader.text(entry.body, `${path}.body`);
    everyText[id] = { title, body };
    everyTiles.push(item(id, cited.ids, cited.pending || isPendingAny(title, body)));
  }

  const devices = reader.object(json.devices, 'devices');
  const captions = reader.object(devices.captions, 'devices.captions');
  const faq = readFaq(reader, json, known);

  const hero = readHero(reader, json, known);
  const catalog: CatalogPage = {
    meta: readMeta(reader, json),
    hero: hero.text,
    boards: {
      heading: reader.text(boards.heading, 'boards.heading'),
      lead: reader.text(boards.lead, 'boards.lead'),
      tiles: boardText,
      spray: {
        title: reader.text(spray.title, 'boards.spray.title'),
        body: reader.text(spray.body, 'boards.spray.body'),
        linkText: reader.text(spray.linkText, 'boards.spray.linkText'),
      },
      ...(makers
        ? {
            makers: {
              title: reader.text(makers.title, 'boards.makers.title'),
              body: reader.text(makers.body, 'boards.makers.body'),
              linkText: reader.text(makers.linkText, 'boards.makers.linkText'),
            },
          }
        : {}),
    },
    everyBoard: {
      heading: reader.text(everyBoard.heading, 'everyBoard.heading'),
      ...(everyBoardLead ? { lead: everyBoardLead } : {}),
      tiles: everyText,
    },
    devices: {
      heading: reader.text(devices.heading, 'devices.heading'),
      lead: reader.text(devices.lead, 'devices.lead'),
      captions: {
        ios: reader.text(captions.ios, 'devices.captions.ios'),
        android: reader.text(captions.android, 'devices.captions.android'),
        browser: reader.text(captions.browser, 'devices.captions.browser'),
      },
    },
    // The rating stat's label is page chrome (common.ratingStat): it carries the live
    // count and storefronts, so a writer's ratingLabel is not imported.
    numbers: headingBlock(reader, json, 'numbers', ['climbersLabel', 'climbsLabel', 'freshness']),
    faq: faq.catalog,
    method: headingBlock(reader, json, 'method', ['heading', 'body']),
    cta: headingBlock(reader, json, 'cta', ['heading', 'body']),
    sources: labels,
  };
  warnUncited(reader, sources, [...everyTiles, ...faq.registry, item('hero', hero.sourceIds, false)]);
  const claims = findClaims(catalog);
  checkClaims(reader, 'hub', claims);
  return {
    catalog,
    registry: {
      id: 'hub',
      hasByline: 'byline' in hero.text,
      heroSourceIds: hero.sourceIds,
      boards: boardOrder as HubPageRegistry['boards'],
      everyBoard: everyTiles,
      everyBoardLead: everyBoardLead !== '',
      makers: makersHref ? { href: makersHref } : null,
      faq: faq.registry,
      sources,
      claims,
    },
    issues: reader.issues,
  };
}

function warnUncited(reader: PageReader, sources: GuideSource[], items: GuideItem[]) {
  const cited = new Set(items.flatMap((entry) => entry.sourceIds));
  const uncited = sources.filter((source) => !cited.has(source.id)).map((source) => source.id);
  // Not an error: an FAQ answer or the lead may lean on a source without a citation slot.
  // They still render, under "Other sources".
  if (uncited.length > 0) reader.warn('sources', `not cited by any row, tile or FAQ: ${uncited.join(', ')}`);
}

export function importPage(page: AppGuidePageId, json: Json, options: ImportOptions): ImportResult {
  return page === 'hub' ? importHubPage(json, options) : importComparisonPage(page, json, options);
}

const QUOTES_PER_PAGE = [1, 3] as const;

/**
 * `quotes.json`: verbatim store reviews, each tagged with the pages it goes on.
 * The text is user-generated, so it lands in the registry as-is (never in the
 * translated catalog) and is checked only for shape.
 */
export function importQuotes(json: Json): { quotes: GuideQuote[]; issues: ImportIssue[] } {
  const reader = new PageReader('quotes', { allowPending: false });
  const entries = reader.array(json.quotes, 'quotes', [1, 40]);
  const quotes: GuideQuote[] = [];
  for (const [id, { entry, path }] of reader.keyed(entries, 'quotes', (entry, path) => ({ entry, path }))) {
    const store = entry.store;
    if (store !== 'appStore' && store !== 'googlePlay')
      reader.error(`${path}.store`, 'must be "appStore" or "googlePlay"');
    const date = reader.text(entry.date, `${path}.date`);
    if (date && !DATE.test(date)) reader.error(`${path}.date`, `must be YYYY-MM-DD (${date})`);
    const country =
      entry.country === null || entry.country === undefined ? null : reader.text(entry.country, `${path}.country`);
    const pages = Array.isArray(entry.pages) ? (entry.pages as unknown[]) : [];
    if (pages.length === 0) reader.error(`${path}.pages`, 'must name at least one page');
    for (const page of pages) {
      if (!(APP_GUIDE_PAGE_IDS as readonly unknown[]).includes(page))
        reader.error(`${path}.pages`, `"${String(page)}" is not a page`);
    }
    // Take the text exactly as given: no trimming of inner whitespace, quotes or apostrophes.
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!text.trim()) reader.error(`${path}.text`, 'is missing or empty');
    quotes.push({
      id,
      text,
      author: reader.text(entry.author, `${path}.author`),
      store: store === 'googlePlay' ? 'googlePlay' : 'appStore',
      country,
      date: date as GuideQuote['date'],
      pages: pages.filter((page): page is AppGuidePageId => (APP_GUIDE_PAGE_IDS as readonly unknown[]).includes(page)),
    });
  }
  for (const page of APP_GUIDE_PAGE_IDS) {
    const count = quotes.filter((quote) => quote.pages.includes(page)).length;
    const [min, max] = QUOTES_PER_PAGE;
    if (count > max || (count > 0 && count < min))
      reader.error('quotes', `${page} has ${count} quotes; expected ${min} to ${max}`);
  }
  return { quotes, issues: reader.issues };
}
