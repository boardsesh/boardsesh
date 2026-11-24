import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { isClaimVisible, type ComparisonGuide } from '@/app/lib/seo/app-guides';
import type { GuideRow, GuideVerdict } from '@/app/lib/seo/app-guide-model';
import { boardseshMark } from './app-guide-assets';
import { SectionHead, SourcePending, type T } from './guide-parts';
import HoldRing, { type HoldRole } from './hold-ring';
import guideStyles from './app-guide.module.css';
import styles from './comparison-table.module.css';

const VERDICT_RING: Record<GuideVerdict, HoldRole> = {
  boardsesh: 'start',
  only: 'finish',
  same: 'hand',
  competitor: 'foot',
  // Not a win for anyone: a hold that isn't part of the climb.
  unlisted: 'unlit',
};

const listFormat = new Intl.ListFormat(DEFAULT_LOCALE, { style: 'long', type: 'conjunction' });

type ResolvedRow = GuideRow & { claimHidden: boolean };

/**
 * The verdict a row can actually show. An "only in Boardsesh" claim needs a
 * source, and a gated claim (see GATED_CLAIMS) needs its registered evidence;
 * without them the row falls back to "Boardsesh does it better" and drops the
 * competitor half of the claim.
 */
export function resolveRow(guide: ComparisonGuide, row: GuideRow): ResolvedRow {
  const claimHidden = !isClaimVisible(guide, `comparison.rows.${row.id}`);
  const unsourcedOnly = row.verdict === 'only' && row.sourceIds.length === 0;
  return {
    ...row,
    verdict: claimHidden || unsourcedOnly ? 'boardsesh' : row.verdict,
    sharedWith: claimHidden ? [] : row.sharedWith,
    claimHidden,
  };
}

export function verdictLabel(
  t: T,
  guide: ComparisonGuide,
  row: Pick<GuideRow, 'verdict' | 'winners' | 'sharedWith'>,
): string {
  switch (row.verdict) {
    case 'boardsesh':
      return row.sharedWith?.length
        ? t('appGuides:common.comparison.verdicts.boardseshShared', {
            apps: listFormat.format([
              t('appGuides:common.boardsesh'),
              ...row.sharedWith.map((shared) => guide.competitorNames[shared] ?? shared),
            ]),
          })
        : t('appGuides:common.comparison.verdicts.boardsesh');
    case 'only':
      return t('appGuides:common.comparison.verdicts.only');
    case 'same':
      return guide.competitors.length === 1
        ? t('appGuides:common.comparison.verdicts.same')
        : t('appGuides:common.comparison.verdicts.sameAll', { count: guide.competitors.length + 1 });
    case 'unlisted':
      return guide.competitors.length === 1
        ? t('appGuides:common.comparison.verdicts.unlisted', {
            app: guide.competitorNames[guide.competitors[0]] ?? guide.competitors[0],
          })
        : t('appGuides:common.comparison.verdicts.unlistedMany');
    case 'competitor':
      return t('appGuides:common.comparison.verdicts.competitor', {
        app: listFormat.format(row.winners.map((winner) => guide.competitorNames[winner] ?? winner)),
        count: row.winners.length,
      });
  }
}

/**
 * The verdict chip. When the row cites sources it is the link to them: a 44px
 * tall `<a>` around the unchanged chip, pointing at the row's group in the
 * Sources disclosure (SourcesAutoOpen opens it on arrival).
 */
export function VerdictChip({
  t,
  guide,
  row,
  feature,
}: {
  t: T;
  guide: ComparisonGuide;
  row: ResolvedRow;
  feature: string;
}) {
  const label = verdictLabel(t, guide, row);
  const chip = (
    <Box component="span" className={styles.chip}>
      <HoldRing role={VERDICT_RING[row.verdict]} size="xs" />
      {label}
    </Box>
  );
  if (row.sourceIds.length === 0) return chip;
  return (
    <a
      href={`#sources-${row.id}`}
      className={styles.chipLink}
      aria-label={t('appGuides:common.comparison.chipSources', { verdict: label, feature })}
    >
      {chip}
    </a>
  );
}

