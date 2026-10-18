import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE, type BoardRenderMode } from '@boardsesh/board-constants/hold-states';
import { contrastRatio } from '@boardsesh/board-constants/readable-text-color';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { summarizeActiveHolds, type ActiveHoldRole, type ActiveHoldsGroup } from '@boardsesh/play-view';
import type { BoardName } from '@boardsesh/shared-schema';
import { CollapsibleSection } from '../CollapsibleSection';
import { Text } from '../Text';
import { useBoardRenderMode } from '../../hooks/use-board-render-look';
import {
  resolveHoldStateMarker,
  useHoldColorOverrides,
  type HoldColorOverrides,
  type HoldMarkerShape,
  type HoldShapeOverrides,
} from '../../lib/hold-color-overrides';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import {
  ACTIVE_HOLDS_LINE_KEYS,
  activeHoldsLineCandidates,
  activeHoldsLineWidthKey,
  chooseActiveHoldsLine,
  rememberLineChoice,
  rememberLineRoom,
  rememberLineWidth,
  rememberedLineChoice,
  rememberedLineRoom,
  rememberedLineWidth,
  type ActiveHoldsLineKey,
  type ActiveHoldsLineSegment,
} from './active-holds-line';
import { PlaybackFrameContext } from './playback-frame-context';

/**
 * Classic marker shapes as text glyphs. The octagon is a hexagon (⬢): no Apple
 * system font has the black octagon (U+2BC3), so iOS would draw a box.
 */
const SHAPE_GLYPHS: Readonly<Record<HoldMarkerShape, string>> = {
  circle: '●',
  'triangle-up': '▲',
  'triangle-down': '▼',
  square: '■',
  diamond: '◆',
  octagon: '⬢',
};

/** Aura's accessibility glyphs as text: start a level bar, hand an upright bar, finish an X, foot a ring. */
const ROLE_GLYPHS: Readonly<Record<ActiveHoldRole, string>> = {
  STARTING: '━',
  HAND: '┃',
  FINISH: '✕',
  FOOT: '○',
};

/** The least contrast a marker needs against its chip (WCAG 1.4.11, graphical objects). */
const MARKER_MIN_CONTRAST = 3;

export type ActiveHoldMarker = { color: string; glyph: string; chipColor: string };

/**
 * The glyph the board draws for a role. Classic draws the climber's marker
 * shape; Aura ignores shapes and draws a filled glow, or the role's
 * accessibility glyph when the climber turned those on.
 */
export function markerGlyph(
  role: ActiveHoldRole,
  shape: HoldMarkerShape,
  look: { mode: BoardRenderMode; roleGlyphs: boolean },
): string {
  if (look.mode === 'classic') return SHAPE_GLYPHS[shape];
  return look.roleGlyphs ? ROLE_GLYPHS[role] : SHAPE_GLYPHS.circle;
}

/**
 * The chip a marker sits on, so it reads on a light or a dark sheet alike: the
 * dark field the Aura board art sits on, where every default role colour
 * reaches 3:1, or the light field for a colour that does not (a classic dark
 * blue, a dark colour the climber picked). One of the two always clears 4:1.
 */
export function markerChipColor(markerColor: string): string {
  const onDarkField = contrastRatio(markerColor, BOARD_FIELD_COLORS.dark);
  return onDarkField === null || onDarkField >= MARKER_MIN_CONTRAST
    ? BOARD_FIELD_COLORS.dark
    : BOARD_FIELD_COLORS.light;
}

/**
 * A role's marker on this board: its canonical code's colour under the board's
 * render mode, then the climber's colour, and the glyph the board draws. A
 * role without a canonical code (MoonBoard's live-preview foot) takes its first
 * code.
 */
