'use client';

import React from 'react';
import MuiBox from '@mui/material/Box';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import MuiSwitch from '@mui/material/Switch';
import MuiTooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import MuiButton from '@mui/material/Button';
import type { SxProps, Theme } from '@mui/material/styles';
import { RemoveOutlined, AddOutlined, RefreshOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import { ANGLES, getGradesForBoard } from '@/app/lib/board-data';
import MinAscentsBucketPicker from '@/app/components/climb-quality-filter/min-ascents-bucket-picker';
import { InlineGradePicker } from '@/app/components/grade-picker/inline-grade-picker';
import { InlineStarPicker } from '@/app/components/logbook/tick-controls';
import { setLastUsedGrade } from '@/app/lib/user-preferences-db';
import type { BoardDetails } from '@/app/lib/types';
import { formatMinAscentsFilterCount, getMinRatingPickerValue } from '@/app/lib/climb-quality-filter-options';
import {
  type WorkoutType,
  type WarmUpType,
  type ClimbBias,
  type GeneratorOptions,
  type VolumeOptions,
  type PyramidOptions,
  type LadderOptions,
  type GradeFocusOptions,
  WARM_UP_OPTIONS,
  CLIMB_BIAS_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
} from './types';
import styles from './generator-options-form.module.css';

import {
  KILTER_HOMEWALL_LAYOUT_ID,
  isKilterHomewallTallSizeId,
  isKilterHomewallWideSizeId,
} from '@/app/lib/board-constants';

const qualityBucketRowSx: SxProps<Theme> = {
  alignItems: 'stretch',
  borderBottom: 1,
  borderColor: 'divider',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  py: 2,
};

type GeneratorOptionsFormProps = {
  workoutType: WorkoutType;
  options: GeneratorOptions;
  onChange: (options: GeneratorOptions) => void;
  onReset: () => void;
  boardDetails: BoardDetails;
  targetAngle: number;
  onTargetAngleChange: (angle: number) => void;
};

const GeneratorOptionsForm: React.FC<GeneratorOptionsFormProps> = ({
  workoutType,
  options,
  onChange,
  onReset,
  boardDetails,
  targetAngle,
  onTargetAngleChange,
}) => {
  const { t } = useTranslation('playlists');
  const grades = getGradesForBoard(boardDetails.board_name);
  const angles = ANGLES[boardDetails.board_name] ?? [];

  const warmUpOptions = WARM_UP_OPTIONS.map((value) => ({
    value,
    label: t(`generator.warmUpOptions.${value}`),
  }));
  const climbBiasOptions = CLIMB_BIAS_OPTIONS.map((value) => ({
    value,
    label: t(`generator.climbBiasOptions.${value}`),
  }));

  // Check if we should show the tall climbs filter.
  const isKilterHomewall = boardDetails.board_name === 'kilter' && boardDetails.layout_id === KILTER_HOMEWALL_LAYOUT_ID;
  const showTallClimbsFilter = isKilterHomewall && isKilterHomewallTallSizeId(boardDetails.size_id);
  const showWideClimbsFilter = isKilterHomewall && isKilterHomewallWideSizeId(boardDetails.size_id);

  // Helper to update options
  const updateOption = <K extends keyof GeneratorOptions>(key: K, value: GeneratorOptions[K]) => {
    onChange({ ...options, [key]: value });
  };

  // Render number stepper
  const renderStepper = (
    label: string,
    value: number,
    onUpdate: (newValue: number) => void,
    min: number = 1,
    max: number = 50,
  ) => (
    <div className={styles.formRow}>
      <Typography variant="body2" component="span" className={styles.label}>
        {label}
      </Typography>
      <div className={styles.stepperContainer}>
        <span className={styles.stepperValue}>{value}</span>
        <div className={styles.stepperButtons}>
          <IconButton
            size="small"
            onClick={() => onUpdate(Math.max(min, value - 1))}
            disabled={value <= min}
            className={styles.stepperButton}
          >
            <RemoveOutlined />
          </IconButton>
          <IconButton
            size="small"
            onClick={() => onUpdate(Math.min(max, value + 1))}
            disabled={value >= max}
            className={styles.stepperButton}
          >
            <AddOutlined />
          </IconButton>
        </div>
      </div>
    </div>
  );

  // Render select row
  const renderSelect = <T extends string | number>(
    label: string,
    value: T,
    optionsList: { value: T; label: string }[],
    onUpdate: (newValue: T) => void,
  ) => (
    <div className={styles.formRow}>
      <Typography variant="body2" component="span" className={styles.label}>
        {label}
      </Typography>
      <MuiSelect
        value={value}
        onChange={(e) => onUpdate(e.target.value as T)}
        className={styles.select}
        size="small"
        MenuProps={{ sx: { width: 'auto' } }}
      >
        {optionsList.map((opt) => (
          <MenuItem key={String(opt.value)} value={opt.value}>
            {opt.label}
          </MenuItem>
        ))}
      </MuiSelect>
    </div>
  );

  // Common options for all workout types
  const renderCommonOptions = () => (
    <>
      {/* Target Angle */}
      {angles.length > 0 && (
        <div className={styles.formRow}>
          <Typography variant="body2" component="span" className={styles.label}>
            {t('generator.options.targetAngle')}
          </Typography>
          <MuiSelect
            value={targetAngle}
            onChange={(e) => onTargetAngleChange(Number(e.target.value))}
            className={styles.select}
            size="small"
            MenuProps={{ sx: { width: 'auto' } }}
          >
            {angles.map((angle) => (
              <MenuItem key={angle} value={angle}>
                {`${angle}°`}
              </MenuItem>
            ))}
          </MuiSelect>
        </div>
      )}

      {/* Warm Up */}
      {renderSelect<WarmUpType>(t('generator.options.warmUp'), options.warmUp, warmUpOptions, (v) =>
        updateOption('warmUp', v),
      )}

      {/* Target Grade */}
      <MuiBox sx={qualityBucketRowSx}>
        <Typography variant="body2" component="span" className={styles.label}>
          {t('generator.options.targetGrade')}
        </Typography>
        <InlineGradePicker
          grades={grades}
          currentGradeId={options.targetGrade}
          // With `hideClear` the picker can never emit undefined, so the
          // callback only ever sees a real difficulty_id.
          onSelect={(value) => {
            updateOption('targetGrade', value as number);
            void setLastUsedGrade(value as number);
          }}
          ariaLabel={t('generator.options.targetGrade')}
          hideClear
        />
      </MuiBox>
    </>
  );

  // Quality filters section
  const renderQualityFilters = () => {
    const minRatingPickerValue = getMinRatingPickerValue(options.minRating);

    return (
      <>
        <MuiBox sx={qualityBucketRowSx}>
          <Typography variant="body2" component="span" className={styles.label}>
            {t('generator.options.minAscents')}
          </Typography>
          <MinAscentsBucketPicker
            value={options.minAscents}
            onChange={(minAscents) => updateOption('minAscents', minAscents)}
            ariaLabel={t('generator.options.minAscents')}
            getOptionLabel={(minAscents) =>
              t('generator.options.minAscentsOption', { value: formatMinAscentsFilterCount(minAscents) })
            }
          />
        </MuiBox>

        <MuiBox sx={qualityBucketRowSx}>
          <Typography variant="body2" component="span" className={styles.label}>
            {t('generator.options.minRating')}
          </Typography>
          <InlineStarPicker
            quality={minRatingPickerValue}
            onSelect={(value) => updateOption('minRating', value ?? 0)}
            align="start"
            ariaLabel={t('generator.options.minRating')}
            clearLabel={t('generator.options.any')}
            clearText={t('generator.options.any')}
            getStarLabel={(rating) => t('generator.options.minRatingOption', { count: rating })}
          />
        </MuiBox>

        {/* Climb Bias */}
        {renderSelect<ClimbBias>(t('generator.options.climbBias'), options.climbBias, climbBiasOptions, (v) =>
          updateOption('climbBias', v),
        )}

        {/* Tall Climbs Only */}
        {showTallClimbsFilter && (
          <div className={styles.formRow}>
            <MuiTooltip title={t('generator.options.tallClimbsTooltip')}>
              <Typography variant="body2" component="span" className={styles.label}>
                {t('generator.options.tallClimbsLabel')}
              </Typography>
            </MuiTooltip>
            <MuiSwitch
              checked={options.onlyTallClimbs}
              onChange={(_, checked) => updateOption('onlyTallClimbs', checked)}
            />
          </div>
        )}

        {/* Wide Climbs Only */}
        {showWideClimbsFilter && (
          <div className={styles.formRow}>
            <MuiTooltip title={t('generator.options.wideClimbsTooltip')}>
              <Typography variant="body2" component="span" className={styles.label}>
                {t('generator.options.wideClimbsLabel')}
              </Typography>
            </MuiTooltip>
            <MuiSwitch
              checked={options.onlyWideClimbs}
              onChange={(_, checked) => updateOption('onlyWideClimbs', checked)}
            />
          </div>
        )}
      </>
    );
  };

  // Volume-specific options
  const renderVolumeOptions = () => {
    const volumeOptions = options as VolumeOptions;
    return (
      <>
        {renderCommonOptions()}

        {renderStepper(t('generator.options.mainSetClimbs'), volumeOptions.mainSetClimbs, (v) =>
          onChange({ ...volumeOptions, mainSetClimbs: v }),
        )}

        {renderStepper(
          t('generator.options.mainSetVariability'),
          volumeOptions.mainSetVariability,
          (v) => onChange({ ...volumeOptions, mainSetVariability: v }),
          0,
          5,
        )}

        {renderQualityFilters()}
      </>
    );
  };

  // Pyramid-specific options
  const renderPyramidOptions = () => {
    const pyramidOptions = options as PyramidOptions;
    return (
      <>
        {renderCommonOptions()}

        {renderStepper(
          t('generator.options.numberOfSteps'),
          pyramidOptions.numberOfSteps,
          (v) => onChange({ ...pyramidOptions, numberOfSteps: v }),
          3,
          15,
        )}

        {renderStepper(
          t('generator.options.climbsPerStep'),
          pyramidOptions.climbsPerStep,
          (v) => onChange({ ...pyramidOptions, climbsPerStep: v }),
          1,
          5,
        )}

        {renderQualityFilters()}
      </>
    );
  };

  // Ladder-specific options
  const renderLadderOptions = () => {
    const ladderOptions = options as LadderOptions;
    return (
      <>
        {renderCommonOptions()}

        {renderStepper(
          t('generator.options.numberOfSteps'),
          ladderOptions.numberOfSteps,
          (v) => onChange({ ...ladderOptions, numberOfSteps: v }),
          3,
          15,
        )}

        {renderStepper(
          t('generator.options.climbsPerStep'),
          ladderOptions.climbsPerStep,
          (v) => onChange({ ...ladderOptions, climbsPerStep: v }),
          1,
          5,
        )}

        {renderQualityFilters()}
      </>
    );
  };

  // Grade Focus-specific options
  const renderGradeFocusOptions = () => {
    const focusOptions = options as GradeFocusOptions;
    return (
      <>
        {renderCommonOptions()}

        {renderStepper(
          t('generator.options.numberOfClimbs'),
          focusOptions.numberOfClimbs,
          (v) => onChange({ ...focusOptions, numberOfClimbs: v }),
          1,
          50,
        )}

        {renderQualityFilters()}
      </>
    );
  };

  // Render the appropriate options form
  const renderOptionsForm = () => {
    switch (workoutType) {
      case 'volume':
        return renderVolumeOptions();
      case 'pyramid':
        return renderPyramidOptions();
      case 'ladder':
        return renderLadderOptions();
      case 'gradeFocus':
        return renderGradeFocusOptions();
      default:
        return null;
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.form}>{renderOptionsForm()}</div>

      <div className={styles.resetContainer}>
        <MuiButton variant="text" startIcon={<RefreshOutlined />} onClick={onReset} className={styles.resetButton}>
          {t('generator.reset')}
        </MuiButton>
      </div>
    </div>
  );
};

export default GeneratorOptionsForm;

// Helper to get default options for a workout type
export const getDefaultOptions = (workoutType: WorkoutType, targetGrade: number): GeneratorOptions => {
  switch (workoutType) {
    case 'volume':
      return { ...DEFAULT_VOLUME_OPTIONS, targetGrade };
    case 'pyramid':
      return { ...DEFAULT_PYRAMID_OPTIONS, targetGrade };
    case 'ladder':
      return { ...DEFAULT_LADDER_OPTIONS, targetGrade };
    case 'gradeFocus':
      return { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade };
  }
};
