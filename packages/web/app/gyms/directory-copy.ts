import type { TFunction } from 'i18next';
import type { BoardFacet, DirectoryFacet } from './directory-facets';

/**
 * Every piece of per-facet copy, resolved through LITERAL `t()` call sites.
 *
 * The obvious implementation — `t(`directory.${facet}.h1`)` or
 * `t(FACET_TITLE_KEYS[facet])` — is not available: `check:i18n:orphans`
 * hard-fails on `t(variable)`, and a template literal only survives as a glob
 * that no longer proves the four concrete keys exist. A switch costs four lines
 * per string and buys a checker that can see, key by key, exactly which
 * catalog entries this page reads.
 *
 * `t` is typed `TFunction<'gyms'>` so the checker resolves the namespace from
 * the parameter rather than needing a `useTranslation` call in scope.
 */

/** Counts used in the body copy. All of them count GYMS, never boards. */
export type FacetGymCounts = Record<DirectoryFacet, number>;

/** A number rendered for the active locale, e.g. `1,786` / `1.786`. */
export type FormatCount = (value: number) => string;

export function facetMetaTitle(t: TFunction<'gyms'>, facet: DirectoryFacet): string {
  switch (facet) {
    case 'kilter':
      return t('metadata.kilter.title');
    case 'moonboard':
      return t('metadata.moonboard.title');
    case 'tension':
      return t('metadata.tension.title');
    default:
      return t('metadata.all.title');
  }
}

export function facetMetaDescription(t: TFunction<'gyms'>, facet: DirectoryFacet): string {
  switch (facet) {
    case 'kilter':
      return t('metadata.kilter.description');
    case 'moonboard':
      return t('metadata.moonboard.description');
    case 'tension':
      return t('metadata.tension.description');
    default:
      return t('metadata.all.description');
  }
}

export function facetHeading(t: TFunction<'gyms'>, facet: DirectoryFacet): string {
  switch (facet) {
    case 'kilter':
      return t('directory.kilter.h1');
    case 'moonboard':
      return t('directory.moonboard.h1');
    case 'tension':
      return t('directory.tension.h1');
    default:
      return t('directory.all.h1');
  }
}

/**
 * First body paragraph. `count` drives plural selection; `formattedCount` is
 * what actually renders, so the sentence reads `1,786` rather than `1786`.
 */
export function facetLead(
  t: TFunction<'gyms'>,
  facet: DirectoryFacet,
  counts: FacetGymCounts,
  formatCount: FormatCount,
): string {
  const count = counts[facet];
  const options = { count, formattedCount: formatCount(count) };
  switch (facet) {
    case 'kilter':
      return t('directory.kilter.lead', options);
    case 'moonboard':
      return t('directory.moonboard.lead', options);
    case 'tension':
      return t('directory.tension.lead', options);
    default:
      return t('directory.all.lead', options);
  }
}

/** Second body paragraph. On `/gyms` it carries the per-board gym counts. */
export function facetDetail(
  t: TFunction<'gyms'>,
  facet: DirectoryFacet,
  counts: FacetGymCounts,
  formatCount: FormatCount,
): string {
  switch (facet) {
    case 'kilter':
      return t('directory.kilter.detail');
    case 'moonboard':
      return t('directory.moonboard.detail');
    case 'tension':
      return t('directory.tension.detail');
    default:
      return t('directory.all.detail', {
        kilterCount: formatCount(counts.kilter),
        moonboardCount: formatCount(counts.moonboard),
        tensionCount: formatCount(counts.tension),
      });
  }
}

/** Facet chip label, e.g. `Kilter · 1,786`. The number is gyms, not boards. */
export function facetChipLabel(
  t: TFunction<'gyms'>,
  facet: DirectoryFacet,
  counts: FacetGymCounts,
  formatCount: FormatCount,
): string {
  const options = { formattedCount: formatCount(counts[facet]) };
  switch (facet) {
    case 'kilter':
      return t('facets.kilter', options);
    case 'moonboard':
      return t('facets.moonboard', options);
    case 'tension':
      return t('facets.tension', options);
    default:
      return t('facets.all', options);
  }
}

/** Descriptive anchor text for the cross-facet internal links. */
export function facetLinkLabel(t: TFunction<'gyms'>, facet: DirectoryFacet): string {
  switch (facet) {
    case 'kilter':
      return t('links.kilter');
    case 'moonboard':
      return t('links.moonboard');
    case 'tension':
      return t('links.tension');
    default:
      return t('links.all');
  }
}

/** The board facets other than the one currently rendered. */
export function otherBoardFacets(facet: DirectoryFacet, boardFacets: readonly BoardFacet[]): BoardFacet[] {
  return boardFacets.filter((candidate) => candidate !== facet);
}
