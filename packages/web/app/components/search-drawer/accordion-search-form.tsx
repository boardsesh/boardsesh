'use client';

import React, { useState } from 'react';
import MuiAlert from '@mui/material/Alert';
import MuiTooltip from '@mui/material/Tooltip';
import MuiTypography from '@mui/material/Typography';
import MuiButton from '@mui/material/Button';
import MuiSelect, { type SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import MuiSwitch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import ArrowUpwardOutlined from '@mui/icons-material/ArrowUpwardOutlined';
import { TENSION_KILTER_GRADES } from '@/app/lib/board-data';
import { useUISearchParams } from '@/app/components/queue-control/ui-searchparams-provider';
import { useBoardProvider } from '@/app/components/board-provider/board-provider-context';
import SearchClimbNameInput from './search-climb-name-input';
import SetterNameSelect from './setter-name-select';
import ClimbBoardSearchForm from './climb-board-search-form';
import type { BoardDetails } from '@/app/lib/types';
import { buildGradeRangeUpdate } from './grade-range-utils';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import {
  getQualityPanelSummary,
  getStatusPanelSummary,
  getUserPanelSummary,
  getBoardFiltersPanelSummary,
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
  const grades = TENSION_KILTER_GRADES;
  const { openAuthModal } = useAuthModal();
  const [showSort, setShowSort] = useState(false);

  const isKilterHomewall = boardDetails.board_name === 'kilter' && boardDetails.layout_id === KILTER_HOMEWALL_LAYOUT_ID;
  const isLargestSize = boardDetails.size_name?.toLowerCase().includes('12');
  const showTallClimbsFilter = isKilterHomewall && isLargestSize;

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
          <div className={styles.qualityRow}>
            <div className={styles.compactInputGroup}>
              <span className={styles.fieldLabel}>{t('search.fields.minAscents')}</span>
              <TextField
                type="number"
                slotProps={{ htmlInput: { min: 1 } }}
                // 0 is the "no filter" sentinel (DEFAULT_SEARCH_PARAMS.minAscents),
                // so render it as the empty placeholder rather than a literal "0".
                value={uiSearchParams.minAscents || ''}
                onChange={(e) => updateFilters({ minAscents: Number(e.target.value) || 0 })}
                className={styles.fullWidth}
                placeholder={t('search.fields.any')}
                size="small"
              />
            </div>
            <div className={styles.compactInputGroup}>
              <span className={styles.fieldLabel}>{t('search.fields.minRating')}</span>
              <TextField
                type="number"
                slotProps={{ htmlInput: { min: 1.0, max: 3.0, step: 0.1 } }}
                // 0 is the "no filter" sentinel (DEFAULT_SEARCH_PARAMS.minRating),
                // so render it as the empty placeholder rather than a literal "0".
                value={uiSearchParams.minRating || ''}
                onChange={(e) => updateFilters({ minRating: Number(e.target.value) || 0 })}
                className={styles.fullWidth}
                placeholder={t('search.fields.any')}
                size="small"
              />
            </div>
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
      label: 'Progress',
      title: 'Progress',
      defaultSummary: 'All climbs',
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
      key: 'board',
      label: t('search.panels.boardFilters'),
      title: t('search.panels.boardFiltersTitle'),
      defaultSummary: t('search.panels.anyDefault'),
      getSummary: () => getBoardFiltersPanelSummary(uiSearchParams, t('search.panels.zone')),
      lazy: true,
      content: (
        <div className={styles.holdSearchContainer}>
          <ClimbBoardSearchForm boardDetails={boardDetails} />
        </div>
      ),
    },
  ];

  return (
    <div className={styles.formWrapper}>
      <div className={styles.primaryContent}>{climbContent}</div>
      <CollapsibleSection sections={sections} defaultActiveKey={defaultActiveKey?.[0]} />
    </div>
  );
};

export default AccordionSearchForm;
