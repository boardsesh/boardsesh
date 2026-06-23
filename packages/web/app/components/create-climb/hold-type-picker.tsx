'use client';

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Popover from '@mui/material/Popover';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CloseIcon from '@mui/icons-material/Close';
import NotInterestedIcon from '@mui/icons-material/NotInterested';
import CheckIcon from '@mui/icons-material/Check';
import { HOLD_STATE_MAP, type HoldState } from '../board-renderer/types';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardName, HoldFilterEntry, HoldFilterMode, HoldFilterType } from '@/app/lib/types';

type SelectableState = HoldState | 'OFF';

// Hold types the picker can show, in display order. The setter-mode list is
// fixed to climb-setting roles. Search mode adds a wildcard "ANY" swatch on
// the end that matches any hold-state in the climb.
type SetterHoldState = 'STARTING' | 'HAND' | 'FINISH' | 'FOOT';

const SETTER_STATE_ORDER: readonly SetterHoldState[] = ['STARTING', 'HAND', 'FINISH', 'FOOT'];

// Per-board allowlist of selectable states. MoonBoard climbs are STARTING /
// HAND / FINISH only — its HOLD_STATE_MAP entries 45-48 exist to render live
// BLE preview frames from the dev firmware, not to set climbs, so we filter
// them out here so they never appear in the picker.
const PICKER_STATES_BY_BOARD: Record<BoardName, readonly SetterHoldState[]> = {
  kilter: SETTER_STATE_ORDER,
  tension: SETTER_STATE_ORDER,
  decoy: SETTER_STATE_ORDER,
  touchstone: SETTER_STATE_ORDER,
  grasshopper: SETTER_STATE_ORDER,
  soill: SETTER_STATE_ORDER,
  moonboard: ['STARTING', 'HAND', 'FINISH'],
};

type PickerOption = {
  state: SetterHoldState;
  color: string;
};

/**
 * Build the picker's options for a given board. The list of states comes from
 * PICKER_STATES_BY_BOARD (so we don't surface preview-only roles like the
 * MoonBoard FOOT/AUX BLE codes), and the colors come from HOLD_STATE_MAP so
 * each swatch matches the actual LED color the board uses.
 */
export function buildOptions(boardName: BoardName): PickerOption[] {
  const boardMap = HOLD_STATE_MAP[boardName];
  const colorByState = new Map<HoldState, string>();

  for (const entry of Object.values(boardMap)) {
    if (!colorByState.has(entry.name)) {
      colorByState.set(entry.name, entry.displayColor ?? entry.color);
    }
  }

  const options: PickerOption[] = [];
  for (const state of PICKER_STATES_BY_BOARD[boardName]) {
    const color = colorByState.get(state);
    if (!color) continue;
    options.push({ state, color });
  }
  return options;
}

const SWATCH_SIZE = 25;

type CommonProps = {
  anchorEl: Element | null;
  boardName: BoardName;
  onClose: () => void;
};

export type SetterPickerProps = CommonProps & {
  mode?: 'setter';
  currentState: SelectableState;
  startingCount: number;
  finishCount: number;
  onSelect: (state: SelectableState) => void;
};

export type SearchPickerProps = CommonProps & {
  mode: 'search';
  currentEntry: HoldFilterEntry;
  // Cycle a single type's mode for the active hold. `nextMode === undefined`
  // means the type was unset (i.e. removed from the entry).
  onFilterChange: (type: HoldFilterType, nextMode: HoldFilterMode | undefined) => void;
  onClearAll: () => void;
};

type HoldTypePickerProps = SetterPickerProps | SearchPickerProps;

export default function HoldTypePicker(props: HoldTypePickerProps) {
  const { t } = useTranslation('climbs');
  const { anchorEl, boardName, onClose } = props;
  const setterOptions = useMemo(() => buildOptions(boardName), [boardName]);
  // Global apply-mode for search-mode swatch taps. Persisted across hold taps
  // (the picker component itself stays mounted between popover opens) so the
  // user can flip to "exclude" once and keep stacking exclude filters.
  const [searchApplyMode, setSearchApplyMode] = useState<HoldFilterMode>('include');

  const localizedLabel = (state: SetterHoldState | 'ANY') =>
    t(`holdTypePicker.states.${state.toLowerCase() as Lowercase<SetterHoldState | 'ANY'>}`);

  const renderToolbar = () => {
    if (props.mode === 'search') {
      return renderSearchToolbar(props, setterOptions, localizedLabel, t, searchApplyMode, setSearchApplyMode);
    }
    return renderSetterToolbar(props, setterOptions, localizedLabel, t);
  };

  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      // Search mode keeps the picker open so the user can stack multiple
      // filters on one hold without re-tapping. Setter mode closes on outside
      // click only (selections close the popover via parent's onSelect).
      disableAutoFocus={props.mode === 'search'}
      disableEnforceFocus={props.mode === 'search'}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      slotProps={{
        paper: {
          sx: {
            borderRadius: `${themeTokens.borderRadius.lg}px`,
            boxShadow: themeTokens.shadows.lg,
            overflow: 'visible',
          },
        },
        // Show a visible backdrop while the picker is open so the rest of
        // the board dims and it's obvious which hold the popover is editing.
        // The backdrop already swallows outside clicks (Popover routes them
        // to onClose) — we just make it visible in search mode.
        ...(props.mode === 'search' && {
          root: {
            slotProps: {
              backdrop: {
                invisible: false,
                sx: { backgroundColor: 'rgba(0, 0, 0, 0.45)' },
              },
            },
          },
        }),
      }}
    >
      <Box
        role="toolbar"
        aria-label={t('holdTypePicker.toolbarAriaLabel')}
        sx={{
          display: 'flex',
          flexDirection: props.mode === 'search' ? 'column' : 'row',
          alignItems: props.mode === 'search' ? 'stretch' : 'flex-start',
          gap: `${themeTokens.spacing[1]}px`,
          padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
        }}
      >
        {renderToolbar()}
      </Box>
    </Popover>
  );
}

