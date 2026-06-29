'use client';

import React, { useCallback, useState } from 'react';
import MuiAlert from '@mui/material/Alert';
import MuiTooltip from '@mui/material/Tooltip';
import MuiTypography from '@mui/material/Typography';
import MuiButton from '@mui/material/Button';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import MuiSwitch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import ArrowUpwardOutlined from '@mui/icons-material/ArrowUpwardOutlined';
import { getGradesForBoard } from '@/app/lib/board-data';
import MinAscentsBucketPicker from '@/app/components/climb-quality-filter/min-ascents-bucket-picker';
import { GradeRangePicker, type GradeRangeChangeMeta } from '@/app/components/grade-picker/grade-range-picker';
import { InlineStarPicker } from '@/app/components/logbook/tick-controls';
import { useUISearchParams } from '@/app/components/queue-control/ui-searchparams-provider';
import { useBoardProvider } from '@/app/components/board-provider/board-provider-context';
import { formatMinAscentsFilterCount, getMinRatingPickerValue } from '@/app/lib/climb-quality-filter-options';
import SearchClimbNameInput from './search-climb-name-input';
import SetterNameSelect from './setter-name-select';
import ClimbSearchForm from './climb-search-form';
import type { BoardDetails } from '@/app/lib/types';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { track } from '@/app/lib/analytics';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { describeGradeFilter } from '@boardsesh/climb-filters';
import {
  getQualityPanelSummary,
  getStatusPanelSummary,
  getUserPanelSummary,
  getHoldsPanelSummary,
  getZonePanelSummary,
  createSearchSummaryLabels,
} from './search-summary-utils';
import CollapsibleSection, {
  type CollapsibleSectionConfig,
} from '@/app/components/collapsible-section/collapsible-section';
import { useTranslation } from 'react-i18next';
import styles from './accordion-search-form.module.css';

import {
  KILTER_HOMEWALL_LAYOUT_ID,
  isKilterHomewallTallSizeId,
  isKilterHomewallWideSizeId,
} from '@/app/lib/board-constants';

type AccordionSearchFormProps = {
  boardDetails: BoardDetails;
  defaultActiveKey?: string[];
};

