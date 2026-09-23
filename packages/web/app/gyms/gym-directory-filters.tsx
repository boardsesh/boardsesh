import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { buildAngleOptions, buildLayoutOptions, buildSizeOptions } from '@boardsesh/gym-filters';
import type { TFunction } from 'i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { filterChipSx } from '@/app/components/ui/filter-chip';
import { themeTokens } from '@/app/theme/theme-config';
import {
  FILTERABLE_BOARD_TYPES,
  buildBoardTypeToggleHref,
  buildClearFiltersHref,
  countNarrowFilters,
  type DirectoryFacet,
  type DirectoryQuery,
} from './directory-facets';

/**
 * The directory's board filter: a chip row for board type, then everything
 * narrower behind one native disclosure.
 *
 * Two deliberate halves, and the split is load-bearing rather than cosmetic.
 *
 * **Board type is anchors.** One axis, one click, no submit — and it is the
 * crawl path to the three facet routes, which exist precisely to be found.
 *
 * **Layout, size and angle are form controls inside the surrounding GET form.**
 * Never links. The catalogue holds 51 (board type, layout, size) triples; as
 * anchors that is 204 crawlable URLs once the four locales are counted, every
 * one of them `noindex` and canonicalising to the same base — a crawl budget
 * spent to discover nothing. Crawlers do not submit forms, so checkboxes emit
 * zero new URLs while staying perfectly shareable once a person applies them.
 *
 * `<details>` rather than an MUI Drawer for the same reason the search box is a
 * plain GET form: it opens with no JavaScript, it is keyboard- and
 * screen-reader-correct by construction, the server can open it, and — the part
 * a portal cannot do — **a closed `<details>` still submits its controls**, so
 * collapsing the panel keeps the filter rather than quietly dropping it.
 */
export default function GymDirectoryFilters({
  facet,
  query,
  t,
}: {
  facet: DirectoryFacet;
  query: DirectoryQuery;
  t: TFunction<'gyms'>;
}) {
  const layoutOptions = buildLayoutOptions(query);
  const sizeOptions = buildSizeOptions(query);
  const angleOptions = buildAngleOptions(query);
  const narrowCount = countNarrowFilters(query);

  return (
    <Box component="section" sx={{ mt: 3 }}>
      <Typography
        variant="subtitle2"
        component="h2"
        sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1 }}
      >
        {t('filters.boardHeading')}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {FILTERABLE_BOARD_TYPES.map((boardType) => {
          const selected = query.boardTypes.includes(boardType);
          return (
            <Chip
              key={boardType}
              clickable
              component={LocaleLink}
              href={buildBoardTypeToggleHref(facet, query, boardType)}
              aria-pressed={selected}
              label={boardTypeLabel(boardType)}
              variant="outlined"
              sx={filterChipSx({ selected })}
            />
          );
        })}
      </Box>

      <Box
        component="details"
        // Open when it holds something, so a shared link never hides the filter
        // it is carrying. `defaultOpen` is not a thing on `<details>` in React —
        // `open` here is the initial server-rendered attribute, and the browser
        // owns it from then on with no JavaScript involved.
        open={narrowCount > 0 || undefined}
        sx={{
          mt: 3,
          '& > summary': {
            cursor: 'pointer',
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            fontWeight: themeTokens.typography.fontWeight.semibold,
            color: 'var(--color-primary)',
          },
        }}
      >
        <Box component="summary">
          {narrowCount > 0 ? t('filters.moreLabelActive', { count: narrowCount }) : t('filters.moreLabel')}
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 2 }}>
          <CheckboxChipGroup
            heading={t('filters.layoutHeading')}
            lockedHint={t('filters.layoutLocked')}
            name="layout"
            options={layoutOptions.map((option) => ({
              key: String(option.id),
              label: option.label,
              value: String(option.id),
              selected: (query.layoutIds ?? []).includes(option.id),
            }))}
          />

          <CheckboxChipGroup
            heading={t('filters.sizeHeading')}
            lockedHint={t('filters.sizeLocked')}
            name="size"
            options={sizeOptions.map((option) => ({
              key: option.label,
              label: option.label,
              // ONE value carrying the whole group, comma-joined. A chip has to
              // be one control: an HTML `<label>` binds to exactly one input, so
              // several checkboxes under one label would let a click toggle only
              // the first and submit a third of the size the visitor picked.
              value: option.sizeIds.join(','),
              selected: option.sizeIds.every((sizeId) => (query.sizeIds ?? []).includes(sizeId)),
            }))}
          />

          <CheckboxChipGroup
            heading={t('filters.angleHeading')}
            lockedHint={t('filters.angleLocked')}
            hint={t('filters.angleHint')}
            name="angle"
            options={angleOptions.map((option) => ({
              key: String(option.angle),
              label: t('filters.angleOption', { angle: option.angle }),
              value: String(option.angle),
              selected: (query.angles ?? []).includes(option.angle),
            }))}
          />

          <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 44 }}>
            <input type="checkbox" name="boards" value="2plus" defaultChecked={query.multiBoardTypeOnly === true} />
            <Typography variant="body2">{t('filters.multiBoardLabel')}</Typography>
          </Box>

          <Box>
            <Button type="submit" variant="contained" color="primaryFill" sx={{ minHeight: 44 }}>
              {t('filters.submit')}
            </Button>
          </Box>
        </Box>
      </Box>

      {narrowCount > 0 && (
        <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 1 }}>
          {/* What is applied, in words, so a collapsed disclosure never hides a
              filter that is shrinking the list. Deliberately TEXT and not a row
              of remove-links: a link per active filter is a crawlable URL per
              combination, and the tiers above already let a visitor turn any of
              them off. One "clear" link is the whole escape hatch. */}
          <Typography variant="body2" color="text.secondary">
            {t('filters.activeHeading')}{' '}
            {[
              ...layoutOptions
                .filter((option) => (query.layoutIds ?? []).includes(option.id))
                .map((option) => option.label),
              ...sizeOptions
                .filter((option) => option.sizeIds.every((sizeId) => (query.sizeIds ?? []).includes(sizeId)))
                .map((option) => option.label),
              ...(query.angles ?? []).map((angle) => t('filters.angleOption', { angle })),
              ...(query.multiBoardTypeOnly ? [t('filters.multiBoardLabel')] : []),
            ].join(' · ')}
          </Typography>
          <MuiLink component={LocaleLink} href={buildClearFiltersHref(facet, query)} underline="hover">
            {t('filters.clearAll')}
          </MuiLink>
        </Box>
      )}
    </Box>
  );
}