function roleMarker(
  boardName: BoardName,
  role: ActiveHoldRole,
  look: { mode: BoardRenderMode; roleGlyphs: boolean },
  colorOverrides: HoldColorOverrides,
  shapeOverrides: HoldShapeOverrides,
): ActiveHoldMarker | null {
  const stateMap = HOLD_STATE_MAP[boardName];
  const primaryCode = STATE_TO_PRIMARY_CODE[boardName]?.[role];
  const stateInfo =
    (primaryCode === undefined ? undefined : stateMap?.[primaryCode]) ??
    Object.values(stateMap ?? {}).find((candidate) => candidate.name === role);
  if (!stateInfo) return null;
  const { color, shape } = resolveHoldStateMarker(stateInfo, look.mode, colorOverrides, shapeOverrides);
  return { color, glyph: markerGlyph(role, shape, look), chipColor: markerChipColor(color) };
}

export type ActiveHoldsRow = ActiveHoldsGroup & {
  roleName: string;
  /** The holds as read out: coordinates joined by commas. */
  spokenHolds: string;
  marker: ActiveHoldMarker | null;
};

/** The climb's holds by role, each with the marker the board draws for it. */
function useActiveHoldsRows(boardName: BoardName, layoutId: number, frames: string): ActiveHoldsRow[] {
  const { t } = useTranslation('climbs');
  const { overrides: colorOverrides, shapes: shapeOverrides } = useHoldColorOverrides();
  const look = useBoardRenderMode(boardName, layoutId);
  const summary = useMemo(() => summarizeActiveHolds(boardName, frames), [boardName, frames]);
  const startLabel = t('mobile.create.brush.start');
  const handLabel = t('mobile.create.brush.hand');
  const finishLabel = t('mobile.create.brush.finish');
  const footLabel = t('mobile.create.brush.foot');
  return useMemo(() => {
    const roleNames: Record<ActiveHoldRole, string> = {
      STARTING: startLabel,
      HAND: handLabel,
      FINISH: finishLabel,
      FOOT: footLabel,
    };
    const rows = summary.groups.map((group) => ({
      ...group,
      roleName: roleNames[group.role],
      spokenHolds: group.labels?.join(', ') ?? '',
      marker: roleMarker(boardName, group.role, look, colorOverrides, shapeOverrides),
    }));
    return rows;
  }, [summary, boardName, look, colorOverrides, shapeOverrides, startLabel, handLabel, finishLabel, footLabel]);
}