const AccordionSearchForm: React.FC<AccordionSearchFormProps> = ({ boardDetails, defaultActiveKey }) => {
  const { t } = useTranslation('climbs');
  const { uiSearchParams, updateFilters } = useUISearchParams();
  const { isAuthenticated } = useBoardProvider();
  const grades = getGradesForBoard(boardDetails.board_name);
  const { openAuthModal } = useAuthModal();
  const [showSort, setShowSort] = useState(false);
  const summaryLabels = createSearchSummaryLabels(t);

  const isKilterHomewall = boardDetails.board_name === 'kilter' && boardDetails.layout_id === KILTER_HOMEWALL_LAYOUT_ID;
  const showTallClimbsFilter = isKilterHomewall && isKilterHomewallTallSizeId(boardDetails.size_id);
  const showWideClimbsFilter = isKilterHomewall && isKilterHomewallWideSizeId(boardDetails.size_id);
  const minRatingPickerValue = getMinRatingPickerValue(uiSearchParams.minRating);

  let statusValue: 'any' | 'drafts' | 'established' | 'projects' = 'any';
  if (uiSearchParams.onlyDrafts) {
    statusValue = 'drafts';
  } else if (uiSearchParams.projectsOnly) {
    statusValue = 'projects';
  } else if (uiSearchParams.minAscents >= 2) {
    statusValue = 'established';
  }

  const minGradeForPicker = uiSearchParams.minGrade > 0 ? uiSearchParams.minGrade : undefined;
  const maxGradeForPicker = uiSearchParams.maxGrade > 0 ? uiSearchParams.maxGrade : undefined;

  // Ascending difficulty ids — feeds the shared describeGradeFilter so web and
  // mobile classify the `Grade Filter Changed` event identically. Sorted
  // defensively (like mobile) so range_size stays correct even if the source
  // list ever arrives out of order.
  const gradeIds = grades.map((g) => g.difficulty_id).sort((first, second) => first - second);

  // The filter shape uses `0` as the "no grade" sentinel. `updateFilters` strips
  // `undefined` from updates, so we coerce both bounds to concrete numbers
  // (`0` when the picker is at the extreme) before sending.
  const handleGradeRangeChange = (
    { minGradeId, maxGradeId }: { minGradeId: number | undefined; maxGradeId: number | undefined },
    meta?: GradeRangeChangeMeta,
  ) => {
    // `minGradeForPicker` / `maxGradeForPicker` still reflect the PREVIOUS
    // state here — updateFilters() below kicks off the re-render that will
    // refresh them. Capture them now so the analytics event carries the
    // before/after for funnel/rage-pattern analysis later.
    const previous = describeGradeFilter({ minGradeId: minGradeForPicker, maxGradeId: maxGradeForPicker }, gradeIds);
    const next = describeGradeFilter({ minGradeId, maxGradeId }, gradeIds);

    updateFilters({ minGrade: minGradeId ?? 0, maxGrade: maxGradeId ?? 0 });

    track(SHARED_EVENTS.GradeFilterChanged, {
      filter_kind: next.kind,
      min_grade_id: minGradeId ?? null,
      max_grade_id: maxGradeId ?? null,
      range_size: next.size,
      previous_filter_kind: previous.kind,
      previous_min_grade_id: minGradeForPicker ?? null,
      previous_max_grade_id: maxGradeForPicker ?? null,
      // Set only when the picker fired Rule 3 (tap-from-single-grade).
      // true  = range extended within the 3s window.
      // false = window expired, switched single grade instead (no accidental range).
      // null  = Rule 3 didn't fire.
      extended_range_within_window: meta?.extendedRangeWithinWindow ?? null,
      board_name: boardDetails.board_name,
    });
  };

  // Boulder/route switches share one invariant: at least one of the two must
  // be effectively "on", otherwise no climbs would ever match. If a tap would
  // turn both off, widen to "show everything" (both true) — that maps to the
  // same SQL as no filter and avoids silently flipping the other switch on
  // (which a user perceives as two state changes from one tap).
  const handleClimbTypeToggle = useCallback(
    (kind: 'boulder' | 'route', checked: boolean) => {
      const next = {
        boulders: kind === 'boulder' ? checked : uiSearchParams.boulders,
        routes: kind === 'route' ? checked : uiSearchParams.routes,
      };
      if (!next.boulders && !next.routes) {
        next.boulders = true;
        next.routes = true;
      }
      updateFilters(next);
    },
    [uiSearchParams.boulders, uiSearchParams.routes, updateFilters],
  );

  const climbContent = (
    <div className={styles.panelContent}>
      <div className={styles.inputGroup}>
        <span className={styles.fieldLabel}>{t('search.fields.climbName')}</span>
        <SearchClimbNameInput />
      </div>

      <div className={styles.inputGroup}>
        <GradeRangePicker
          grades={grades}
          minGradeId={minGradeForPicker}
          maxGradeId={maxGradeForPicker}
          onChange={handleGradeRangeChange}
          ariaLabel={t('search.fields.gradeRange')}
        />
      </div>

      <div className={styles.switchGroup}>
        <FormControlLabel
          className={styles.switchRow}
          labelPlacement="start"
          control={
            <MuiSwitch
              size="small"
              color="primary"
              checked={uiSearchParams.boulders}
              onChange={(_, checked) => handleClimbTypeToggle('boulder', checked)}
            />
          }
          label={
            <MuiTypography variant="body2" component="span">
              {t('search.fields.boulder')}
            </MuiTypography>
          }
        />
        <FormControlLabel
          className={styles.switchRow}
          labelPlacement="start"
          control={
            <MuiSwitch
              size="small"
              color="primary"
              checked={uiSearchParams.routes}
              onChange={(_, checked) => handleClimbTypeToggle('route', checked)}
            />
          }
          label={
            <MuiTypography variant="body2" component="span">
              {t('search.fields.route')}
            </MuiTypography>
          }
        />
      </div>

      {(showTallClimbsFilter || showWideClimbsFilter) && (
        <div className={styles.switchGroup}>
          {showTallClimbsFilter && (
            <FormControlLabel
              className={styles.switchRow}
              labelPlacement="start"
              control={
                <MuiSwitch
                  size="small"
                  color="primary"
                  checked={uiSearchParams.onlyTallClimbs}
                  onChange={(_, checked) => updateFilters({ onlyTallClimbs: checked })}
                />
              }
              label={
                <MuiTooltip title={t('search.fields.tallClimbsTooltip')}>
                  <MuiTypography variant="body2" component="span">
                    {t('search.fields.tallClimbsOnly')}
                  </MuiTypography>
                </MuiTooltip>
              }
            />
          )}
          {showWideClimbsFilter && (
            <FormControlLabel
              className={styles.switchRow}
              labelPlacement="start"
              control={
                <MuiSwitch
                  size="small"
                  color="primary"
                  checked={uiSearchParams.onlyWideClimbs}
                  onChange={(_, checked) => updateFilters({ onlyWideClimbs: checked })}
                />
              }
              label={
                <MuiTooltip title={t('search.fields.wideClimbsTooltip')}>
                  <MuiTypography variant="body2" component="span">
                    {t('search.fields.wideClimbsOnly')}
                  </MuiTypography>
                </MuiTooltip>
              }
            />
          )}
        </div>
      )}

      <div className={styles.switchGroup}>
        <FormControlLabel
          className={styles.switchRow}
          labelPlacement="start"
          control={
            <MuiSwitch
              size="small"
              color="primary"
              checked={uiSearchParams.onlyWithBetaVideos}
              onChange={(_, checked) => updateFilters({ onlyWithBetaVideos: checked })}
            />
          }
          label={
            <MuiTooltip title={t('search.fields.betaVideosTooltip')}>
              <MuiTypography variant="body2" component="span">
                {t('search.fields.betaVideosOnly')}
              </MuiTypography>
            </MuiTooltip>
          }
        />
      </div>

      <div className={styles.inputGroup}>
        <span className={styles.fieldLabel}>{t('search.fields.setter')}</span>
        <SetterNameSelect />
      </div>

      <MuiButton
        variant="text"
        size="small"
        startIcon={<ArrowUpwardOutlined />}
        className={styles.sortToggle}
        onClick={() => setShowSort(!showSort)}
      >
        {t('search.sortToggle')}
      </MuiButton>

      {showSort && (
        <div className={styles.inputGroup}>
          <div className={styles.sortRow}>
            <MuiSelect
              value={uiSearchParams.sortBy}
              onChange={(e) => updateFilters({ sortBy: e.target.value })}
              className={styles.fullWidth}
              size="small"
              MenuProps={{ disableScrollLock: true }}
            >
              <MenuItem value="ascents">{t('list.sort.ascents')}</MenuItem>
              <MenuItem value="popular">{t('list.sort.popular')}</MenuItem>
              <MenuItem value="difficulty">{t('list.sort.difficulty')}</MenuItem>
              <MenuItem value="name">{t('list.sort.name')}</MenuItem>
              <MenuItem value="quality">{t('list.sort.quality')}</MenuItem>
              <MenuItem value="creation">{t('list.sort.creation')}</MenuItem>
            </MuiSelect>
            <MuiSelect
              value={uiSearchParams.sortOrder}
              onChange={(e) => updateFilters({ sortOrder: e.target.value })}
              className={styles.fullWidth}
              size="small"
              MenuProps={{ disableScrollLock: true }}
            >
              <MenuItem value="desc">{t('list.sort.descending')}</MenuItem>
              <MenuItem value="asc">{t('list.sort.ascending')}</MenuItem>
            </MuiSelect>
          </div>
        </div>
      )}
    </div>
  );

  const sections: CollapsibleSectionConfig[] = [
    {
      key: 'quality',
      label: t('search.panels.quality'),
      title: t('search.panels.quality'),
      defaultSummary: t('search.panels.anyDefault'),
      getSummary: () => getQualityPanelSummary(uiSearchParams, summaryLabels.quality),
      content: (
        <div className={styles.panelContent}>
          <div className={styles.inputGroup}>
            <span className={styles.fieldLabel}>{t('search.fields.minAscents')}</span>
            <MinAscentsBucketPicker
              value={uiSearchParams.minAscents}
              onChange={(minAscents) => updateFilters({ minAscents })}
              ariaLabel={t('search.fields.minAscents')}
              getOptionLabel={(minAscents) =>
                t('search.fields.minAscentsOption', { value: formatMinAscentsFilterCount(minAscents) })
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <span className={styles.fieldLabel}>{t('search.fields.minRating')}</span>
            <InlineStarPicker
              quality={minRatingPickerValue}
              onSelect={(value) => updateFilters({ minRating: value ?? 0 })}
              align="start"
              ariaLabel={t('search.fields.minRating')}
              clearLabel={t('search.fields.any')}
              clearText={t('search.fields.any')}
              getStarLabel={(rating) => t('search.fields.minRatingOption', { count: rating })}
            />
          </div>

          <div className={styles.inputGroup}>
            <span className={styles.fieldLabel}>{t('search.fields.gradeAccuracy')}</span>
            <MuiSelect
              value={uiSearchParams.gradeAccuracy ?? 0}
              onChange={(e) => updateFilters({ gradeAccuracy: Number(e.target.value) || 0 })}
              className={styles.fullWidth}
              size="small"
              MenuProps={{ disableScrollLock: true }}
            >
              <MenuItem value={0}>{t('search.fields.any')}</MenuItem>
              <MenuItem value={0.2}>{t('search.fields.somewhatAccurate')}</MenuItem>
              <MenuItem value={0.1}>{t('search.fields.veryAccurate')}</MenuItem>
              <MenuItem value={0.05}>{t('search.fields.extremelyAccurate')}</MenuItem>
            </MuiSelect>
          </div>

          <div className={styles.switchGroup}>
            <FormControlLabel
              className={styles.switchRow}
              labelPlacement="start"
              control={
                <MuiSwitch
                  size="small"
                  color="primary"
                  checked={uiSearchParams.onlyClassics}
                  onChange={(_, checked) => updateFilters({ onlyClassics: checked })}
                />
              }
              label={
                <MuiTypography variant="body2" component="span">
                  {t('search.fields.classicsOnly')}
                </MuiTypography>
              }
            />
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      label: t('search.panels.status'),
      title: t('search.panels.status'),
      defaultSummary: t('search.panels.anyDefault'),
      getSummary: () => getStatusPanelSummary(uiSearchParams, summaryLabels.status),
      content: (
        <div className={styles.panelContent}>
          <RadioGroup
            className={styles.radioGroup}
            value={statusValue}
            onChange={(e) => {
              const value = e.target.value as 'any' | 'drafts' | 'established' | 'projects';
              if (value === 'drafts') {
                updateFilters({
                  onlyDrafts: true,
                  projectsOnly: false,
                  minAscents: 0,
                  sortBy: 'creation',
                  sortOrder: 'desc',
                });
              } else if (value === 'established') {
                updateFilters({
                  onlyDrafts: false,
                  projectsOnly: false,
                  minAscents: 2,
                });
              } else if (value === 'projects') {
                updateFilters({
                  onlyDrafts: false,
                  projectsOnly: true,
                  minAscents: 0,
                });
              } else {
                updateFilters({
                  onlyDrafts: false,
                  projectsOnly: false,
                  minAscents: 0,
                });
              }
            }}
          >
            <FormControlLabel
              className={styles.radioRow}
              value="any"
              control={<Radio size="small" color="primary" />}
              label={
                <MuiTypography variant="body2" component="span">
                  {t('search.status.any')}
                </MuiTypography>
              }
            />
            <FormControlLabel
              className={styles.radioRow}
              value="established"
              control={<Radio size="small" color="primary" />}
              label={
                <MuiTooltip title={t('search.status.establishedTooltip')}>
                  <MuiTypography variant="body2" component="span">
                    {t('search.status.established')}
                  </MuiTypography>
                </MuiTooltip>
              }
            />
            <FormControlLabel
              className={styles.radioRow}
              value="projects"
              control={<Radio size="small" color="primary" />}
              label={
                <MuiTooltip title={t('search.status.projectsTooltip')}>
                  <MuiTypography variant="body2" component="span">
                    {t('search.status.projects')}
                  </MuiTypography>
                </MuiTooltip>
              }
            />
            <FormControlLabel
              className={styles.radioRow}
              value="drafts"
              disabled={!isAuthenticated}
              control={<Radio size="small" color="primary" />}
              label={
                <MuiTypography variant="body2" component="span">
                  {!isAuthenticated ? t('search.status.myDraftsSignedOut') : t('search.status.myDrafts')}
                </MuiTypography>
              }
            />
          </RadioGroup>
          {!isAuthenticated && (
            <MuiAlert
              severity="info"
              className={styles.progressAlert}
              action={
                <MuiButton
                  size="small"
                  variant="contained"
                  startIcon={<LoginOutlined />}
                  onClick={() =>
                    openAuthModal({
                      title: t('search.status.signInModalTitle'),
                      description: t('search.status.signInModalDescription'),
                    })
                  }
                >
                  {t('search.actions.signIn')}
                </MuiButton>
              }
            >
              {t('search.status.signInToFilterDrafts')}
            </MuiAlert>
          )}
        </div>
      ),
    },
    {
      key: 'user',
      label: t('search.panels.progress'),
      title: t('search.panels.progress'),
      defaultSummary: t('search.panels.allClimbs'),
      getSummary: () => getUserPanelSummary(uiSearchParams, summaryLabels.user),
      content: (
        <div className={styles.panelContent}>
          {!isAuthenticated ? (
            <MuiAlert
              severity="info"
              className={styles.progressAlert}
              action={
                <MuiButton
                  size="small"
                  variant="contained"
                  startIcon={<LoginOutlined />}
                  onClick={() =>
                    openAuthModal({
                      title: t('search.progress.signInModalTitle'),
                      description: t('search.progress.signInModalDescription'),
                    })
                  }
                >
                  {t('search.actions.signIn')}
                </MuiButton>
              }
            >
              <strong>{t('search.progress.signInTitle')}</strong>
              <br />
              {t('search.progress.signInBody')}
            </MuiAlert>
          ) : (
            <div className={styles.switchGroup}>
              <FormControlLabel
                className={styles.switchRow}
                labelPlacement="start"
                control={
                  <MuiSwitch
                    size="small"
                    color="primary"
                    checked={uiSearchParams.hideAttempted}
                    onChange={(_, checked) => updateFilters({ hideAttempted: checked })}
                  />
                }
                label={
                  <MuiTypography variant="body2" component="span">
                    {t('search.progress.hideAttempted')}
                  </MuiTypography>
                }
              />
              <FormControlLabel
                className={styles.switchRow}
                labelPlacement="start"
                control={
                  <MuiSwitch
                    size="small"
                    color="primary"
                    checked={uiSearchParams.hideCompleted}
                    onChange={(_, checked) => updateFilters({ hideCompleted: checked })}
                  />
                }
                label={
                  <MuiTypography variant="body2" component="span">
                    {t('search.progress.hideCompleted')}
                  </MuiTypography>
                }
              />
              <FormControlLabel
                className={styles.switchRow}
                labelPlacement="start"
                control={
                  <MuiSwitch
                    size="small"
                    color="primary"
                    checked={uiSearchParams.showOnlyAttempted}
                    onChange={(_, checked) => updateFilters({ showOnlyAttempted: checked })}
                  />
                }
                label={
                  <MuiTypography variant="body2" component="span">
                    {t('search.progress.onlyAttempted')}
                  </MuiTypography>
                }
              />
              <FormControlLabel
                className={styles.switchRow}
                labelPlacement="start"
                control={
                  <MuiSwitch
                    size="small"
                    color="primary"
                    checked={uiSearchParams.showOnlyCompleted}
                    onChange={(_, checked) => updateFilters({ showOnlyCompleted: checked })}
                  />
                }
                label={
                  <MuiTypography variant="body2" component="span">
                    {t('search.progress.onlyCompleted')}
                  </MuiTypography>
                }
              />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'holdsAndZone',
      label: t('search.panels.holdsAndZone'),
      title: t('search.panels.holdsAndZone'),
      defaultSummary: t('search.panels.anyDefault'),
      getSummary: () => [
        ...getHoldsPanelSummary(uiSearchParams, summaryLabels.holds),
        ...getZonePanelSummary(uiSearchParams, summaryLabels.zone, summaryLabels.zoneModes),
      ],
      lazy: true,
      content: (
        <div className={styles.holdSearchContainer}>
          <ClimbSearchForm boardDetails={boardDetails} />
        </div>
      ),
    },
  ];

  return (
    <div className={styles.formWrapper}>
      <div className={styles.primaryContent}>{climbContent}</div>
      <CollapsibleSection sections={sections} defaultActiveKey={defaultActiveKey?.[0]} compactDesktopGrid />
    </div>
  );
};

export default AccordionSearchForm;
