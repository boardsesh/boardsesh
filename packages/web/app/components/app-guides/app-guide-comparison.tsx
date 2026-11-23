import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { PageSection } from '@/app/components/ui/page-shell';
import type { AppGuidePage } from '@/app/lib/seo/app-guides';
import type { AppGuideCopy } from './app-guide-copy';
import styles from './app-guide.module.css';

export default function AppGuideComparison({ guide, t }: { guide: AppGuidePage; t: AppGuideCopy['t'] }) {
  const title = t('appGuides:common.comparison');
  const columns = [
    { id: 'boardsesh', name: t('appGuides:common.boardsesh') },
    ...guide.competitors.map((competitor) => ({
      id: competitor,
      name: t(`appGuides:pages.${guide.id}.competitors.${competitor}`),
    })),
  ];

  // Explicit roles preserve native table semantics when CSS stacks the cells on phones.
  return (
    <PageSection title={title}>
      <TableContainer className={styles.comparisonFrame}>
        <Table aria-label={title} className={styles.comparison} role="table">
          <TableHead className={styles.comparisonHead} role="rowgroup">
            <TableRow role="row">
              <TableCell scope="col" role="columnheader">
                {t('appGuides:common.comparisonFeature')}
              </TableCell>
              {columns.map((column) => (
                <TableCell key={column.id} id={`app-comparison-${column.id}`} scope="col" role="columnheader">
                  {column.name}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody className={styles.comparisonBody} role="rowgroup">
            {guide.comparisonRows.map((row) => {
              const featureLabel = t(`appGuides:pages.${guide.id}.comparison.${row.id}.label`);
              return (
                <TableRow key={row.id} className={styles.comparisonRow} role="row">
                  <TableCell
                    component="th"
                    id={`app-comparison-feature-${row.id}`}
                    scope="row"
                    role="rowheader"
                    aria-label={featureLabel}
                    className={styles.comparisonFeature}
                  >
                    {featureLabel}
                    <Box component="sup" className={styles.comparisonSources}>
                      {guide.sources.map((source, index) =>
                        row.sourceIds.includes(source.id) ? (
                          <MuiLink
                            key={source.id}
                            href={`#app-guide-source-${source.id}`}
                            aria-label={t(`appGuides:pages.${guide.id}.sources.${source.id}`)}
                          >
                            {index + 1}
                          </MuiLink>
                        ) : null,
                      )}
                    </Box>
                  </TableCell>
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      role="cell"
                      headers={`app-comparison-feature-${row.id} app-comparison-${column.id}`}
                      className={styles.comparisonDetail}
                    >
                      <Box component="span" aria-hidden="true" className={styles.mobileColumn}>
                        {column.name}
                      </Box>
                      {t(`appGuides:pages.${guide.id}.comparison.${row.id}.${column.id}`)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </PageSection>
  );
}
