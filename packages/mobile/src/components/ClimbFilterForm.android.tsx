import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Keyboard } from 'react-native';
import {
  Box,
  Card,
  Column,
  Icon,
  IconButton,
  LazyColumn,
  LazyRow,
  OutlinedTextField,
  Text,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import {
  background,
  border,
  clip,
  combinedClickable,
  defaultMinSize,
  fillMaxWidth,
  height,
  onSizeChanged,
  padding,
  semantics,
  Shapes,
  weight,
} from '@expo/ui/jetpack-compose/modifiers';
import {
  findGradeStop,
  isGradeStopEnd,
  isGradeStopInRange,
  isSameGradeBound,
  type GradeBound,
} from '@boardsesh/climb-filters';
import type {
  ClimbFilterFormModel,
  ClimbFilterFormRow,
  FilterGradeRow,
  FilterMenuRow,
  FilterNameRow,
} from './ClimbFilterForm.types';
import type { ClimbFilterScrollPosition, NativeListPosition } from './ClimbFilterSurface.types';
import { renderSettingsRow, useSettingsRowColors } from './settings-rows.android';
import { shouldPushValueToNative } from './AuthTextInput.logic';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { textFieldBrandColors } from '../theme/expo-ui-modifiers';
import { useGradeFormat } from '../hooks/use-grade-format';
import { buildGradeRailStops } from '../lib/grade-stops';
import { gradeRailCenter } from '../lib/grade-seed';
import { useGradeRangeInteraction } from './grade/use-grade-range-interaction';
import { readableTextColor } from './grade/grade-chip-colors';
import { withAlpha } from '../theme/colors';
import { useTranslation } from 'react-i18next';

type NativeListHandle = {
  getScrollPosition: () => Promise<NativeListPosition>;
  scrollToItem: (request: {
    index: number;
    alignment: 'start' | 'center';
    requestId: number;
    allowAfterInteraction?: boolean;
  }) => Promise<void>;
};
export type ClimbFilterFormHandle = { captureScrollPosition: () => Promise<ClimbFilterScrollPosition> };
type NativeFormProps = {
  model: ClimbFilterFormModel;
  initialScrollPosition?: ClimbFilterScrollPosition;
  onNameFocus: () => void;
};
const CLEAR_ICON = require('../../assets/material-icons/close.xml');

function NameRow({ row, onNameFocus }: { row: FilterNameRow; onNameFocus: () => void }) {
  const { brandColors } = useTheme();
  const textState = useNativeState(row.value);
  const lastEmittedRef = useRef(row.value);
  useLayoutEffect(() => {
    if (shouldPushValueToNative(row.value, lastEmittedRef.current)) {
      lastEmittedRef.current = row.value;
      textState.set(row.value);
    }
  }, [row.value, textState]);
  return (
    <OutlinedTextField
      value={textState}
      singleLine
      colors={textFieldBrandColors(brandColors)}
      modifiers={[fillMaxWidth(), padding(spacing[3], spacing[2], spacing[3], spacing[2])]}
      keyboardOptions={{ autoCorrectEnabled: false, capitalization: 'none', imeAction: 'search' }}
      keyboardActions={{ onSearch: () => Keyboard.dismiss() }}
      onValueChange={(text) => {
        lastEmittedRef.current = text;
        row.onChangeText(text);
      }}
      onFocusChanged={(focused) => {
        if (focused) onNameFocus();
      }}
    >
      <OutlinedTextField.Label>
        <Text>{row.accessibilityLabel}</Text>
      </OutlinedTextField.Label>
      <OutlinedTextField.Placeholder>
        <Text>{row.placeholder}</Text>
      </OutlinedTextField.Placeholder>
      {row.value.length > 0 ? (
        <OutlinedTextField.TrailingIcon>
          <IconButton onClick={row.onClear}>
            <Icon source={CLEAR_ICON} size={20} contentDescription={row.clearLabel} />
          </IconButton>
        </OutlinedTextField.TrailingIcon>
      ) : null}
    </OutlinedTextField>
  );
}
function RecentRow({ row }: { row: FilterMenuRow }) {
  const colors = useSettingsRowColors();
  return renderSettingsRow(
    {
      kind: 'select',
      key: row.key,
      label: row.label,
      selectedKey: row.items.find((item) => item.checked)?.key ?? '',
      options: row.items,
      onSelect: row.onSelect,
    },
    colors,
  );
}

function GradeRow({
  row,
  railRef,
  initialPosition,
}: {
  row: FilterGradeRow;
  railRef: RefObject<NativeListHandle | null>;
  initialPosition?: NativeListPosition;
}) {
  const { grades, bound, boardName, lastUsedGradeId, onChange } = row.grade;
  const { gradeFormat } = useGradeFormat();
  const { t } = useTranslation('climbs');
  const { systemColors, chartColors } = useTheme();
  const stops = useMemo(() => buildGradeRailStops(grades, gradeFormat, boardName), [grades, gradeFormat, boardName]);
  const sortedGrades = useMemo(
    () => [...grades].sort((first, second) => first.difficultyId - second.difficultyId),
    [grades],
  );
  const centerGradeId = gradeRailCenter(
    { minGradeId: bound.minGradeId ?? undefined, maxGradeId: bound.maxGradeId ?? undefined },
    sortedGrades,
    [],
    lastUsedGradeId,
  );
  const targetIndex =
    centerGradeId == null ? -1 : stops.findIndex((stop) => stop === findGradeStop(stops, centerGradeId));
  const ownBoundRef = useRef<GradeBound | null>(null);
  const seenBoundRef = useRef(bound);
  const requestIdRef = useRef(0);
  const lastTargetRef = useRef<number | null>(null);
  const allowAfterInteractionRef = useRef(false);
  const [railSize, setRailSize] = useState<{ width: number; height: number } | null>(null);
  const failedCenterRef = useRef<{ targetIndex: number; layout: typeof railSize } | null>(null);
  const handleRailSizeChanged = useCallback((size: { width: number; height: number }) => {
    if (size.width <= 0 || size.height <= 0) return;
    setRailSize((previous) => (previous?.width === size.width && previous.height === size.height ? previous : size));
  }, []);
  const interactedRef = useRef(false);
  const restoredRef = useRef(initialPosition !== undefined);
  const markInteracted = useCallback(() => {
    interactedRef.current = true;
  }, []);
  const interaction = useGradeRangeInteraction({
    bound,
    stops,
    markInteracted,
    onChange: (next, change) => {
      ownBoundRef.current = next;
      onChange(next, change);
    },
  });
  useEffect(() => {
    const changed = !isSameGradeBound(seenBoundRef.current, bound);
    seenBoundRef.current = bound;
    if (changed && ownBoundRef.current && isSameGradeBound(ownBoundRef.current, bound)) {
      ownBoundRef.current = null;
      allowAfterInteractionRef.current = false;
      lastTargetRef.current = targetIndex;
      return;
    }
    if (changed) {
      ownBoundRef.current = null;
      interactedRef.current = false;
      restoredRef.current = false;
      allowAfterInteractionRef.current = true;
    }
    if (
      railSize === null ||
      restoredRef.current ||
      interactedRef.current ||
      targetIndex < 0 ||
      (!changed &&
        failedCenterRef.current?.targetIndex === targetIndex &&
        failedCenterRef.current.layout === railSize) ||
      (!changed && lastTargetRef.current === targetIndex)
    )
      return;
    lastTargetRef.current = targetIndex;
    const requestId = ++requestIdRef.current;
    const allowAfterInteraction = allowAfterInteractionRef.current;
    void Promise.resolve()
      .then(() =>
        railRef.current?.scrollToItem({
          index: targetIndex + 1,
          alignment: 'center',
          requestId,
          ...(allowAfterInteraction ? { allowAfterInteraction: true } : {}),
        }),
      )
      .then(() => {
        if (requestIdRef.current === requestId) {
          allowAfterInteractionRef.current = false;
          failedCenterRef.current = null;
        }
      })
      .catch((error: unknown) => {
        // Retry only after another genuine layout or selection change, never a polling loop.
        if (requestIdRef.current === requestId) {
          lastTargetRef.current = null;
          failedCenterRef.current = { targetIndex, layout: railSize };
        }
        if (__DEV__) console.warn('[filters] grade centering unavailable', error);
      });
  }, [bound, targetIndex, railRef, railSize]);
  const chip = (
    key: string,
    label: string,
    selected: boolean,
    ranged: boolean,
    description: string,
    onTap: () => void,
    onHold?: () => void,
    gradeColor?: string,
  ) => {
    const fill =
      selected && gradeColor ? gradeColor : ranged && gradeColor ? withAlpha(gradeColor, 0.18) : systemColors.fill;
    const ring = selected
      ? withAlpha(chartColors.label, 0.45)
      : ranged && gradeColor
        ? withAlpha(gradeColor, 0.75)
        : 'transparent';
    return (
      <Box
        key={key}
        contentAlignment="center"
        modifiers={[
          clip(Shapes.RoundedCorner(24)),
          background(fill),
          border(1, ring),
          combinedClickable({ onClick: onTap, onLongClick: onHold }),
          semantics({ contentDescription: description, selected }),
          defaultMinSize({ minHeight: 48, minWidth: 48 }),
          padding(spacing[3], spacing[2], spacing[3], spacing[2]),
        ]}
      >
        <Text
          color={selected && gradeColor ? readableTextColor(gradeColor) : systemColors.label}
          style={{ typography: 'labelLarge' }}
        >
          {label}
        </Text>
      </Box>
    );
  };
  return (
    <Box modifiers={[fillMaxWidth(), height(72), onSizeChanged(handleRailSizeChanged)]}>
      <LazyRow
        ref={railRef}
        initialScrollPosition={initialPosition}
        modifiers={[fillMaxWidth(), height(72)]}
        verticalAlignment="center"
        horizontalArrangement={{ spacedBy: spacing[2] }}
        contentPadding={{ start: spacing[3], end: spacing[3] }}
      >
        {chip(
          'any',
          t('mobile.search.gradeClear'),
          interaction.anySelected,
          false,
          t(interaction.anySelected ? 'mobile.gradeRail.anyGradeAria' : 'mobile.gradeRail.clearFilterAria'),
          interaction.handleClear,
        )}
        {stops.map((stop) => {
          const selected = isGradeStopEnd(bound, stop);
          const ranged = isGradeStopInRange(bound, stop);
          const description = selected
            ? t('mobile.gradeRail.selectedFilterAria', { grade: stop.label })
            : ranged
              ? t('mobile.gradeRail.rangeFilterAria', { grade: stop.label })
              : t('mobile.gradeRail.setFilterAria', { grade: stop.label });
          return chip(
            String(stop.minGradeId),
            stop.label,
            selected,
            ranged,
            `${description}. ${t('mobile.gradeRail.rangeHoldHint')}`,
            () => interaction.handleTapStop(stop),
            () => interaction.handleHoldStop(stop),
            stop.gradeColor,
          );
        })}
      </LazyRow>
    </Box>
  );
}

export const ClimbFilterForm = forwardRef<ClimbFilterFormHandle, NativeFormProps>(function ClimbFilterForm(
  { model, initialScrollPosition, onNameFocus },
  ref,
) {
  const colors = useSettingsRowColors();
  const columnRef = useRef<NativeListHandle>(null);
  const railRef = useRef<NativeListHandle>(null);
  const lastSnapshotRef = useRef<ClimbFilterScrollPosition>(initialScrollPosition ?? { offsetDp: 0 });
  const modelRef = useRef(model);
  modelRef.current = model;
  const initialPositionRef = useRef(initialScrollPosition);
  const sectionIndex =
    initialPositionRef.current?.sectionKey == null
      ? -1
      : model.sections.findIndex((section) => section.key === initialPositionRef.current?.sectionKey);
  const initialColumnPosition =
    sectionIndex < 0 ? undefined : { index: sectionIndex, offsetDp: initialPositionRef.current?.offsetDp ?? 0 };
  useImperativeHandle(
    ref,
    () => ({
      captureScrollPosition: async () => {
        const sectionsAtCapture = modelRef.current.sections;
        try {
          const [column, rail] = await Promise.all([
            Promise.resolve().then(() => columnRef.current?.getScrollPosition()),
            Promise.resolve().then(() => railRef.current?.getScrollPosition()),
          ]);
          const snapshot = {
            sectionKey: column ? sectionsAtCapture[column.index]?.key : lastSnapshotRef.current.sectionKey,
            offsetDp: column?.offsetDp ?? lastSnapshotRef.current.offsetDp,
            rail: rail ?? lastSnapshotRef.current.rail,
          };
          lastSnapshotRef.current = snapshot;
          return snapshot;
        } catch (error: unknown) {
          if (__DEV__) console.warn('[filters] list snapshot unavailable', error);
          return lastSnapshotRef.current;
        }
      },
    }),
    [],
  );
  function renderRow(row: ClimbFilterFormRow) {
    if (row.kind === 'name') return <NameRow key={row.key} row={row} onNameFocus={onNameFocus} />;
    if (row.kind === 'menu') return <RecentRow key={row.key} row={row} />;
    if (row.kind === 'grade')
      return <GradeRow key={row.key} row={row} railRef={railRef} initialPosition={initialPositionRef.current?.rail} />;
    return renderSettingsRow(row, colors);
  }
  return (
    <LazyColumn
      ref={columnRef}
      initialScrollPosition={initialColumnPosition}
      modifiers={[fillMaxWidth(), weight(1)]}
      contentPadding={{ start: spacing[4], end: spacing[4], bottom: spacing[10] }}
    >
      {model.sections.map((section, index) => (
        <Column key={section.key} modifiers={[fillMaxWidth(), padding(0, index === 0 ? 0 : spacing[5], 0, 0)]}>
          {section.title ? (
            <Text
              color={colors.sectionTextColor}
              style={{ typography: 'titleSmall' }}
              modifiers={[padding(spacing[1], spacing[2], spacing[1], spacing[2])]}
            >
              {section.title}
            </Text>
          ) : null}
          <Card modifiers={[fillMaxWidth()]}>
            <Column modifiers={[fillMaxWidth()]}>{section.rows.map(renderRow)}</Column>
          </Card>
          {section.footer ? (
            <Text
              color={colors.sectionTextColor}
              style={{ typography: 'bodySmall' }}
              modifiers={[padding(spacing[1], spacing[3], spacing[1], 0)]}
            >
              {section.footer}
            </Text>
          ) : null}
        </Column>
      ))}
    </LazyColumn>
  );
});