function renderSetterToolbar(
  props: SetterPickerProps,
  options: PickerOption[],
  localizedLabel: (state: SetterHoldState | 'ANY') => string,
  t: (key: string) => string,
) {
  const { currentState, startingCount, finishCount, onSelect } = props;
  return (
    <>
      {options.map((option) => {
        const isActive = option.state === currentState;
        const isDisabled =
          (option.state === 'STARTING' && startingCount >= 2 && !isActive) ||
          (option.state === 'FINISH' && finishCount >= 2 && !isActive);
        return (
          <Swatch
            key={option.state}
            label={localizedLabel(option.state)}
            color={option.color}
            isActive={isActive}
            isDisabled={isDisabled}
            onClick={() => {
              if (isDisabled) return;
              onSelect(option.state);
            }}
          />
        );
      })}
      <Swatch
        key="clear"
        label={t('holdTypePicker.clear')}
        isClear
        isActive={currentState === 'OFF'}
        isDisabled={currentState === 'OFF'}
        onClick={() => {
          if (currentState !== 'OFF') onSelect('OFF');
        }}
      />
    </>
  );
}

function renderSearchToolbar(
  props: SearchPickerProps,
  setterOptions: PickerOption[],
  localizedLabel: (state: SetterHoldState | 'ANY') => string,
  t: (key: string) => string,
  applyMode: HoldFilterMode,
  setApplyMode: (mode: HoldFilterMode) => void,
) {
  const { currentEntry, onFilterChange, onClearAll } = props;

  // Tap behaviour, given the global apply-mode toggle at the top:
  //   - swatch unset → set to apply-mode
  //   - swatch already at apply-mode → unset
  //   - swatch at the other mode → flip to apply-mode
  // This makes "switch a hold from include to exclude" a two-step gesture
  // (toggle Exclude, tap the swatch) rather than a multi-tap cycle.
  const handleSwatch = (type: HoldFilterType) => {
    const current = currentEntry[type];
    if (current === applyMode) {
      onFilterChange(type, undefined);
    } else {
      onFilterChange(type, applyMode);
    }
  };

  const swatchForType = (type: SetterHoldState | 'ANY', color: string) => {
    const mode = currentEntry[type];
    const ariaSuffix =
      mode === 'include'
        ? t('holdTypePicker.includeAriaSuffix')
        : mode === 'exclude'
          ? t('holdTypePicker.excludeAriaSuffix')
          : '';
    return (
      <Swatch
        key={type}
        label={localizedLabel(type)}
        color={color}
        isActive={mode !== undefined}
        excluded={mode === 'exclude'}
        ariaLabel={ariaSuffix ? `${localizedLabel(type)}, ${ariaSuffix}` : localizedLabel(type)}
        onClick={() => handleSwatch(type)}
      />
    );
  };

  const isEmpty = Object.keys(currentEntry).length === 0;

  return (
    <>
      <ToggleButtonGroup
        value={applyMode}
        exclusive
        size="small"
        onChange={(_, value) => {
          if (value === 'include' || value === 'exclude') setApplyMode(value);
        }}
        aria-label={t('holdTypePicker.applyModeAriaLabel')}
        sx={{
          alignSelf: 'center',
          '& .MuiToggleButton-root': {
            textTransform: 'none',
            fontSize: 12,
            paddingY: '2px',
            paddingX: `${themeTokens.spacing[2]}px`,
            lineHeight: 1.2,
          },
          '& .MuiToggleButton-root.Mui-selected': {
            color: 'common.white',
          },
          '& .MuiToggleButton-root[value="include"].Mui-selected': {
            backgroundColor: 'var(--color-success)',
            '&:hover': { backgroundColor: 'var(--color-success-hover)' },
          },
          '& .MuiToggleButton-root[value="exclude"].Mui-selected': {
            backgroundColor: 'var(--color-error)',
            '&:hover': { backgroundColor: 'var(--color-error)' },
          },
        }}
      >
        <ToggleButton value="include" aria-label={t('holdTypePicker.includeAriaSuffix')}>
          <CheckIcon sx={{ fontSize: 14, marginRight: '4px' }} />
          {t('search.holds.include')}
        </ToggleButton>
        <ToggleButton value="exclude" aria-label={t('holdTypePicker.excludeAriaSuffix')}>
          <NotInterestedIcon sx={{ fontSize: 14, marginRight: '4px' }} />
          {t('search.holds.exclude')}
        </ToggleButton>
      </ToggleButtonGroup>
      <Box sx={{ display: 'flex', gap: `${themeTokens.spacing[1]}px`, alignItems: 'flex-start' }}>
        {setterOptions.map((option) => swatchForType(option.state, option.color))}
        {/* ANY swatch is a plain white circle to match the on-board overlay
            (the SearchHoldFilterOverlay uses #FFFFFF for ANY because no
            HOLD_STATE_MAP entry has name='ANY'). */}
        {swatchForType('ANY', '#FFFFFF')}
        <Swatch
          key="clear"
          label={t('holdTypePicker.clear')}
          isClear
          isActive={isEmpty}
          isDisabled={isEmpty}
          onClick={() => {
            if (!isEmpty) onClearAll();
          }}
        />
      </Box>
      <Typography
        variant="caption"
        sx={{
          fontSize: 11,
          color: 'text.secondary',
          textAlign: 'center',
          marginTop: `${themeTokens.spacing[1]}px`,
          paddingX: `${themeTokens.spacing[1]}px`,
          maxWidth: 240,
          alignSelf: 'center',
          lineHeight: 1.3,
        }}
      >
        {t('holdTypePicker.searchHelp')}
      </Typography>
    </>
  );
}

