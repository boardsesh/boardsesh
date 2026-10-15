import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { Sheet } from '../Sheet';
import { SheetTopBar } from '../SheetTopBar';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useTheme } from '../../providers/theme-provider';
import { SPRAY_WALL_NAME_MAX_LENGTH } from '../board-discovery/use-spray-wall-builder';
import { spacing, borderRadius } from '../../theme/tokens';

type SprayWallNameSheetProps = {
  visible: boolean;
  /** The name as the details step holds it, seeded into the field on each open. */
  name: string;
  /** What an empty field shows: the default name the wall already has. */
  placeholder: string;
  /** Done, with the trimmed name. Never called with an empty one. */
  onDone: (name: string) => void;
  onClose: () => void;
};

/**
 * Rename the wall on the add-a-wall details step: one field in a small sheet,
 * the shape of the session rename sheet (`SessionTitleSheet`), but local: Done
 * hands the name back to the details form, and the form's Save is what writes.
 *
 * A sheet rather than an inline field because the details step is a native
 * settings form, which hosts no text inputs. The field is focused on open: the
 * climber tapped the row to type.
 */
export function SprayWallNameSheet({ visible, name, placeholder, onDone, onClose }: SprayWallNameSheetProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const [draft, setDraft] = useState(name);
  const sheetRef = useRef<BottomSheetMethods>(null);
  const handleFocus = useCallback(() => {
    if (Platform.OS === 'android') sheetRef.current?.expand();
  }, []);

  // Seeded on the closed → open edge only, so a re-render while open never
  // throws away what the climber has typed.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) setDraft(name);
    wasVisibleRef.current = visible;
  }, [visible, name]);

  const trimmed = draft.trim();
  const handleDone = useCallback(() => {
    if (trimmed.length === 0) return;
    onDone(trimmed);
  }, [trimmed, onDone]);

  const header = (
    <SheetTopBar
      title={t('sprayWizard.details.renameTitle')}
      leading={{ kind: 'cancel', onPress: onClose, accessibilityLabel: tCommon('comment.cancel') }}
      trailing={{
        kind: 'confirm',
        label: t('sprayWizard.details.renameDone'),
        onPress: handleDone,
        // A wall needs a name; the form's Save would refuse an empty one anyway.
        disabled: trimmed.length === 0,
        prominent: true,
      }}
    />
  );

  // iOS fits the sheet to the field and lifts it over the keyboard. On Android
  // a content-fitted sheet grew by the keyboard's height to the full screen,
  // which put its top bar under the status bar and the drag handle below the
  // bar; fixed detents (the session edit sheet's) keep it below both.
  const sizing =
    Platform.OS === 'android'
      ? { snapPoints: MEDIUM_LARGE_SNAP_POINTS }
      : { enableDynamicSizing: true, androidContentSized: true };

  const field = (
    <View style={styles.body}>
      <BottomSheetTextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        placeholderTextColor={systemColors.tertiaryLabel}
        accessibilityLabel={t('sprayWizard.details.name')}
        maxLength={SPRAY_WALL_NAME_MAX_LENGTH}
        style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
        // A wall's name is a proper noun ("Garage", "The Cave"); autocorrect
        // rewrote it and spell-check underlined it (#5960).
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="done"
        autoFocus
        onFocus={handleFocus}
        onSubmitEditing={handleDone}
        testID="spray-wall-name-input"
      />
    </View>
  );

  return (
    <Sheet
      ref={sheetRef}
      visible={visible}
      {...sizing}
      onClose={onClose}
      header={Platform.OS === 'android' ? undefined : header}
    >
      {Platform.OS === 'android' ? (
        <>
          {/* Keep chrome outside the field's scroll viewport, while avoiding
              Sheet's extra keyboard padding: Compose already shrinks this
              fixed-detent body when the IME opens. Padding twice hides it. */}
          {header}
          <ScrollView style={styles.androidBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {field}
          </ScrollView>
        </>
      ) : (
        field
      )}
    </Sheet>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    androidBody: {
      flex: 1,
    },
    body: {
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
      paddingBottom: spacing[4],
    },
    input: {
      borderRadius: borderRadius.lg,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: textStyles.callout.fontSize,
    },
  });
