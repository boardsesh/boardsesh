'use client';

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import {
  defaultGymBusyTimesSelection,
  gymBusyTimesModel,
  nextGymBusyHour,
  type GymBusyTimesCell,
  type GymBusyTimesModel,
  type GymBusyTimesSelection,
  type GymBusyTimesView,
} from '@boardsesh/graphql';
import type { GymBusyTimes } from '@boardsesh/shared-schema';
import SelectedCheck from '@/app/components/ui/selected-check';
import { themeTokens } from '@/app/theme/theme-config';

type BusyTimesProps = { report?: GymBusyTimes | null; timeZone?: string; scope: string | null };

const controlStyle = {
  minHeight: 48,
  borderRadius: 1,
  color: 'text.primary',
  '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
  '&[aria-pressed=true]': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
} as const;

const hourGrid = {
  display: 'grid',
  gridTemplateColumns: '5rem repeat(24, minmax(48px, 3.5rem))',
  gap: 0.5,
  minWidth: 'max-content',
} as const;

function Detail({ cell }: { cell: GymBusyTimesCell | undefined }) {
  if (!cell) return null;
  return (
    <Box aria-live="polite">
      <Typography variant="body2">{cell.detail}</Typography>
      <Typography variant="caption" color="text.secondary">
        {cell.source} {cell.limited}
      </Typography>
    </Box>
  );
}

