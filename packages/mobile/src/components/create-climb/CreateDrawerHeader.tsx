import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Pressable, type TextInput } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { AppMenu } from '../AppMenu';
import { SheetTopBarTrailingButton } from '../SheetTopBar';
import {
  buildCreateOverflowMenu,
  type CreateOverflowAction,
  type CreateOverflowMenuState,
} from './create-overflow-menu';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { deriveSaveButtonView } from './save-button-view';
import type { SaveButtonState } from './use-create-climb-screen';

const NAME_MAX = 80;

type CreateDrawerHeaderProps = {
  name: string;
  onChangeName: (next: string) => void;
  startingCount: number;
  finishCount: number;
  /** Bumped by the controller to pull focus into the name field (unnamed save). */
  focusSignal: number;
  onClose: () => void;
  /** Editor state the overflow (⋯) menu builds its rows from. */
  overflow: CreateOverflowMenuState;
  onSelectOverflowAction: (action: CreateOverflowAction) => void;
  saveState: SaveButtonState;
  onSave: () => void;
  /**
   * False while the holds can't be saved yet: no holds on a draft, or no start
   * or finish on a publish (or a remix's lost holds still up). The counts under
   * the name say what is missing, so a disabled Save is never mute.
   */
  climbReady: boolean;
};

/**
 * Create-drawer header, mirroring the Play Drawer chrome: a close chevron on the
 * left, the always-editable climb name + start/finish counts in the centre, then
 * the overflow menu and the trailing Save. Nothing else: every extra 44pt here
 * comes out of the name field, which a French or German Save already narrows.
 * The lightbulb lives in the tool row for that reason.
 *
 * Bespoke rather than a SheetTopBar because its title is a text field. Save
 * still uses the top bar's own trailing confirm, so it looks and behaves like
 * every other sheet's (see docs/mobile-sheets-vs-routes.md, "Where actions go").
 */
export const CreateDrawerHeader = memo(function CreateDrawerHeader({
  name,
  onChangeName,
  startingCount,
  finishCount,
  focusSignal,
  onClose,
  overflow,
  onSelectOverflowAction,
  saveState,
  onSave,
  climbReady,
}: CreateDrawerHeaderProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const counts = `${t('mobile.create.counts.start', { count: startingCount })} · ${t('mobile.create.counts.finish', {
    count: finishCount,
  })}`;

  const overflowRows = useMemo(() => buildCreateOverflowMenu(overflow, t), [overflow, t]);
  // The menu reports a position; the rows carry what that position means, so a
  // state that drops a row (Woods, or a boulder with no frame to delete) can
  // never shift a tap onto the wrong action.
  //
  // Disabled rows are refused here as well as by all three platform menus. Every
  // action behind one guards itself too, so this is depth rather than a fix —
  // but the row set is data, and the next action added to it may not.
  const handleSelectOverflowIndex = useCallback(
    (index: number) => {
      const row = overflowRows[index];
      if (!row || row.disabled) return;
      onSelectOverflowAction(row.action);
    },
    [overflowRows, onSelectOverflowAction],
  );

  const save = deriveSaveButtonView(saveState, t, climbReady);

  return (
    <View style={styles.row}>
      {/* NOT `createClimbForm.dismiss` — that key is a DIALOG cancel label, and
          its translations say discard ("Descartar" / "Ignorer" / "Ausblenden").
          On a close button, for a feature whose whole point is "does closing lose
          my work?", the screen-reader user was getting a stronger wrong signal
          than the sighted one. The work is kept; the hint says where. */}
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.create.actions.close')}
        accessibilityHint={t('mobile.create.actions.closeHint')}
        hitSlop={8}
        style={[styles.iconButton, { backgroundColor: systemColors.fill }]}
      >
        <Icon name="chevron.down" size={20} color={systemColors.secondaryLabel} />
      </Pressable>

      <View style={styles.center}>
        <BottomSheetTextInput
          // The native drop-in re-exports BottomSheetTextInput as RN's TextInput,
          // so the ref is a plain TextInput ref (used for focus()).
          ref={inputRef}
          value={name}
          onChangeText={onChangeName}
          placeholder={t('mobile.create.header.newClimb')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={NAME_MAX}
          returnKeyType="done"
          style={[styles.nameInput, { color: systemColors.label }]}
        />
        {/* One line whatever the locale: it shrinks before it wraps, so the
            header's height (part of the measured peek) never changes. */}
        <Text
          variant="caption1"
          color={systemColors.secondaryLabel}
          style={styles.subtitle}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {counts}
        </Text>
      </View>

      {/* Document-level commands (what kind of climb this is, start over) live in
          the nav-bar overflow, not the action bar: that bar is a tool bar you use
          with a brush in hand. A bare `copy` glyph in it went unfound twice. */}
      <AppMenu
        iconName="more"
        actions={overflowRows}
        onSelectIndex={handleSelectOverflowIndex}
        accessibilityLabel={t('mobile.create.routeMenu.open')}
        style={styles.overflow}
      />

      <SheetTopBarTrailingButton
        label={save.label}
        accessibilityLabel={save.accessibilityLabel}
        onPress={onSave}
        disabled={save.disabled}
        loading={save.loading}
        icon={save.icon ?? undefined}
        accessibilityHint={save.accessibilityHint ?? undefined}
        prominent
      />
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    minHeight: 56,
    gap: spacing[2],
  },
  // A 44pt circle echoing the Play Drawer's close button. The fill is applied
  // inline from the theme (systemColors.fill) so it adapts to dark mode and
  // matches the drawer's action buttons.
  overflow: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  nameInput: {
    fontWeight: '700',
    fontSize: 17,
    textAlign: 'center',
    paddingVertical: 0,
    alignSelf: 'stretch',
  },
  subtitle: {
    marginTop: 2,
    textAlign: 'center',
  },
});
