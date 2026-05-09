'use client';

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import MuiSelect, { type SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import MuiSwitch from '@mui/material/Switch';
import MuiTypography from '@mui/material/Typography';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import ArrowUpwardOutlined from '@mui/icons-material/ArrowUpwardOutlined';
import FilterListOutlined from '@mui/icons-material/FilterListOutlined';
import ClearOutlined from '@mui/icons-material/ClearOutlined';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import {
  DEFAULT_ANGLE_RANGE,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  type LogbookFilterState,
  type LogbookSortState,
  type SortField,
  type SortDirection,
} from '@/app/lib/logbook-preferences';
import type { UserBoard } from '@boardsesh/shared-schema';
import CollapsibleSection, {
  type CollapsibleSectionConfig,
} from '@/app/components/collapsible-section/collapsible-section';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import { themeTokens } from '@/app/theme/theme-config';
import BoardFilterStrip from '../board-scroll/board-filter-strip';
import styles from '../search-drawer/accordion-search-form.module.css';
import headerStyles from '../global-header/global-header.module.css';
import footerStyles from '../search-drawer/search-form.module.css';

type LogbookSearchFormProps = {
  searchText: string;
  onSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  minGrade: number | '';
  maxGrade: number | '';
  onMinGradeChange: (value: number | '') => void;
  onMaxGradeChange: (value: number | '') => void;
  sortState: LogbookSortState;
  onSortChange: (sort: LogbookSortState) => void;
  boards: UserBoard[];
  boardsLoading: boolean;
  selectedBoards: UserBoard[];
  onBoardToggle: (board: UserBoard | null) => void;
  filters: LogbookFilterState;
  onFiltersChange: (updater: (prev: LogbookFilterState) => LogbookFilterState) => void;
  actions?: React.ReactNode;
};

function getResultTypeSummary(filters: LogbookFilterState): string[] {
  const parts: string[] = [];

  if (filters.includeSends && filters.includeAttempts) {
    // default — no summary
  } else if (filters.includeSends) {
    parts.push('Sends only');
  } else if (filters.includeAttempts) {
    parts.push('Attempts only');
  }

  if (filters.flashOnly) parts.push('Flash only');
  if (filters.benchmarkOnly) parts.push('Benchmark only');

  return parts;
}

function getDateAngleSummary(filters: LogbookFilterState): string[] {
  const parts: string[] = [];

  if (filters.fromDate || filters.toDate) {
    const from = filters.fromDate || '...';
    const to = filters.toDate || '...';
    parts.push(`${from} \u2013 ${to}`);
  }

  const [min, max] = filters.angleRange;
  const [defaultMin, defaultMax] = DEFAULT_ANGLE_RANGE;
  if (min !== defaultMin || max !== defaultMax) {
    parts.push(`${min}\u00B0\u2013${max}\u00B0`);
  }

  return parts;
}

function countActiveFilters(
  filters: LogbookFilterState,
  minGrade: number | '',
  maxGrade: number | '',
  sortState: LogbookSortState,
): number {
  let count = 0;
  if (minGrade !== '') count++;
  if (maxGrade !== '') count++;
  if (!filters.includeSends || !filters.includeAttempts) count++;
  if (filters.flashOnly) count++;
  if (filters.benchmarkOnly) count++;
  if (filters.fromDate) count++;
  if (filters.toDate) count++;
  if (filters.angleRange[0] !== DEFAULT_ANGLE_RANGE[0] || filters.angleRange[1] !== DEFAULT_ANGLE_RANGE[1]) count++;
  if (sortState.mode === 'custom') count++;
  return count;
}

const LogbookSearchForm: React.FC<LogbookSearchFormProps> = ({
  searchText,
  onSearchChange,
  minGrade,
  maxGrade,
  onMinGradeChange,
  onMaxGradeChange,
  sortState,
  onSortChange,
  boards,
  boardsLoading,
  selectedBoards,
  onBoardToggle,
  filters,
  onFiltersChange,
  actions,
}) => {
  const { t } = useTranslation('profile');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showSort, setShowSort] = useState(false);

  const activeFilterCount = countActiveFilters(filters, minGrade, maxGrade, sortState);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const handleClearAll = useCallback(() => {
    onMinGradeChange('');
    onMaxGradeChange('');
    onSortChange(DEFAULT_SORT);
    onFiltersChange(() => DEFAULT_FILTERS);
  }, [onMinGradeChange, onMaxGradeChange, onSortChange, onFiltersChange]);

  const handleSortFieldChange = (e: SelectChangeEvent) => {
    onSortChange({
      ...sortState,
      mode: 'custom',
      primaryField: e.target.value as SortField,
    });
  };

  const handleSortDirectionChange = (e: SelectChangeEvent) => {
    onSortChange({
      ...sortState,
      mode: 'custom',
      primaryDirection: e.target.value as SortDirection,
    });
  };

  // Factory: creates a fresh config with its own JSX element each call.
  // Avoids sharing the same ReactNode reference across two render locations
  // (outside the drawer and inside the drawer), which can confuse React's
  // reconciliation and cause unexpected unmount/remount cycles.
  const makeBoardsSectionConfig = useCallback(
    (): CollapsibleSectionConfig => ({
      key: 'boards',
      label: 'Boards',
      title: 'Filter by Board',
      defaultSummary: 'All boards',
      getSummary: () => {
        if (selectedBoards.length === 0) return [];
        const names = selectedBoards.map((b) => b.name);
        if (names.length <= 2) return names;
        return [`${names[0]}, ${names[1]}`, `+${names.length - 2} more`];
      },
      content: (
        <BoardFilterStrip
          multiSelect
          boards={boards}
          loading={boardsLoading}
          selectedBoards={selectedBoards}
          onBoardToggle={onBoardToggle}
        />
      ),
    }),
    [boards, boardsLoading, selectedBoards, onBoardToggle],
  );

  // Collapsible sections inside the drawer
  const sections: CollapsibleSectionConfig[] = [
    makeBoardsSectionConfig(),
    {
      key: 'resultType',
      label: 'Result Type',
      title: 'Result Type',
      defaultSummary: 'All',
      getSummary: () => getResultTypeSummary(filters),
      content: (
        <div className={styles.switchGroup}>
          <div className={styles.switchRow}>
            <MuiTypography variant="body2" component="span">
              {t('logbook.search.resultType.includeSends')}
            </MuiTypography>
            <MuiSwitch
              size="small"
              color="primary"
              checked={filters.includeSends}
              disabled={!filters.includeAttempts}
              onChange={(_, checked) => onFiltersChange((prev) => ({ ...prev, includeSends: checked }))}
            />
          </div>
          <div className={styles.switchRow}>
            <MuiTypography variant="body2" component="span">
              {t('logbook.search.resultType.includeAttempts')}
            </MuiTypography>
            <MuiSwitch
              size="small"
              color="primary"
              checked={filters.includeAttempts}
              disabled={!filters.includeSends}
              onChange={(_, checked) => onFiltersChange((prev) => ({ ...prev, includeAttempts: checked }))}
            />
          </div>
          <div className={styles.switchRow}>
            <MuiTypography variant="body2" component="span">
              {t('logbook.search.resultType.flashOnly')}
            </MuiTypography>
            <MuiSwitch
              size="small"
              color="primary"
              checked={filters.flashOnly}
              disabled={!filters.includeSends}
              onChange={(_, checked) => onFiltersChange((prev) => ({ ...prev, flashOnly: checked }))}
            />
          </div>
          <div className={styles.switchRow}>
            <MuiTypography variant="body2" component="span">
              {t('logbook.search.resultType.benchmarkOnly')}
            </MuiTypography>
            <MuiSwitch
              size="small"
              color="primary"
              checked={filters.benchmarkOnly}
              onChange={(_, checked) => onFiltersChange((prev) => ({ ...prev, benchmarkOnly: checked }))}
            />
          </div>
        </div>
      ),
    },
    {
      key: 'dateAngle',
      label: 'Date & Angle',
      title: 'Date & Angle Range',
      defaultSummary: 'Any',
      getSummary: () => getDateAngleSummary(filters),
      content: (
        <div className={styles.panelContent}>
          <div className={styles.inputGroup}>
            <span className={styles.fieldLabel}>{t('logbook.search.dateAngle.dateRange')}</span>
            <div className={styles.gradeRow}>
              <TextField
                type="date"
                label={t('logbook.search.dateAngle.startDate')}
                value={filters.fromDate}
                onChange={(e) => onFiltersChange((prev) => ({ ...prev, fromDate: e.target.value }))}
                size="small"
                fullWidth
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                type="date"
                label={t('logbook.search.dateAngle.endDate')}
                value={filters.toDate}
                onChange={(e) => onFiltersChange((prev) => ({ ...prev, toDate: e.target.value }))}
                size="small"
                fullWidth
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </div>
          </div>

          <div className={styles.inputGroup}>
            <span className={styles.fieldLabel}>
              {t('logbook.search.dateAngle.wallAngleRange', {
                min: filters.angleRange[0],
                max: filters.angleRange[1],
              })}
            </span>
            <Slider
              value={filters.angleRange}
              onChange={(_, value) => {
                const range = value as [number, number];
                onFiltersChange((prev) => ({ ...prev, angleRange: range }));
              }}
              min={0}
              max={70}
              step={5}
              marks={[
                { value: 0, label: '0\u00B0' },
                { value: 70, label: '70\u00B0' },
              ]}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v}\u00B0`}
            />
          </div>
        </div>
      ),
    },
  ];

  // Footer matching SearchResultsFooter from climb list
  const drawerFooter =
    activeFilterCount > 0 ? (
      <div className={footerStyles.searchFooter}>
        <div className={footerStyles.resultCount}>
          <Stack direction="row" spacing={1}>
            <FilterListOutlined sx={{ color: themeTokens.colors.primary }} />
            <MuiTypography variant="body2" component="span" color="text.secondary">
              <span className={footerStyles.resultBadge}>{activeFilterCount}</span>{' '}
              {t('logbook.search.filterCount', { count: activeFilterCount })}
            </MuiTypography>
          </Stack>
        </div>
        <MuiButton
          size="small"
          variant="text"
          startIcon={<ClearOutlined />}
          onClick={handleClearAll}
          sx={{ textTransform: 'none' }}
        >
          {t('logbook.search.clearAll')}
        </MuiButton>
      </div>
    ) : undefined;

  return (
    <>
      {/* Always visible: search input + filter button + board selector */}
      <div className={styles.formWrapper}>
        <div className={styles.primaryContent}>
          <div className={styles.panelContent}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TextField
                value={searchText}
                onChange={onSearchChange}
                placeholder={t('logbook.search.placeholder')}
                fullWidth
                size="small"
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchOutlined color="action" />
                      </InputAdornment>
                    ),
                  },
                }}
              />
              <div className={headerStyles.iconButtonWrapper}>
                <IconButton onClick={openDrawer} aria-label={t('logbook.search.openFilters')} size="small">
                  <FilterListOutlined />
                </IconButton>
                {activeFilterCount > 0 && <span className={headerStyles.filterActiveIndicator} />}
              </div>
              {actions}
            </Box>
          </div>
        </div>
        <CollapsibleSection sections={[makeBoardsSectionConfig()]} />
      </div>

      {/* Filter drawer — matches climb list UnifiedSearchDrawer in climb mode */}
      <SwipeableDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        placement="top"
        height="100%"
        fullHeight
        showDragHandle
        footer={drawerFooter}
        styles={{
          body: {
            padding: `0 ${themeTokens.spacing[4]}px ${themeTokens.spacing[4]}px`,
            backgroundColor: `var(--semantic-background, ${themeTokens.neutral[100]})`,
          },
          footer: { padding: 0, border: 'none' },
          header: { display: 'none' },
          mask: { backgroundColor: themeTokens.semantic.overlayDark },
        }}
      >
        {/* Same structure as AccordionSearchForm: primaryContent + CollapsibleSection */}
        <div className={styles.formWrapper}>
          <div className={styles.primaryContent}>
            <div className={styles.panelContent}>
              <div className={styles.inputGroup}>
                <span className={styles.fieldLabel}>{t('logbook.search.search')}</span>
                <TextField
                  value={searchText}
                  onChange={onSearchChange}
                  placeholder={t('logbook.search.placeholder')}
                  variant="outlined"
                  fullWidth
                  size="small"
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchOutlined color="action" />
                        </InputAdornment>
                      ),
                    },
                  }}
                />
              </div>

              <div className={styles.inputGroup}>
                <span className={styles.fieldLabel}>{t('logbook.search.gradeRange')}</span>
                <div className={styles.gradeRow}>
                  <MuiSelect
                    value={minGrade === '' ? '' : minGrade}
                    onChange={(e: SelectChangeEvent<number | ''>) => {
                      const val = e.target.value;
                      onMinGradeChange(val === '' ? '' : val);
                    }}
                    className={styles.fullWidth}
                    size="small"
                    displayEmpty
                    MenuProps={{ disableScrollLock: true }}
                  >
                    <MenuItem value="">Min</MenuItem>
                    {BOULDER_GRADES.map((grade) => (
                      <MenuItem key={grade.difficulty_id} value={grade.difficulty_id}>
                        {grade.difficulty_name}
                      </MenuItem>
                    ))}
                  </MuiSelect>
                  <MuiSelect
                    value={maxGrade === '' ? '' : maxGrade}
                    onChange={(e: SelectChangeEvent<number | ''>) => {
                      const val = e.target.value;
                      onMaxGradeChange(val === '' ? '' : val);
                    }}
                    className={styles.fullWidth}
                    size="small"
                    displayEmpty
                    MenuProps={{ disableScrollLock: true }}
                  >
                    <MenuItem value="">Max</MenuItem>
                    {BOULDER_GRADES.map((grade) => (
                      <MenuItem key={grade.difficulty_id} value={grade.difficulty_id}>
                        {grade.difficulty_name}
                      </MenuItem>
                    ))}
                  </MuiSelect>
                </div>
              </div>

              <MuiButton
                variant="text"
                size="small"
                startIcon={<ArrowUpwardOutlined />}
                className={styles.sortToggle}
                onClick={() => setShowSort(!showSort)}
              >
                {t('logbook.search.sort')}
              </MuiButton>

              {showSort && (
                <div className={styles.inputGroup}>
                  <div className={styles.sortRow}>
                    <MuiSelect
                      value={sortState.primaryField}
                      onChange={handleSortFieldChange}
                      className={styles.fullWidth}
                      size="small"
                      MenuProps={{ disableScrollLock: true }}
                    >
                      <MenuItem value="date">{t('logbook.search.sortFields.date')}</MenuItem>
                      <MenuItem value="climbName">{t('logbook.search.sortFields.climbName')}</MenuItem>
                      <MenuItem value="loggedGrade">{t('logbook.search.sortFields.loggedGrade')}</MenuItem>
                      <MenuItem value="consensusGrade">{t('logbook.search.sortFields.consensusGrade')}</MenuItem>
                      <MenuItem value="attemptCount">{t('logbook.search.sortFields.attemptCount')}</MenuItem>
                    </MuiSelect>
                    <MuiSelect
                      value={sortState.primaryDirection}
                      onChange={handleSortDirectionChange}
                      className={styles.fullWidth}
                      size="small"
                      MenuProps={{ disableScrollLock: true }}
                    >
                      <MenuItem value="desc">{t('logbook.search.sortDirection.desc')}</MenuItem>
                      <MenuItem value="asc">Asc</MenuItem>
                    </MuiSelect>
                  </div>
                </div>
              )}
            </div>
          </div>
          <CollapsibleSection sections={sections} />
        </div>
      </SwipeableDrawer>
    </>
  );
};

export default LogbookSearchForm;