function Legend({ label, hasValues }: { label: string; hasValues: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
      {hasValues && (
        <Box aria-hidden sx={{ display: 'flex', gap: 0.5 }}>
          {[0.125, 0.25, 0.375, 0.5].map((opacity) => (
            <Box
              key={opacity}
              sx={(theme) => ({
                width: 12,
                height: 12,
                borderRadius: 0.5,
                border: 1,
                borderColor: themeTokens.semantic.controlBorder,
                bgcolor: alpha(theme.palette.primary.main, opacity),
              })}
            />
          ))}
        </Box>
      )}
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

function BusyCharts({
  model,
  selection,
  update,
}: {
  model: GymBusyTimesModel;
  selection: GymBusyTimesSelection;
  update: (patch: Partial<GymBusyTimesSelection>) => void;
}) {
  const { t } = useTranslation('boards');
  const grid = useRef<HTMLDivElement>(null);
  const activeHour = selection.hourlyCell ?? 0;
  const selectHour = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    const next = nextGymBusyHour(current, event.key);
    if (next == null) return;
    event.preventDefault();
    grid.current?.querySelector<HTMLButtonElement>(`[data-busy-hour="${next}"]`)?.focus();
  };
  return (
    <>
      <Box component="section" sx={{ display: 'grid', gap: 0.5 }}>
        <Typography component="h4" variant="subtitle1">
          {t('gymBusyTimes.weekdays')}
        </Typography>
        {model.dailyNotice && <Typography variant="body2">{model.dailyNotice}</Typography>}
        <Typography variant="body2">{t('gymBusyTimes.dailyMeasure')}</Typography>
        <Legend label={model.dailyScale} hasValues={!!model.dailySummary} />
        {model.dailyCells.map((cell) => (
          <ButtonBase
            key={cell.key}
            aria-label={cell.accessibilityLabel}
            aria-pressed={selection.weekday === cell.key}
            onClick={() => update({ weekday: cell.key })}
            onFocus={() => update({ weekday: cell.key })}
            sx={{
              ...controlStyle,
              display: 'grid',
              gridTemplateColumns: 'minmax(3rem, max-content) 1fr auto',
              gap: 1,
              px: 1,
              textAlign: 'start',
            }}
          >
            <Typography component="span" variant="body2">
              {cell.axisLabel}
            </Typography>
            <Box aria-hidden sx={{ height: 12, bgcolor: 'action.hover', borderRadius: 1 }}>
              {cell.intensity > 0 && (
                <Box
                  sx={{ height: '100%', width: `${cell.intensity * 100}%`, bgcolor: 'primary.main', borderRadius: 1 }}
                />
              )}
            </Box>
            <Typography component="span" variant="body2">
              {cell.averageText}
            </Typography>
          </ButtonBase>
        ))}
        <Detail cell={model.dailyCells.find((cell) => cell.key === selection.weekday)} />
      </Box>
      <Box component="section" sx={{ display: 'grid', gap: 0.5, minWidth: 0 }}>
        <Typography component="h4" variant="subtitle1">
          {t('gymBusyTimes.hours')}
        </Typography>
        {model.hourlyNotice && <Typography variant="body2">{model.hourlyNotice}</Typography>}
        <Typography variant="body2">{t('gymBusyTimes.hourlyMeasure')}</Typography>
        <Legend label={model.hourlyScale} hasValues={!!model.hourlySummary} />
        <Typography variant="caption" color="text.secondary">
          {t('gymBusyTimes.scrollHours')}
        </Typography>
        <Box sx={{ maxWidth: '100%', minWidth: 0, overflowX: 'auto', pb: 0.5 }}>
          <Box role="grid" aria-label={t('gymBusyTimes.hours')} ref={grid} sx={{ width: 'max-content' }}>
            <Box role="row" sx={hourGrid}>
              <Box aria-hidden />
              {model.hourLabels.map((label, index) => (
                <Typography
                  key={index}
                  component="span"
                  role="columnheader"
                  variant="caption"
                  sx={{ textAlign: 'center' }}
                >
                  {label}
                </Typography>
              ))}
            </Box>
            {model.hourlyRows.map(({ day, hours }) => (
              <Box key={day.key} role="row" sx={{ ...hourGrid, mt: 0.5 }}>
                <Typography
                  component="span"
                  role="rowheader"
                  variant="caption"
                  sx={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 1,
                    bgcolor: 'background.paper',
                    alignContent: 'center',
                    px: 0.5,
                  }}
                >
                  {day.axisLabel}
                </Typography>
                {hours.map((cell) => (
                  <Box key={cell.key} role="gridcell">
                    <ButtonBase
                      data-busy-hour={cell.key}
                      tabIndex={activeHour === cell.key ? 0 : -1}
                      aria-label={cell.accessibilityLabel}
                      aria-pressed={selection.hourlyCell === cell.key}
                      onKeyDown={(event) => selectHour(event, cell.key)}
                      onFocus={() => update({ hourlyCell: cell.key })}
                      onClick={() => update({ hourlyCell: cell.key })}
                      sx={(theme) => ({
                        ...controlStyle,
                        width: '100%',
                        minWidth: 48,
                        border: 1,
                        borderStyle: cell.state === 'missing' || cell.state === 'insufficient' ? 'dashed' : 'solid',
                        borderColor: themeTokens.semantic.controlBorder,
                        bgcolor: cell.intensity
                          ? alpha(theme.palette.primary.main, cell.intensity * 0.5)
                          : 'background.paper',
                        scrollMarginInlineStart: 64,
                      })}
                    >
                      <Typography component="span" variant="caption" aria-hidden>
                        {cell.state === 'positive' ? '•' : cell.averageText}
                      </Typography>
                    </ButtonBase>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        </Box>
        <Detail
          cell={model.hourlyRows.flatMap(({ hours }) => hours).find((cell) => cell.key === selection.hourlyCell)}
        />
      </Box>
    </>
  );
}

function BusyTable({ cells, hourly, title }: { cells: GymBusyTimesCell[]; hourly?: boolean; title: string }) {
  const { t } = useTranslation('boards');
  return (
    <Table
      size="small"
      aria-label={title}
      sx={{ width: '100%', tableLayout: 'fixed', '& th, & td': { overflowWrap: 'anywhere', px: 0.5 } }}
    >
      <TableHead>
        <TableRow>
          <TableCell scope="col">{hourly ? t('gymBusyTimes.hour') : t('gymBusyTimes.weekday')}</TableCell>
          <TableCell scope="col" align="right">
            {t('gymBusyTimes.average')}
          </TableCell>
          <TableCell scope="col" align="right">
            {t('gymBusyTimes.total')}
          </TableCell>
          <TableCell scope="col" align="right">
            {t('gymBusyTimes.eligibleDates')}
          </TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {cells.map((cell) => (
          <TableRow key={cell.key} aria-label={cell.accessibilityLabel}>
            <TableCell component="th" scope="row">
              {hourly ? cell.axisLabel : cell.label}
            </TableCell>
            <TableCell align="right">{cell.averageText}</TableCell>
            <TableCell align="right">{cell.recordedCount}</TableCell>
            <TableCell align="right">{cell.dateCount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BusyNumbers({
  model,
  day,
  onSelectDay,
}: {
  model: GymBusyTimesModel;
  day: number;
  onSelectDay: (day: number) => void;
}) {
  const { t } = useTranslation('boards');
  const selected = model.hourlyRows.find((row) => row.day.key === day);
  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <Typography component="h4" variant="subtitle1">
        {t('gymBusyTimes.weekdays')}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {model.daySource}
      </Typography>
      <BusyTable cells={model.dailyCells} title={t('gymBusyTimes.weekdays')} />
      <Typography component="h4" variant="subtitle1">
        {t('gymBusyTimes.hours')}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {model.hourSource}
      </Typography>
      <TextField
        select
        size="small"
        label={t('gymBusyTimes.hourTableDay')}
        value={day}
        onChange={(event) => onSelectDay(Number(event.target.value))}
      >
        {model.dailyCells.map((cell) => (
          <MenuItem key={cell.key} value={cell.key}>
            {cell.label}
          </MenuItem>
        ))}
      </TextField>
      {selected && <BusyTable cells={selected.hours} hourly title={t('gymBusyTimes.hours')} />}
    </Box>
  );
}

export function GymBusyTimesCard({ report, timeZone, scope }: BusyTimesProps) {
  const { t, i18n } = useTranslation('boards');
  const locale = i18n.language || 'en-US';
  const model = useMemo(
    () => (report && timeZone ? gymBusyTimesModel(report, timeZone, locale, t) : null),
    [report, timeZone, locale, t],
  );
  const [remembered, setRemembered] = useState<GymBusyTimesSelection | null>(null);
  if (scope && remembered?.scope !== scope) setRemembered(defaultGymBusyTimesSelection(scope));
  if (!model || !remembered || remembered.scope !== scope) return null;
  const update = (patch: Partial<GymBusyTimesSelection>) =>
    setRemembered((current) => (current && current.scope === scope ? { ...current, ...patch } : current));
  const hasCalendar = report?.status === 'ready' || report?.status === 'historyUnavailable';
  return (
    <Box component="section" aria-label={t('gymBusyTimes.title')} sx={{ display: 'grid', gap: 1.5, minWidth: 0 }}>
      <Typography component="h3" variant="h6">
        {t('gymBusyTimes.title')}
      </Typography>
      {model.ranges && <Typography variant="body2">{model.ranges}</Typography>}
      <Typography variant="body2" color="text.secondary">
        {model.coverage}
      </Typography>
      {model.status && (
        <Typography variant="body2" role="status">
          {model.status}
        </Typography>
      )}
      {(model.dailySummary || model.hourlySummary) && (
        <Box component="section" aria-label={t('gymBusyTimes.busiestTitle')}>
          <Typography component="h4" variant="subtitle1">
            {t('gymBusyTimes.busiestTitle')}
          </Typography>
          <Typography variant="body2">{[model.dailySummary, model.hourlySummary].filter(Boolean).join(' ')}</Typography>
        </Box>
      )}
      <Typography variant="caption" color="text.secondary">
        {t('gymBusyTimes.population')}
      </Typography>
      {report?.status === 'ready' && (
        <Typography variant="caption" color="text.secondary">
          {model.timedSources}
        </Typography>
      )}
      {model.timingNotice && (
        <Typography variant="caption" color="text.secondary">
          {model.timingNotice}
        </Typography>
      )}
      {model.unboundedNotice && (
        <Typography variant="caption" color="text.secondary">
          {model.unboundedNotice}
        </Typography>
      )}
      {hasCalendar && (
        <>
          <ToggleButtonGroup
            size="small"
            exclusive
            aria-label={t('gymBusyTimes.view')}
            value={remembered.view}
            onChange={(_event, view: GymBusyTimesView | null) => {
              if (view) update({ view });
            }}
          >
            <ToggleButton value="charts" sx={{ gap: 0.5 }}>
              {remembered.view === 'charts' && <SelectedCheck />}
              {t('gymBusyTimes.charts')}
            </ToggleButton>
            <ToggleButton value="numbers" sx={{ gap: 0.5 }}>
              {remembered.view === 'numbers' && <SelectedCheck />}
              {t('gymBusyTimes.numbers')}
            </ToggleButton>
          </ToggleButtonGroup>
          {remembered.view === 'charts' ? (
            <BusyCharts model={model} selection={remembered} update={update} />
          ) : (
            <BusyNumbers model={model} day={remembered.numberDay} onSelectDay={(numberDay) => update({ numberDay })} />
          )}
        </>
      )}
    </Box>
  );
}
