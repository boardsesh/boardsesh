import { useUnsavedSheetGuard } from '../../hooks/use-unsaved-sheet-guard';
import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { PressableSurface } from '../PressableSurface';
import { usePublicationAudience } from '../privacy/use-publication-audience';
import { PublicationAudiencePicker } from '../privacy/PublicationAudiencePicker';
import { ContentAudienceControl } from '../privacy/ContentAudienceControl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';

import { useTranslation } from 'react-i18next';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { SheetTopBar } from '../SheetTopBar';
import { SwitchRow } from '../SwitchRow';
import { PlaylistPreviewSquare } from './PlaylistPreviewSquare';
import { normalizePlaylistColor, PLAYLIST_COLORS } from './playlist-colors';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { buildPlaylistFormValues, NAME_MAX, DESCRIPTION_MAX, type PlaylistFormValues } from './playlist-form-values';

export type { PlaylistFormValues };

// Quick-pick emoji suggestions shown under the free-entry slot. The slot itself
// takes any emoji via the system keyboard (mobile has no emoji-mart equivalent —
// it's DOM-only on web); these are one-tap shortcuts for the common ones.
const SUGGESTED_ICONS = ['🔥', '💪', '🎯', '⭐', '🧗', '🪨', '🏆'] as const;

// Generous enough to hold a single multi-codepoint emoji whole — including long
// ZWJ sequences like a family emoji (👨‍👩‍👧‍👦, 11 UTF-16 units) — so the cap never
// truncates one mid-sequence into a broken glyph. Still well under the backend's
// 50-char limit.
const ICON_MAX = 16;

type PlaylistFormSheetProps = {
  mode: 'create' | 'edit';
  visible: boolean;
  submitting?: boolean;
  /** Seed values for edit mode. */
  playlist?: Playlist | null;
  /**
   * Inline submit failure from the parent's mutation (e.g. create/update
   * rejected). Surfaced in this sheet's error slot — never via the root toast,
   * which renders behind the native sheet and would be invisible. The parent
   * keeps the sheet open on failure so the user can correct and retry.
   */
  submitError?: string | null;
  onSubmit: (values: PlaylistFormValues) => void;
  onClose: () => void;
};

/**
 * One sheet powering both create and edit (web ships two near-identical
 * drawers — `CreatePlaylistDrawer` / `PlaylistEditDrawer`). Fields mirror web:
 * name (required, ≤100), description (≤500), colour swatch; edit also exposes
 * an icon picker + a public/private toggle. Validation + reset-on-open mirror
 * web; the parent owns the mutation, toasts, and cache refresh.
 */
