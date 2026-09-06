import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Pressable, ScrollView, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ButtonSurfaceProvider } from '../Button.surface';
import { ActionButton, drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { useHoldColorOverrides } from '../../lib/hold-color-overrides';
import { brandColors } from '../../theme/colors';
import { glassSize } from '../../theme/layout';
import { spacing, borderRadius } from '../../theme/tokens';
import { brushRoleColor, getPaintRoles, useBrushRoleLabels, type BrushRole } from './brush-roles';
import { deriveSaveButtonView } from './save-button-view';
import { CreateDraftStatusRow } from './CreateDraftStatusRow';
import { useRateLimitedAnnouncer } from './use-rate-limited-announcer';
import type { DraftStatusView } from './draft-status-view';
import type { SaveButtonState } from './use-create-climb-screen';

// Looked up dynamically by role below; mark each resolvable key (one per line,
// namespace-qualified) so the orphan checker keeps them.
// i18n-keep climbs.mobile.create.brush.start
// i18n-keep climbs.mobile.create.brush.hand
// i18n-keep climbs.mobile.create.brush.finish
// i18n-keep climbs.mobile.create.brush.foot

type CreateDrawerActionBarProps = {
  boardName: BoardName;
  selectedBrush: BrushRole;
  onSelectBrush: (role: BrushRole) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Empty this frame's holds. Undoable; leaves name/description/storage alone. */
  onClearHolds: () => void;
  /** Park this climb and start a blank one (confirms when nothing is saved yet). */
  onNewClimb: () => void;
  /** Whether this board's climbs can hold more than one frame. False on Woods,
   *  which lights one static frame — the whole frame cluster is hidden then. */
  supportsMultiFrame: boolean;
  frameCount: number;
  currentFrameIndex: number;
  onDuplicateFrame: () => void;
  onDeleteFrame: () => void;
  canSetActive: boolean;
  onSetActive: () => void;
  saveState: SaveButtonState;
  onSave: () => void;
  /** True while publishing is selected but the climb has no start or finish hold. */
  publishBlocked: boolean;
  /** The persistent "is my work safe?" line, or null for an empty editor. */
  draftStatus: DraftStatusView | null;
};

/**
 * The create-drawer action bar, built on the shared drawer-action-bar grammar.
 * Row 1 (where the Play Drawer's play controls sit) is the brush chips; row 2 is
 * the editing actions, then set-active and the save state-machine button; under
 * both sits the persistent draft-status line.
 *
 * Undo is pinned OUTSIDE the horizontal scroller on the leading edge, the mirror
 * of the trailing pinned pair. Nine 44dp controls need ~460dp and the scroller
 * has ~261dp, so on any multi-frame climb undo used to scroll off the left edge —
 * putting the only recovery from a mis-tap out of reach exactly when the row got
 * crowded. Pinning it is cheaper than a confirm and fixes the case a confirm
 * wouldn't. Redo stays in the scroller.
 */
export const CreateDrawerActionBar = memo(function CreateDrawerActionBar({
  boardName,
  selectedBrush,
  onSelectBrush,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClearHolds,
  onNewClimb,
  supportsMultiFrame,
  frameCount,
  currentFrameIndex,
  onDuplicateFrame,
  onDeleteFrame,
  canSetActive,
  onSetActive,
  saveState,
  onSave,
  publishBlocked,
  draftStatus,
}: CreateDrawerActionBarProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const roleLabels = useBrushRoleLabels();
  const { overrides: holdColorOverrides } = useHoldColorOverrides();
  // One voice for this whole surface, so a status transition and a frame
  // announcement can't talk over each other.
  const announce = useRateLimitedAnnouncer();

  // Duplicating a frame is undoable, so it needs feedback rather than a confirm:
  // today the only sign a frame appeared is the "2/2" counter mid-row. Haptic on
  // press (matching the brush chips), and the new count spoken once — on the
  // transition only, so frame NAVIGATION stays silent.
  const announceFrameCountRef = useRef(false);
  const handleDuplicateFrame = useCallback(() => {
    hapticSelection();
    announceFrameCountRef.current = true;
    onDuplicateFrame();
  }, [onDuplicateFrame]);
  useEffect(() => {
    if (!announceFrameCountRef.current) return;
    announceFrameCountRef.current = false;
    announce(t('mobile.create.frames.counter', { index: currentFrameIndex + 1, total: frameCount }));
  }, [frameCount, currentFrameIndex, announce, t]);

  const paintRoles = useMemo(() => getPaintRoles(boardName), [boardName]);
  const roleChips = useMemo(
    () =>
      paintRoles.map((role) => ({
        role,
        label: roleLabels[role],
        color: brushRoleColor(boardName, role, holdColorOverrides),
      })),
    [boardName, holdColorOverrides, paintRoles, roleLabels],
  );

  const handleSelect = (role: BrushRole) => {
    hapticSelection();
    onSelectBrush(role);
  };

  return (
    <View style={drawerActionBarStyles.container}>
      <View style={styles.brushRow}>
        {roleChips.map(({ role, label, color }) => {
          const selected = selectedBrush === role;
          return (
            <Pressable
              key={role}
              onPress={() => handleSelect(role)}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              style={[
                styles.chip,
                { backgroundColor: systemColors.fill },
                selected && { borderColor: color, borderWidth: 2 },
              ]}
            >
              <View style={[styles.swatch, { backgroundColor: color }]} />
              <Text variant="caption1" style={styles.chipLabel} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => handleSelect('OFF')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.create.brush.erase')}
          accessibilityState={{ selected: selectedBrush === 'OFF' }}
          style={[
            styles.chip,
            { backgroundColor: systemColors.fill },
            selectedBrush === 'OFF' && { borderColor: systemColors.label, borderWidth: 2 },
          ]}
        >
          <Icon name="eraser" size={18} color={systemColors.label} />
          <Text variant="caption1" style={styles.chipLabel} numberOfLines={1}>
            {t('mobile.create.brush.erase')}
          </Text>
        </Pressable>
      </View>

      <View style={[drawerActionBarStyles.rowSecondary, styles.rowSecondaryWithStatus]}>
        {/* Pinned outside the scroller: undo has to stay reachable on a
            multi-frame climb, where the editing cluster is wider than the row. */}
        <ActionButton
          size="sm"
          iconName="undo"
          onPress={onUndo}
          disabled={!canUndo}
          accessibilityLabel={t('mobile.create.actions.undo')}
        />

        {/* The editing cluster grows by four controls once a climb has a second
            frame, and RN views don't shrink — with no wrap and no scroll it used
            to push Save clean off the right edge. The scroller takes the row's
            leftover width in place of the shared `spacer`, so Set Active and Save
            hold the same position whether or not the stepper is showing. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.actionScroll}
          contentContainerStyle={styles.actionScrollContent}
        >
          <ActionButton
            size="sm"
            iconName="redo"
            onPress={onRedo}
            disabled={!canRedo}
            accessibilityLabel={t('mobile.create.actions.redo')}
          />
          {/* Keeps the trash can: now that it empties holds and nothing else, the
              glyph is honest. An eraser would collide with the Erase BRUSH chip
              59dp above — one glyph meaning both a mode and a command. */}
          <ActionButton
            size="sm"
            iconName="delete"
            onPress={onClearHolds}
            accessibilityLabel={t('mobile.create.actions.clear')}
          />
          {/* Duplicate appears only once a climb is already a route. Its FIRST
              use — turning a boulder into a route — belongs to the strip under
              the board, which says what it does; a bare `copy` glyph fourth
              inside a horizontal scroller said nothing, and that is why the
              transport went undiscovered (#4761 QA). Hidden entirely on a board
              that can't hold a second frame: the frames string would then carry
              a comma the packet builder rejects. */}
          {supportsMultiFrame && frameCount > 1 && (
            <ActionButton
              size="sm"
              iconName="copy"
              onPress={handleDuplicateFrame}
              accessibilityLabel={t('mobile.create.frames.duplicate')}
            />
          )}
          {supportsMultiFrame && frameCount > 1 && (
            <ActionButton
              size="sm"
              iconName="frame.remove"
              onPress={onDeleteFrame}
              accessibilityLabel={t('mobile.create.frames.delete')}
            />
          )}
          {/* Last in the scroller: the least-used control in the row, and the one
              it's fine to scroll for. `plus`, not `refresh` — that's already the
              playback-restart glyph. */}
          <ActionButton
            size="sm"
            iconName="plus"
            onPress={onNewClimb}
            accessibilityLabel={t('mobile.create.actions.newClimb')}
          />
        </ScrollView>

        {/* Not a play glyph: this pushes the climb into the queue, which lights
            it on a connected wall. The transport above the brush row is what
            plays the route. `flash` is the flashed-ascent glyph elsewhere and
            `lightbulb` is the header's Bluetooth toggle in this same sheet. */}
        <ActionButton
          size="sm"
          iconName="queue"
          onPress={onSetActive}
          disabled={!canSetActive}
          accessibilityLabel={t('mobile.create.actions.setActive')}
          accessibilityHint={canSetActive ? undefined : t('mobile.create.actions.setActiveHint')}
        />
        <SaveButton saveState={saveState} onSave={onSave} publishBlocked={publishBlocked} />
      </View>

      {/* Always rendered, even with nothing to say — see CreateDraftStatusRow. */}
      <CreateDraftStatusRow status={draftStatus} announce={announce} />
    </View>
  );
});

function SaveButton({
  saveState,
  onSave,
  publishBlocked,
}: {
  saveState: SaveButtonState;
  onSave: () => void;
  publishBlocked: boolean;
}) {
  const { t } = useTranslation('climbs');
  const view = deriveSaveButtonView(saveState, t);

  return (
    <ButtonSurfaceProvider surface="content">
      <Button
        title={view.title}
        icon={view.icon ?? undefined}
        variant="filled"
        size="small"
        // The only sub-44 control on this surface (Compose sizes a small filled
        // button at 40), shoulder to shoulder with 44dp icon buttons. Floor it.
        minHeight={glassSize.inline}
        // Success keeps the static green fill (white-legible in both schemes; the
        // lifted dark success tint would fail white-on-fill). For the default tint
        // we pass nothing so the filled Button uses its own scheme-aware
        // `primaryFill` (lifts to #7C3AED in dark), matching every other CTA.
        tintColor={view.tint === 'success' ? brandColors.success : undefined}
        // A blocked publish disables the button; the status line directly below
        // names the missing requirement, so it is never mute.
        disabled={view.disabled || publishBlocked}
        onPress={onSave}
      />
    </ButtonSurfaceProvider>
  );
}

const styles = StyleSheet.create({
  brushRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[2],
  },
  chip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[1],
    borderRadius: borderRadius.md,
    borderColor: 'transparent',
    borderWidth: 2,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  chipLabel: {
    fontWeight: '600',
  },
  // The status row carries the bar's bottom padding, so the line sits 4dp under
  // the Save pill rather than a full gap below it.
  rowSecondaryWithStatus: {
    paddingBottom: spacing[1],
  },
  actionScroll: {
    // Claims the row's leftover width so the trailing Set Active + Save pair is
    // pinned; anything that doesn't fit scrolls inside here, not off-screen.
    flex: 1,
  },
  actionScrollContent: {
    alignItems: 'center',
    gap: spacing[2],
  },
});