/** A role's glyph in its board colour, on a chip that keeps it readable on either theme. */
const MarkerChip = memo(function MarkerChip({ marker, size }: { marker: ActiveHoldMarker; size: number }) {
  return (
    <View
      style={[styles.chip, { width: size, height: size, backgroundColor: marker.chipColor }]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Text variant="caption2" color={marker.color} style={styles.glyph}>
        {marker.glyph}
      </Text>
    </View>
  );
});

/** A chip as tall as a line of footnote text, growing with the climber's text size. */
function useChipSize(): number {
  const { textStyles } = useTheme();
  const { fontScale } = useWindowDimensions();
  return Math.round((textStyles.footnote.lineHeight ?? textStyles.footnote.fontSize ?? 0) * fontScale);
}

type LineRowProps = {
  segments: readonly ActiveHoldsLineSegment[];
  markers: ReadonlyMap<ActiveHoldRole, ActiveHoldMarker | null>;
  chipSize: number;
  /** Hand may be cut short with an ellipsis; nothing else ever is. */
  handShrinks: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
};

/** One reading of the collapsed line: a marker per role, then what follows it. */
function LineRow({ segments, markers, chipSize, handShrinks, onLayout, testID }: LineRowProps) {
  const { systemColors } = useTheme();
  // A shrinking Hand keeps its chip: it never collapses to nothing under Finish.
  const handMinimum = { minWidth: chipSize + spacing[1] };
  return (
    <View style={styles.line} onLayout={onLayout} testID={testID}>
      {segments.map((segment) => {
        const marker = markers.get(segment.role) ?? null;
        const shrinks = handShrinks && segment.role === 'HAND';
        return (
          <View
            key={segment.role}
            style={[styles.lineGroup, shrinks && styles.lineGroupShrinks, shrinks && handMinimum]}
          >
            {marker ? <MarkerChip marker={marker} size={chipSize} /> : null}
            <Text
              variant="footnote"
              numeric
              numberOfLines={1}
              color={systemColors.label}
              style={shrinks ? styles.lineHoldsShrinks : undefined}
            >
              {segment.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The collapsed header: each role's marker, then its MoonBoard coordinates
 * (`● I4 ● G8 K10 G12 D14 F14 ● F18`), in the title's place. It measures every
 * reading off screen and draws the richest one that fits the row at the
 * climber's text size: only Hand is ever cut short, then Hand becomes a count,
 * and when not even that fits, the section's title stands in.
 */
export const ActiveHoldsLine = memo(function ActiveHoldsLine({
  rows,
  fallbackTitle,
}: {
  rows: readonly ActiveHoldsRow[];
  /** Drawn instead of the line when no reading fits, so the header always names the section. */
  fallbackTitle: string;
}) {
  const chipSize = useChipSize();
  const candidates = useMemo(() => activeHoldsLineCandidates(rows), [rows]);
  const markers = useMemo(() => new Map(rows.map((row) => [row.role, row.marker])), [rows]);
  const keys: readonly ActiveHoldsLineKey[] = ACTIVE_HOLDS_LINE_KEYS;
  const { fontScale } = useWindowDimensions();
  const widthKeys = useMemo(
    () =>
      Object.fromEntries(
        keys.map((key) => [key, activeHoldsLineWidthKey(fontScale, chipSize, key, candidates[key])]),
      ) as Partial<Record<ActiveHoldsLineKey, string>>,
    [keys, fontScale, chipSize, candidates],
  );
  // Widths and the room live beside the line's module, not in this component:
  // folding the section shut unmounts the line, and a reading measured once
  // stays measured. This only counts new measurements, to draw again.
  const [, setMeasurements] = useState(0);
  const [available, setAvailable] = useState<number | null>(rememberedLineRoom);
  const handleFrameLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    rememberLineRoom(width);
    setAvailable((previous) => (previous !== null && Math.abs(previous - width) < 0.5 ? previous : width));
  }, []);
  const measure = useCallback((widthKey: string, width: number) => {
    if (rememberLineWidth(widthKey, width)) setMeasurements((count) => count + 1);
  }, []);
  const widths: Partial<Record<ActiveHoldsLineKey, number>> = {};
  for (const key of keys) {
    const widthKey = widthKeys[key];
    const width = widthKey === undefined ? undefined : rememberedLineWidth(widthKey);
    if (width !== undefined) widths[key] = width;
  }
  const measured = available !== null && keys.every((key) => widths[key] !== undefined);
  const choice = chooseActiveHoldsLine({ widths, available, lastChoice: rememberedLineChoice() });
  const choiceKey = choice?.key ?? null;
  const choiceShrinks = choice?.handShrinks ?? false;
  // Only a measured reading is remembered, to stand in while the next climb measures.
  useEffect(() => {
    if (!measured) return;
    rememberLineChoice(choiceKey === null ? null : { key: choiceKey, handShrinks: choiceShrinks });
  }, [measured, choiceKey, choiceShrinks]);
  return (
    <View style={styles.lineFrame} onLayout={handleFrameLayout} testID="active-holds-line-frame">
      {/* Every reading at its natural width, unseen. Each row is keyed by what
          its width depends on, so only a reading with new words remounts and
          reports a fresh width. */}
      <View
        style={styles.measureLayer}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {keys.map((key) => {
          const widthKey = widthKeys[key] ?? key;
          return (
            <View key={widthKey} style={styles.measureRow}>
              <LineRow
                segments={candidates[key]}
                markers={markers}
                chipSize={chipSize}
                handShrinks={false}
                onLayout={(event) => measure(widthKey, event.nativeEvent.layout.width)}
                testID={`active-holds-measure-${key}`}
              />
            </View>
          );
        })}
      </View>
      {choice ? (
        <LineRow
          segments={candidates[choice.key]}
          markers={markers}
          chipSize={chipSize}
          handShrinks={choice.handShrinks}
          testID="active-holds-line"
        />
      ) : (
        <Text variant="headline" numberOfLines={1} testID="active-holds-line-title">
          {fallbackTitle}
        </Text>
      )}
    </View>
  );
});

/** One row a role: its marker, its name, then its coordinates. */
const ActiveHoldsList = memo(function ActiveHoldsList({ rows }: { rows: readonly ActiveHoldsRow[] }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const chipSize = useChipSize();
  if (rows.length === 0) {
    return (
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {t('mobile.activeHolds.empty')}
      </Text>
    );
  }
  return (
    <View style={styles.list}>
      {rows.map((row) => (
        <View
          key={row.role}
          style={styles.row}
          accessible
          accessibilityLabel={t('mobile.activeHolds.a11yGroup', { role: row.roleName, holds: row.spokenHolds })}
          testID={`active-holds-row-${row.role}`}
        >
          {row.marker ? <MarkerChip marker={row.marker} size={chipSize} /> : null}
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.roleName}>
            {row.roleName}
          </Text>
          <Text variant="subheadline" numeric style={styles.holds}>
            {row.labels?.join(' ')}
          </Text>
        </View>
      ))}
    </View>
  );
});

type ActiveHoldsSectionProps = {
  /** The board the displayed climb is drawn on. */
  boardName: BoardName;
  layoutId: number;
  /** The climb's frames. On an animated climb the playback frame on screen wins (`PlaybackFrameContext`). */
  frames: string;
  onHeaderLayout?: (height: number) => void;
  onToggle?: (expanded: boolean) => void;
};

/**
 * A MoonBoard climb's holds by role, as a section below the climb (the drawer
 * only offers it on a MoonBoard: other boards are too dense for a list of holds
 * to help). Collapsed (as the peek at the fold, say) its header is just the
 * line of wall coordinates, bottom to top, with no title; expanded, it is
 * titled and lists a row a role. It reads the frames the board already has:
 * no state, no effects, no queries and no Bluetooth.
 */
export const ActiveHoldsSection = memo(function ActiveHoldsSection({
  boardName,
  layoutId,
  frames,
  onHeaderLayout,
  onToggle,
}: ActiveHoldsSectionProps) {
  const { t } = useTranslation('climbs');
  const playbackFrame = useContext(PlaybackFrameContext);
  const rows = useActiveHoldsRows(boardName, layoutId, playbackFrame ?? frames);
  // VoiceOver and TalkBack hear every hold on the collapsed header, past any cut.
  const spokenSummary = useMemo(
    () =>
      rows.length === 0
        ? undefined
        : `${rows
            .map((row) => t('mobile.activeHolds.a11yGroup', { role: row.roleName, holds: row.spokenHolds }))
            .join('. ')}.`,
    [rows, t],
  );
  return (
    <CollapsibleSection
      title={t('mobile.activeHolds.title')}
      summary={rows.length > 0 ? <ActiveHoldsLine rows={rows} fallbackTitle={t('mobile.activeHolds.title')} /> : null}
      summaryAccessibilityLabel={spokenSummary}
      hideTitleWhenCollapsed
      persistKey="activeHolds"
      onHeaderLayout={onHeaderLayout}
      onToggle={onToggle}
    >
      <ActiveHoldsList rows={rows} />
    </CollapsibleSection>
  );
});

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.sm,
  },
  glyph: {
    textAlign: 'center',
    includeFontPadding: false,
  },
  // Takes the whole row so it knows the room it has; the line starts where the title would.
  lineFrame: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  // Wide enough that every reading lays out at its natural width; never seen.
  measureLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 4096,
    opacity: 0,
  },
  measureRow: {
    alignSelf: 'flex-start',
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  lineGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    flexShrink: 0,
  },
  lineGroupShrinks: {
    flexShrink: 1,
    overflow: 'hidden',
  },
  lineHoldsShrinks: {
    flexShrink: 1,
  },
  list: {
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  roleName: {
    minWidth: 56,
  },
  holds: {
    flex: 1,
  },
});