type SwatchProps = {
  label: string;
  // Single solid color. Used for setter mode and for every search-mode swatch
  // (the ANY swatch passes plain white).
  color?: string;
  isActive: boolean;
  isDisabled?: boolean;
  isClear?: boolean;
  excluded?: boolean;
  ariaLabel?: string;
  onClick: () => void;
};

function Swatch({ label, color, isActive, isDisabled = false, isClear, excluded, ariaLabel, onClick }: SwatchProps) {
  const ring = isClear ? themeTokens.neutral[400] : (color ?? themeTokens.neutral[400]);

  // Choose icon color: clear uses ring color; an active solid swatch uses
  // white-on-fill for contrast; excluded shows the X icon in white over the
  // dim fill.
  let swatchIconColor = 'transparent';
  if (isClear) {
    swatchIconColor = ring;
  } else if (excluded) {
    swatchIconColor = '#FFFFFF';
  } else if (isActive) {
    swatchIconColor = '#FFFFFF';
  }

  // Background fill. Excluded gets a dim fill regardless of color so the
  // exclude state is unmistakable. Active include gets the type's ring color
  // as a solid fill.
  let backgroundColor: string | undefined;
  if (excluded) {
    backgroundColor = 'rgba(0, 0, 0, 0.55)';
  } else if (isActive && !isClear) {
    backgroundColor = ring;
  } else {
    backgroundColor = 'transparent';
  }

  return (
    <ButtonBase
      onClick={onClick}
      disabled={isDisabled}
      aria-label={ariaLabel ?? label}
      aria-pressed={isActive}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: `${themeTokens.spacing[1]}px`,
        padding: `${themeTokens.spacing[1]}px`,
        borderRadius: `${themeTokens.borderRadius.md}px`,
        opacity: isDisabled ? 0.35 : 1,
        transition: themeTokens.transitions.fast,
        '&:hover': isDisabled ? undefined : { backgroundColor: 'var(--semantic-selected-light)' },
      }}
    >
      <Box
        sx={{
          width: SWATCH_SIZE,
          height: SWATCH_SIZE,
          borderRadius: '50%',
          border: `2px solid ${ring}`,
          backgroundColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: swatchIconColor,
          boxSizing: 'border-box',
          position: 'relative',
        }}
      >
        {isClear && <CloseIcon sx={{ fontSize: 13 }} />}
        {excluded && <NotInterestedIcon sx={{ fontSize: 14, position: 'relative', zIndex: 1 }} />}
      </Box>
      <Typography
        variant="caption"
        sx={{
          fontSize: 11,
          fontWeight: themeTokens.typography.fontWeight.medium,
          lineHeight: 1,
          color: 'text.primary',
        }}
      >
        {label}
      </Typography>
    </ButtonBase>
  );
}
