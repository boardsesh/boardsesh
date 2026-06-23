'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import MuiLink from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { BarChart } from '@mui/x-charts/BarChart';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@mui/material/styles';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';

export type RetentionRow = {
  cohortWeek: string;
  signups: number;
  d1Count: number;
  d3Count: number;
  d7Count: number;
  d30Count: number;
  activatedCount: number;
  d1Pct: number | null;
  d3Pct: number | null;
  d7Pct: number | null;
  d30Pct: number | null;
  activationPct: number | null;
  d1AnyCount: number;
  d3AnyCount: number;
  d7AnyCount: number;
  d30AnyCount: number;
  activatedAnyCount: number;
  d1AnyPct: number | null;
  d3AnyPct: number | null;
  d7AnyPct: number | null;
  d30AnyPct: number | null;
  activationAnyPct: number | null;
};

type RetentionDashboardProps = {
  rows: RetentionRow[];
};

function formatPct(value: number | null, placeholder: string): string {
  if (value === null) return placeholder;
  return `${value.toFixed(1)}%`;
}

export default function RetentionDashboard({ rows }: RetentionDashboardProps) {
  const { t } = useTranslation('admin');
  const theme = useTheme();
  const placeholder = t('retention.table.notReady');

  const chartRows = [...rows].reverse().filter((row) => row.d7Pct !== null || row.d7AnyPct !== null);
  const chartCategories = chartRows.map((row) => row.cohortWeek);
  const chartTickValues = chartRows.map((row) => row.d7Pct ?? 0);
  const chartAnyValues = chartRows.map((row) => row.d7AnyPct ?? 0);

  return (
    <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
      <Box sx={{ mb: 3 }}>
        <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ color: 'var(--color-primary)' }}>
          {t('retention.back')}
        </MuiLink>
      </Box>

      <Typography variant="h5" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
        {t('retention.heading')}
      </Typography>
      <Typography variant="body2" sx={{ mb: 1, color: themeTokens.neutral[700] }}>
        {t('retention.subheading')}
      </Typography>
      <Typography variant="caption" sx={{ display: 'block', mb: 3, color: themeTokens.neutral[600] }}>
        {t('retention.definitions')}
      </Typography>

      {chartRows.length > 0 && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1, color: themeTokens.neutral[800] }}>
            {t('retention.chart.title')}
          </Typography>
          <Box sx={{ height: 280 }}>
            <BarChart
              series={[
                {
                  data: chartTickValues,
                  label: t('retention.chart.label'),
                  color: theme.palette.primary.main,
                },
                {
                  data: chartAnyValues,
                  label: t('retention.chart.labelAny'),
                  color: theme.palette.success.main,
                },
              ]}
              xAxis={[
                {
                  data: chartCategories,
                  scaleType: 'band' as const,
                  tickLabelStyle: { fontSize: 10, angle: -45, textAnchor: 'end' },
                },
              ]}
              yAxis={[{ min: 0, max: 100 }]}
              height={280}
              margin={{ top: 24, bottom: 56, left: 32, right: 8 }}
              borderRadius={4}
            />
          </Box>
        </Paper>
      )}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell rowSpan={2}>{t('retention.table.cohortWeek')}</TableCell>
              <TableCell align="right" rowSpan={2}>
                {t('retention.table.signups')}
              </TableCell>
              <TableCell align="center" colSpan={5} sx={{ borderLeft: `1px solid ${themeTokens.neutral[300]}` }}>
                {t('retention.table.groupTicks')}
              </TableCell>
              <TableCell align="center" colSpan={5} sx={{ borderLeft: `1px solid ${themeTokens.neutral[300]}` }}>
                {t('retention.table.groupAny')}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell align="right" sx={{ borderLeft: `1px solid ${themeTokens.neutral[300]}` }}>
                {t('retention.table.activated')}
              </TableCell>
              <TableCell align="right">{t('retention.table.d1')}</TableCell>
              <TableCell align="right">{t('retention.table.d3')}</TableCell>
              <TableCell align="right">{t('retention.table.d7')}</TableCell>
              <TableCell align="right">{t('retention.table.d30')}</TableCell>
              <TableCell align="right" sx={{ borderLeft: `1px solid ${themeTokens.neutral[300]}` }}>
                {t('retention.table.activated')}
              </TableCell>
              <TableCell align="right">{t('retention.table.d1')}</TableCell>
              <TableCell align="right">{t('retention.table.d3')}</TableCell>
              <TableCell align="right">{t('retention.table.d7')}</TableCell>
              <TableCell align="right">{t('retention.table.d30')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={12} align="center" sx={{ color: themeTokens.neutral[600] }}>
                  {t('retention.table.empty')}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.cohortWeek}>
                <TableCell>{row.cohortWeek}</TableCell>
                <TableCell align="right">{row.signups}</TableCell>
                <TableCell align="right" sx={{ borderLeft: `1px solid ${themeTokens.neutral[300]}` }}>
                  {formatPct(row.activationPct, placeholder)}
                </TableCell>
                <TableCell align="right">{formatPct(row.d1Pct, placeholder)}</TableCell>
                <TableCell align="right">{formatPct(row.d3Pct, placeholder)}</TableCell>
                <TableCell align="right">{formatPct(row.d7Pct, placeholder)}</TableCell>
                <TableCell align="right">{formatPct(row.d30Pct, placeholder)}</TableCell>
                <TableCell align="right" sx={{ borderLeft: `1px solid ${themeTokens.neutral[300]}` }}>
                  {formatPct(row.activationAnyPct, placeholder)}
                </TableCell>
                <TableCell align="right">{formatPct(row.d1AnyPct, placeholder)}</TableCell>
                <TableCell align="right">{formatPct(row.d3AnyPct, placeholder)}</TableCell>
                <TableCell align="right">{formatPct(row.d7AnyPct, placeholder)}</TableCell>
                <TableCell align="right">{formatPct(row.d30AnyPct, placeholder)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Container>
  );
}