type ChipOption = { key: string; label: string; value: string; selected: boolean };

/**
 * One tier of the cascade: a heading, then either its chips or the one line
 * that says what to pick first.
 *
 * A tier with no options is not an empty row — it is a tier the catalogue cannot
 * answer yet, either because the board type is not narrowed to one or because
 * the layout is not. Saying so beats rendering a heading over nothing.
 *
 * The chips are `<label>` + checkbox, styled with the same `filterChipSx` recipe
 * the board-type anchors use, so the two rows read as one control even though
 * one navigates and one submits.
 */
function CheckboxChipGroup({
  heading,
  lockedHint,
  hint,
  name,
  options,
}: {
  heading: string;
  lockedHint: string;
  hint?: string;
  name: string;
  options: ChipOption[];
}) {
  return (
    <Box component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
      <Typography
        component="legend"
        variant="subtitle2"
        sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1, p: 0 }}
      >
        {heading}
      </Typography>

      {options.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {lockedHint}
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {options.map((option) => (
              <Box
                key={option.key}
                component="label"
                sx={{
                  ...filterChipSx({ selected: false }),
                  display: 'inline-flex',
                  alignItems: 'center',
                  px: 2,
                  border: '1px solid',
                  cursor: 'pointer',
                  fontSize: themeTokens.typography.fontSize.sm,
                  // The chip follows its own checkbox rather than the state the
                  // server rendered. Without this a click changes an invisible
                  // control and the chip keeps its old look until submit, so
                  // nobody can see which filters they are about to apply.
                  '&:has(input:checked)': filterChipSx({ selected: true }),
                  // Keyboard users get the same ring the mouse gets, since the
                  // control itself is visually hidden.
                  '&:has(input:focus-visible)': {
                    outline: '2px solid var(--color-primary)',
                    outlineOffset: 2,
                  },
                }}
              >
                {/* Exactly one control per chip. A `<label>` binds to its FIRST
                    labelable descendant, so a second checkbox here would never
                    be toggled by a click on the chip — which for a grouped size
                    means submitting one Aurora id out of three. The group rides
                    in the value instead. */}
                <Box
                  component="input"
                  type="checkbox"
                  name={name}
                  value={option.value}
                  defaultChecked={option.selected}
                  sx={{
                    // Visually hidden, not `display: none` — a `none` control is
                    // neither submitted nor focusable, and this one must be both.
                    position: 'absolute',
                    width: 1,
                    height: 1,
                    opacity: 0,
                  }}
                />
                {option.label}
              </Box>
            ))}
          </Box>
          {hint && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {hint}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
