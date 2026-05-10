'use client';

import React, { useState } from 'react';
import MuiAlert from '@mui/material/Alert';
import MuiTooltip from '@mui/material/Tooltip';
import MuiTypography from '@mui/material/Typography';
import MuiButton from '@mui/material/Button';
import MuiSelect, { type SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import MuiSwitch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import ArrowUpwardOutlined from '@mui/icons-material/ArrowUpwardOutlined';
import { getGradesForBoard } from '@/app/lib/board-data';
import MinAscentsBucketPicker from '@/app/components/climb-quality-filter/min-ascents-bucket-picker';
import { InlineStarPicker } from '@/app/components/logbook/tick-controls';
import { useUISearchParams } from '@/app/components/queue-control/ui-searchparams-provider';
import { useBoardProvider } from '@/app/components/board-provider/board-provider-context';
import {
  formatMinAscentsFilterCount,
  getMinRatingPickerValue,
  getMinUserQualityPickerValue,
} from '@/app/lib/climb-quality-filter-options';
import SearchClimbNameInput from './search-climb-name-input';
import SetterNameSelect from './setter-name-select';
import ClimbSearchForm from './climb-search-form';
import type { BoardDetails } from '@/app/lib/types';
import { buildGradeRangeUpdate } from './grade-range-utils';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import {
  getQualityPanelSummary,
  getStatusPanelSummary,
  getUserPanelSummary,
  getHoldsPanelSummary,
  getZonePanelSummary,
} from './search-summary-utils';
import CollapsibleSection, {
  type CollapsibleSectionConfig,
} from '@/app/components/collapsible-section/collapsible-section';
import { useTranslation } from 'react-i18next';
import styles from './accordion-search-form.module.css';

import { KILTER_HOMEWALL_LAYOUT_ID } from '@/app/lib/board-constants';

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

  const isKilterHomewall = boardDetails.board_name === 'kilter' && boardDetails.layout_id === KILTER_HOMEWALL_LAYOUT_ID;
  const isLargestSize = boardDetails.size_name?.toLowerCase().includes('12');
  const showTallClimbsFilter = isKilterHomewall && isLargestSize;
  const minRatingPickerValue = getMinRatingPickerValue(uiSearchParams.minRating);
  const minUserQualityPickerValue = getMinUserQualityPickerValue(uiSearchParams.minUserQuality);

  let statusValue: 'any' | 'drafts' | 'established' | 'projects' = 'any';
  if (uiSearchParams.onlyDrafts) {
    statusValue = 'drafts';
  } else if (uiSearchParams.projectsOnly) {
    statusValue = 'projects';
  } else if (uiSearchParams.minAscents >= 2) {
    statusValue = 'established';
  }

  const handleGradeChange = (type: 'min' | 'max', value: number | undefined) => {
    updateFilters(buildGradeRangeUpdate(type, value, uiSearchParams.minGrade, uiSearchParams.maxGrade));
  };

  const climbContent = (
    <div className={styles.panelContent}>
      <div className={styles.inputGroup}>
        <span className={styles.fieldLabel}>{t('search.fields.climbName')}</span>
        <SearchClimbNameInput />
      </div>

      <div className={styles.inputGroup}>
        <span className={styles.fieldLabel}>{t('search.fields.gradeRange')}</span>
        <div className={styles.gradeRow}>
          <MuiSelect
            value={uiSearchParams.minGrade || 0}
            onChange={(e: SelectChangeEvent<number>) => handleGradeChange('min', Number(e.target.value) || 0)}
            className={styles.fullWidth}
            size="small"
            displayEmpty
            MenuProps={{ disableScrollLock: true }}
          >
            <MenuItem value={0}>{t('search.fields.minGrade')}</MenuItem>
            {grades.map((grade) => (
              <MenuItem key={grade.difficulty_id} value={grade.difficulty_id}>
                {grade.difficulty_name}
              </MenuItem>
            ))}
          </MuiSelect>
          <MuiSelect
            value={uiSearchParams.maxGrade || 0}
            onChange={(e: SelectChangeEvent<number>) => handleGradeChange('max', Number(e.target.value) || 0)}
            className={styles.fullWidth}
            size="small"
            displayEmpty
            MenuProps={{ disableScrollLock: true }}
          >
            <MenuItem value={0}>{t('search.fields.maxGrade')}</MenuItem>
            {grades.map((grade) => (
              <MenuItem key={grade.difficulty_id} value={grade.difficulty_id}>
                {grade.difficulty_name}
              </MenuItem>
            ))}
          </MuiSelect>
        </div>
      </div>

      {showTallClimbsFilter && (
        <div className={styles.switchGroup}>
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
        </div>
      )}

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
      getSummary: () => getQualityPanelSummary(uiSearchParams),
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
      getSummary: () => getStatusPanelSummary(uiSearchParams),
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
      label: t('search.panels.logbook'),
      title: t('search.panels.logbook'),
      defaultSummary: t('search.panels.anyDefault'),
      getSummary: () => getUserPanelSummary(uiSearchParams),
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
                      title: t('search.logbook.signInModalTitle'),
                      description: t('search.logbook.signInModalDescription'),
                    })
                  }
                >
                  {t('search.actions.signIn')}
                </MuiButton>
              }
            >
              <strong>{t('search.logbook.signInTitle')}</strong>
              <br />
              {t('search.logbook.signInBody')}
            </MuiAlert>
          ) : (
            <>
              <div className={styles.inputGroup}>
                <span className={styles.fieldLabel}>{t('search.fields.minUserQuality')}</span>
                <InlineStarPicker
                  quality={minUserQualityPickerValue}
                  onSelect={(value) => updateFilters({ minUserQuality: value ?? 0 })}
                  align="start"
                  ariaLabel={t('search.fields.minUserQuality')}
                  clearLabel={t('search.fields.any')}
                  clearText={t('search.fields.any')}
                  getStarLabel={(rating) => t('search.fields.minUserQualityOption', { count: rating })}
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
                      checked={uiSearchParams.hideWithoutUserQuality}
                      onChange={(_, checked) => updateFilters({ hideWithoutUserQuality: checked })}
                    />
                  }
                  label={
                    <MuiTypography variant="body2" component="span">
                      {t('search.logbook.hideWithoutUserQuality')}
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
                      checked={uiSearchParams.hideAttempted}
                      onChange={(_, checked) => updateFilters({ hideAttempted: checked })}
                    />
                  }
                  label={
                    <MuiTypography variant="body2" component="span">
                      {t('search.logbook.hideAttempted')}
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
                      {t('search.logbook.hideCompleted')}
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
                      {t('search.logbook.onlyAttempted')}
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
                      {t('search.logbook.onlyCompleted')}
                    </MuiTypography>
                  }
                />
              </div>
            </>
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
        ...getHoldsPanelSummary(uiSearchParams),
        ...getZonePanelSummary(uiSearchParams, t('search.panels.zone')),
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