export default function ComparisonTable({ guide, t }: { guide: ComparisonGuide; t: T }) {
  const headingId = 'comparison-title';
  const mark = boardseshMark();
  const columns = [
    { id: 'boardsesh', name: t('appGuides:common.boardsesh') },
    ...guide.competitors.map((competitor) => ({
      id: competitor,
      name: guide.competitorNames[competitor] ?? competitor,
    })),
  ];
  const wide = columns.length > 3;
  const rows = guide.rows.map((row) => resolveRow(guide, row));
  const usedVerdicts = new Set(rows.map((row) => row.verdict));
  const legendCompetitor =
    guide.competitors.length === 1
      ? (guide.competitorNames[guide.competitors[0]] ?? '')
      : t('appGuides:common.comparison.anotherApp');

  return (
    <Box component="section" id="comparison" className={guideStyles.section} aria-labelledby={headingId}>
      <SectionHead
        id={headingId}
        eyebrow={t('appGuides:common.eyebrows.comparison')}
        ring="hand"
        title={t(`appGuides:pages.${guide.id}.comparison.heading`)}
        lead={t(`appGuides:pages.${guide.id}.comparison.lead`)}
      />
      <Box className={wide ? `${styles.frame} ${styles.frameWide}` : styles.frame}>
        {/* Explicit roles keep table semantics when CSS turns rows into cards on phones. */}
        <Table role="table" aria-labelledby={headingId} className={`${styles.table} ${wide ? styles.wide : ''}`}>
          <TableHead role="rowgroup">
            <TableRow role="row">
              <TableCell
                component="th"
                scope="col"
                role="columnheader"
                className={`${styles.cell} ${styles.head} ${styles.featureHead}`}
              >
                {t('appGuides:common.comparison.feature')}
              </TableCell>
              {columns.map((column) => (
                <TableCell
                  key={column.id}
                  component="th"
                  scope="col"
                  role="columnheader"
                  id={`compare-col-${column.id}`}
                  data-product={column.id}
                  className={`${styles.cell} ${styles.head}`}
                >
                  {column.id === 'boardsesh' ? (
                    <Box component="span" className={styles.product}>
                      <Image src={mark.src} alt="" width={28} height={28} />
                      {column.name}
                    </Box>
                  ) : (
                    column.name
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody role="rowgroup">
            {rows.map((row) => {
              const feature = t(`appGuides:pages.${guide.id}.comparison.rows.${row.id}.feature`);
              return (
                <TableRow key={row.id} role="row" data-verdict={row.verdict}>
                  <TableCell
                    component="th"
                    scope="row"
                    role="rowheader"
                    id={`compare-row-${row.id}`}
                    className={`${styles.cell} ${styles.rowHead}`}
                  >
                    <Box component="span" className={styles.featureName}>
                      {feature}
                    </Box>
                    <Box component="span" className={styles.rowMeta}>
                      <VerdictChip t={t} guide={guide} row={row} feature={feature} />
                      {row.pending ? <SourcePending t={t} /> : null}
                    </Box>
                  </TableCell>
                  {columns.map((column) => {
                    const pendingCell = row.pendingCells.includes(column.id);
                    const hidden = row.claimHidden && column.id !== 'boardsesh';
                    return (
                      <TableCell
                        key={column.id}
                        role="cell"
                        headers={`compare-row-${row.id} compare-col-${column.id}`}
                        data-product={column.id}
                        data-shared-win={row.sharedWith?.includes(column.id) ? '' : undefined}
                        className={styles.cell}
                      >
                        <Box component="span" aria-hidden="true" className={styles.cellLabel}>
                          {column.id === 'boardsesh' ? <Image src={mark.src} alt="" width={18} height={18} /> : null}
                          {column.name}
                        </Box>
                        {hidden
                          ? t('appGuides:common.comparison.claimHidden')
                          : pendingCell
                            ? null
                            : t(`appGuides:pages.${guide.id}.comparison.rows.${row.id}.${column.id}`)}
                        {pendingCell && !hidden ? <SourcePending t={t} /> : null}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
      <Box component="ul" className={styles.legend} aria-label={t('appGuides:common.comparison.legend')}>
        {(['boardsesh', 'only', 'same', 'competitor', 'unlisted'] as const)
          .filter((verdict) => usedVerdicts.has(verdict))
          .map((verdict) => (
            <li key={verdict}>
              <HoldRing role={VERDICT_RING[verdict]} size="xs" />
              {/* The same words as the chips, so the key reads like the table. */}
              {verdict === 'competitor'
                ? t('appGuides:common.comparison.legendItems.competitor', { app: legendCompetitor })
                : verdictLabel(t, guide, { verdict, winners: [] })}
            </li>
          ))}
        <li>{t('appGuides:common.comparison.legendTap')}</li>
      </Box>
    </Box>
  );
}