export function PlaylistFormSheet({
  mode,
  visible,
  submitting,
  playlist,
  submitError,
  onSubmit,
  onClose,
}: PlaylistFormSheetProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('playlists');
  const { systemColors, brandColors } = useTheme();
  const isEdit = mode === 'edit';
  const privacy = usePublicationAudience(playlist?.uuid ?? 'new-playlist', visible);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<string | undefined>(undefined);
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A parent submit failure shows until the user edits a field (a signal they're
  // acting on it) or retries, so a stale server error doesn't linger over an
  // already-corrected form. Reset whenever a fresh submitError arrives.
  const [submitErrorDismissed, setSubmitErrorDismissed] = useState(false);
  useEffect(() => {
    setSubmitErrorDismissed(false);
  }, [submitError]);
  const dismissSubmitError = useCallback(() => setSubmitErrorDismissed(true), []);

  // Seed (edit) or clear (create) the fields each time the sheet opens; the
  // ModalSheet is driven declaratively off `visible`, so this only tracks the
  // closed→open transition to re-seed.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      if (isEdit && playlist) {
        setName(playlist.name);
        setDescription(playlist.description ?? '');
        setColor(normalizePlaylistColor(playlist.color) ?? undefined);
        setIcon(playlist.icon);
        setIsPublic(playlist.isPublic);
      } else {
        setName('');
        setDescription('');
        setColor(undefined);
        setIcon(undefined);
        setIsPublic(false);
      }
      setError(null);
    }
    wasVisibleRef.current = visible;
  }, [visible, isEdit, playlist]);

  const initial = isEdit && playlist ? playlist : null;
  const dirty =
    name !== (initial?.name ?? '') ||
    description !== (initial?.description ?? '') ||
    color !== (normalizePlaylistColor(initial?.color) ?? undefined) ||
    icon !== initial?.icon ||
    isPublic !== (initial?.isPublic ?? false);
  const guard = useUnsavedSheetGuard({
    visible,
    dirty,
    busy: submitting,
    onClose,
    scope: `${mode}:${playlist?.uuid ?? ''}`,
  });

  const handleSubmit = useCallback(() => {
    const result = buildPlaylistFormValues(mode, { name, description, color, icon, isPublic });
    if (!result.ok) {
      setError(
        result.error === 'name-required'
          ? t('edit.validation.nameRequired')
          : result.error === 'name-too-long'
            ? t('edit.validation.nameTooLong')
            : t('edit.validation.descriptionTooLong'),
      );
      return;
    }
    setError(null);
    const { isPublic: legacyVisibility, ...formFields } = result.values;
    onSubmit({
      ...formFields,
      ...(!privacy.enabled ? { isPublic: legacyVisibility } : {}),
      ...(privacy.publication && !isEdit
        ? { privacy: privacy.publication, isPublic: privacy.audience === 'public' }
        : {}),
    });
  }, [mode, name, description, color, icon, isPublic, onSubmit, t, privacy.publication, privacy.audience, privacy.enabled, isEdit]);

  // Local validation takes precedence over a parent submit failure: a fresh
  // validation message (e.g. empty name) is the more actionable feedback, and
  // the parent clears `submitError` at the start of each retry anyway.
  const visibleError = error ?? (submitErrorDismissed ? null : submitError) ?? null;

  const title = isEdit ? t('edit.title') : t('create.drawerTitle');
  const submitLabel = isEdit ? t('edit.actions.save') : t('create.submit');

  const inputStyle = useMemo(
    () => [
      styles.input,
      {
        backgroundColor: systemColors.fill,
        color: systemColors.label,
        borderColor: systemColors.separator,
      },
    ],
    [systemColors],
  );

  const header = (
    <SheetTopBar
      title={title}
      leading={{ kind: 'cancel', onPress: guard.requestClose }}
      trailing={{
        kind: 'confirm',
        label: submitLabel,
        onPress: handleSubmit,
        loading: submitting,
        disabled: submitting,
        prominent: true,
      }}
      error={visibleError}
      reserveErrorSlot
    />
  );

  return (
    <ModalSheet
      visible={visible}
      snapPoints={['90%']}
      onDisplaced={onClose}
      onClose={guard.requestClose}
      enablePanDownToClose={guard.enablePanDownToClose}
      scrollable
      header={header}
    >
      {isEdit && playlist ? (
        <ContentAudienceControl entityType="playlist" entityId={playlist.uuid} />
      ) : (
        <PublicationAudiencePicker privacy={privacy} disabled={submitting} />
      )}
      <View style={styles.body}>
        <View style={styles.header}>
          <PlaylistPreviewSquare color={color} icon={icon} size={56} />
        </View>

        <Text variant="footnote" style={styles.label}>
          {isEdit ? t('edit.fields.name') : t('create.fields.name')}
        </Text>
        <BottomSheetTextInput
          value={name}
          onChangeText={(text) => {
            dismissSubmitError();
            setName(text);
          }}
          placeholder={t('create.fields.namePlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={NAME_MAX}
          style={inputStyle}
          returnKeyType="done"
        />

        <Text variant="footnote" style={styles.label}>
          {isEdit ? t('edit.fields.description') : t('create.fields.description')}
        </Text>
        <BottomSheetTextInput
          value={description}
          onChangeText={(text) => {
            dismissSubmitError();
            setDescription(text);
          }}
          placeholder={t('create.fields.descriptionPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={DESCRIPTION_MAX}
          multiline
          style={[inputStyle, styles.multiline]}
        />

        <Text variant="footnote" style={styles.label}>
          {isEdit ? t('edit.fields.color') : t('create.fields.color')}
        </Text>
        <View style={styles.swatchRow}>
          {PLAYLIST_COLORS.map((swatch) => {
            const selected = color === swatch;
            return (
              <PressableSurface
                key={swatch}
                onPress={() => setColor(selected ? undefined : swatch)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[
                  styles.swatch,
                  // Hairline outline (theme-aware, so it can't live in the
                  // StyleSheet) keeps the dark swatches visible on the dark sheet.
                  // The selected style's 3px white border overrides it.
                  {
                    backgroundColor: swatch,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: systemColors.separator,
                  },
                  selected && styles.swatchSelected,
                ]}
              >
                {selected ? <Icon name="check.small" size={18} color={iosSystemColors.white} /> : null}
              </PressableSurface>
            );
          })}
        </View>

        {/* Emoji icon — a free-entry slot (system keyboard → any emoji) with a
            row of quick-pick suggestions. Shown for create + edit. */}
        <Text variant="footnote" style={styles.label}>
          {t('edit.fields.icon')}
        </Text>
        <View style={styles.iconRow}>
          <BottomSheetTextInput
            value={icon ?? ''}
            // Store the trimmed value (capped to a single glyph by maxLength); the
            // header preview mirrors it live. Empty clears back to the generic tag.
            onChangeText={(text) => {
              dismissSubmitError();
              const trimmed = text.trim();
              setIcon(trimmed.length > 0 ? trimmed : undefined);
            }}
            placeholder="🙂"
            placeholderTextColor={systemColors.tertiaryLabel}
            maxLength={ICON_MAX}
            textAlign="center"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="done"
            accessibilityLabel={t('edit.fields.icon')}
            style={[
              styles.emojiInput,
              { backgroundColor: systemColors.fill, borderColor: systemColors.separator, color: systemColors.label },
            ]}
          />
          {icon ? (
            <PressableSurface
              onPress={() => setIcon(undefined)}
              accessibilityRole="button"
              style={[styles.removeChip, { borderColor: systemColors.separator }]}
            >
              <Text variant="footnote" color={systemColors.error}>
                {t('edit.fields.removeIcon')}
              </Text>
            </PressableSurface>
          ) : null}
        </View>
        <Text variant="caption1" style={styles.iconHint}>
          {t('edit.fields.iconHint')}
        </Text>
        <View style={styles.swatchRow}>
          {SUGGESTED_ICONS.map((preset) => {
            const selected = icon === preset;
            return (
              <PressableSurface
                key={preset}
                onPress={() => setIcon(selected ? undefined : preset)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[
                  styles.emojiChip,
                  { backgroundColor: systemColors.fill },
                  // Selected border is a FOREGROUND → scheme-aware brand (the
                  // StyleSheet can't read the theme, so the colour is inline).
                  selected && [styles.emojiChipSelected, { borderColor: brandColors.primary }],
                ]}
              >
                <Text style={styles.emoji} allowFontScaling={false}>
                  {preset}
                </Text>
              </PressableSurface>
            );
          })}
        </View>

        {isEdit && !privacy.enabled ? (
          <View style={styles.switchWrap}>
            <SwitchRow
              label={t('edit.fields.visibility')}
              description={isPublic ? t('edit.fields.publicHint') : t('edit.fields.privateHint')}
              value={isPublic}
              onValueChange={setIsPublic}
            />
          </View>
        ) : null}
      </View>
    </ModalSheet>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    body: {
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
      paddingBottom: spacing[4],
      gap: spacing[2],
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      marginBottom: spacing[2],
    },
    label: {
      fontWeight: '600',
      opacity: 0.6,
      marginTop: spacing[2],
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: textStyles.callout.fontSize,
    },
    multiline: {
      minHeight: 80,
      textAlignVertical: 'top',
    },
    swatchRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing[3],
      marginTop: spacing[1],
    },
    iconRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      marginTop: spacing[1],
    },
    emojiInput: {
      width: 56,
      height: 56,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      fontSize: textStyles.title1.fontSize,
      paddingVertical: 0,
    },
    iconHint: {
      opacity: 0.5,
      marginTop: spacing[2],
    },
    swatch: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swatchSelected: {
      borderWidth: 3,
      borderColor: iosSystemColors.white,
    },
    emojiChip: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emojiChipSelected: {
      borderWidth: 2,
    },
    emoji: {
      fontSize: textStyles.title2.fontSize,
    },
    removeChip: {
      height: 40,
      paddingHorizontal: spacing[3],
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    switchWrap: {
      marginTop: spacing[2],
      marginHorizontal: -spacing[4],
    },
  });
