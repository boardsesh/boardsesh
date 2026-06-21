import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  View,
  ScrollView,
  TextInput,
  StyleSheet,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDeviceLocation } from '../../lib/use-device-location';
import type { useBoardBuilder } from './use-board-builder';
import { BoardConfigChips } from './BoardConfigChips';
import { boardTypeLabel, cleanLayoutName, formatSizeLabel } from './board-builder-labels';
import { BoardImageNative } from '../BoardImageNative';
import { getBoardRenderData } from '../../lib/board-details';
import { AngleSlider } from '../play-drawer/AngleSlider';
import { AngleBoardDiagram } from '../play-drawer/AngleBoardDiagram';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { spacing, borderRadius } from '../../theme/tokens';

const PREVIEW_MAX_HEIGHT = 260;

type BoardBuilder = ReturnType<typeof useBoardBuilder>;

type BoardFormProps = {
  builder: BoardBuilder;
  /** Auto-generated name, used as the name placeholder + create/update fallback. */
  defaultName: string;
  submitting: boolean;
  onSubmit: () => void;
  submitLabel: string;
  /**
   * Lock the board/layout/size/set chips (editing a board that already has
   * ticks — the server rejects config changes on those). Shows a hint.
   */
  lockedConfig?: boolean;
};

/**
 * The board builder form — preview art, the board → layout → size → sets cascade,
 * angle picker, name, and a "More options" section (ownership, visibility,
 * location, serial), with a pinned primary action. Shared by the create and edit
 * screens; the only difference between them is the submit handler/label and
 * whether the config chips are locked. Owns its own location-permission flow.
 */
export function BoardForm({
  builder,
  defaultName,
  submitting,
  onSubmit,
  submitLabel,
  lockedConfig = false,
}: BoardFormProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();
  const { width: windowWidth } = useWindowDimensions();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const { setCoords } = builder;
  const location = useDeviceLocation();
  const requestLocation = location.request;
  const onUseMyLocation = useCallback(() => void requestLocation(), [requestLocation]);
  useEffect(() => {
    // location.coords stays null until the user taps "Use my location" (request
    // is explicit), so this only stamps coords once they've opted in.
    if (location.coords) setCoords(location.coords);
  }, [location.coords, setCoords]);

  // Chip options — memoised so the per-snap angle re-render doesn't rebuild them
  // (they don't depend on angle), letting the memoised chip rows bail out.
  const boardOptions = useMemo(
    () =>
      SUPPORTED_BOARDS.map((board) => ({
        key: board,
        label: boardTypeLabel(board),
        value: board,
        selected: board === builder.boardName,
      })),
    [builder.boardName],
  );
  const layoutOptions = useMemo(
    () =>
      builder.layouts.map((layout) => ({
        key: layout.id,
        label: cleanLayoutName(layout.name, builder.boardName),
        value: layout.id,
        selected: layout.id === builder.layoutId,
      })),
    [builder.layouts, builder.boardName, builder.layoutId],
  );
  const sizeOptions = useMemo(
    () =>
      builder.sizes.map((size) => ({
        key: size.id,
        label: formatSizeLabel(size),
        value: size.id,
        selected: size.id === builder.sizeId,
      })),
    [builder.sizes, builder.sizeId],
  );
  const setOptions = useMemo(
    () =>
      builder.sets.map((set) => ({
        key: set.id,
        label: set.name,
        value: set.id,
        selected: builder.setIds.includes(set.id),
      })),
    [builder.sets, builder.setIds],
  );

  const showPreview = builder.layoutId != null && builder.sizeId != null && builder.setIds.length > 0;
  const setIdsWire = builder.setIds.join(',');
  // Account for both the scroll content padding and the preview tile's padding.
  const previewMaxWidth = windowWidth - (spacing[4] + spacing[3]) * 2;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: bottomChrome.scrollBottomPadding + spacing[16] }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Live board art — turns layout/size/set IDs into a recognizable wall. */}
        <View style={[styles.preview, { backgroundColor: systemColors.secondaryBackground }]}>
          {showPreview ? (
            <BoardConfigPreview
              boardName={builder.boardName}
              layoutId={builder.layoutId!}
              sizeId={builder.sizeId!}
              setIds={setIdsWire}
              maxWidth={previewMaxWidth}
            />
          ) : (
            <View style={styles.previewPlaceholder}>
              <Icon name="boards" size={40} color={systemColors.tertiaryLabel} />
              <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.previewHint}>
                {t('mobile.create.previewHint')}
              </Text>
            </View>
          )}
        </View>

        {lockedConfig ? (
          <View style={[styles.lockedHint, { backgroundColor: systemColors.secondaryBackground }]}>
            <Icon name="info" size={16} color={systemColors.secondaryLabel} />
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.lockedHintText}>
              {t('mobile.edit.configLockedHint')}
            </Text>
          </View>
        ) : null}

        <SectionLabel>{t('mobile.custom.board')}</SectionLabel>
        <BoardConfigChips
          groupLabel={t('mobile.custom.board')}
          options={boardOptions}
          onSelect={builder.selectBoard}
          disabled={lockedConfig}
        />

        <SectionLabel>{t('mobile.custom.layout')}</SectionLabel>
        <BoardConfigChips
          groupLabel={t('mobile.custom.layout')}
          options={layoutOptions}
          onSelect={builder.selectLayout}
          disabled={lockedConfig}
        />

        {builder.sizes.length > 0 ? (
          <>
            <SectionLabel>{t('mobile.custom.size')}</SectionLabel>
            <BoardConfigChips
              groupLabel={t('mobile.custom.size')}
              options={sizeOptions}
              onSelect={builder.selectSize}
              disabled={lockedConfig}
            />
          </>
        ) : null}

        {builder.angles.length > 0 ? (
          <>
            <SectionLabel>{t('mobile.custom.angle')}</SectionLabel>
            {/* Teaching diagram: tilts the wall to the angle (+ degree readout),
                reused from the play drawer. */}
            <View style={styles.angleDiagram}>
              <AngleBoardDiagram
                angle={builder.angle}
                size={140}
                accessibilityLabel={t('mobile.create.anglePreview', { angle: builder.angle })}
              />
            </View>
            {/* Reuse the play-drawer angle picker for a consistent feel. */}
            <AngleSlider angles={builder.angles} value={builder.angle} onChange={builder.setAngle} />
            {/* Adjustability is a separate capability from the default angle, so
                it's a toggle (matching the other settings rows), not a chip. */}
            <SwitchRow
              label={t('mobile.create.adjustable')}
              value={builder.isAngleAdjustable}
              onValueChange={builder.setIsAngleAdjustable}
            />
          </>
        ) : null}

        {builder.layoutId != null ? (
          <>
            <SectionLabel>{t('mobile.custom.name')}</SectionLabel>
            <BuilderTextInput
              value={builder.name}
              onChangeText={builder.setName}
              placeholder={defaultName}
              accessibilityLabel={t('mobile.custom.name')}
              maxLength={100}
              returnKeyType="done"
            />
          </>
        ) : null}

        {/* Advanced — hold sets (default all), visibility, location, serial. */}
        <Pressable
          onPress={() => setAdvancedOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: advancedOpen }}
          style={styles.advancedHeader}
        >
          <Text variant="headline">{t('mobile.create.moreOptions')}</Text>
          <Icon name={advancedOpen ? 'chevron.up' : 'chevron.down'} size={18} color={systemColors.secondaryLabel} />
        </Pressable>

        {advancedOpen ? (
          <View style={styles.advancedBody}>
            {builder.sets.length > 0 ? (
              <>
                <SectionLabel>{t('mobile.custom.sets')}</SectionLabel>
                <BoardConfigChips
                  groupLabel={t('mobile.custom.sets')}
                  options={setOptions}
                  onSelect={builder.toggleSet}
                  disabled={lockedConfig}
                />
              </>
            ) : null}

            <SwitchRow label={t('mobile.create.ownBoard')} value={builder.isOwned} onValueChange={builder.setIsOwned} />
            <SwitchRow
              label={t('mobile.create.public')}
              description={t('mobile.create.publicHint')}
              value={builder.isPublic}
              onValueChange={builder.setIsPublic}
            />
            <SwitchRow
              label={t('mobile.create.unlisted')}
              value={builder.isUnlisted}
              onValueChange={builder.setIsUnlisted}
            />
            <SwitchRow
              label={t('mobile.create.hideLocation')}
              value={builder.hideLocation}
              onValueChange={builder.setHideLocation}
            />

            <SectionLabel>{t('mobile.create.location')}</SectionLabel>
            <BuilderTextInput
              value={builder.locationName}
              onChangeText={builder.setLocationName}
              placeholder={t('mobile.create.locationPlaceholder')}
              accessibilityLabel={t('mobile.create.location')}
              maxLength={120}
            />
            <Button
              title={builder.coords ? t('mobile.create.locationSet') : t('mobile.create.useMyLocation')}
              variant="text"
              onPress={onUseMyLocation}
              disabled={builder.coords != null}
            />

            <SectionLabel>{t('mobile.create.serial')}</SectionLabel>
            <BuilderTextInput
              value={builder.serialNumber}
              onChangeText={builder.setSerialNumber}
              placeholder={t('mobile.create.serialPlaceholder')}
              accessibilityLabel={t('mobile.create.serial')}
              autoCapitalize="characters"
              maxLength={100}
            />
            <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.serialHint}>
              {t('mobile.create.serialHint')}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Pinned, safe-area-aware primary action. */}
      <View
        style={[
          styles.footer,
          {
            backgroundColor: systemColors.secondaryBackground,
            borderTopColor: systemColors.separator,
            paddingBottom: insets.bottom + spacing[3],
          },
        ]}
      >
        <Button
          title={submitLabel}
          onPress={onSubmit}
          variant="filled"
          size="large"
          disabled={!builder.canCreate || submitting}
          loading={submitting}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function SectionLabel({ children }: { children: string }) {
  const { systemColors } = useTheme();
  return (
    <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
      {children}
    </Text>
  );
}

/** Themed text input for the builder's form fields (name / location / serial). */
function BuilderTextInput({ style, ...props }: ComponentProps<typeof TextInput>) {
  const { systemColors } = useTheme();
  return (
    <TextInput
      placeholderTextColor={systemColors.tertiaryLabel}
      {...props}
      style={[
        styles.input,
        {
          color: systemColors.label,
          borderColor: systemColors.separator,
          backgroundColor: systemColors.secondaryBackground,
        },
        style,
      ]}
    />
  );
}

/** The empty board art (no lit holds) at the config's native aspect ratio. */
function BoardConfigPreview({
  boardName,
  layoutId,
  sizeId,
  setIds,
  maxWidth,
}: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  maxWidth: number;
}) {
  const renderData = useMemo(() => {
    const setIdValues = setIds.split(',').map(Number).filter(Number.isFinite);
    if (setIdValues.length === 0) return null;
    return getBoardRenderData({ boardName, layoutId, sizeId, setIds: setIdValues });
  }, [boardName, layoutId, sizeId, setIds]);

  if (!renderData) return null;

  const aspect = renderData.boardWidth / renderData.boardHeight;
  let height = PREVIEW_MAX_HEIGHT;
  let width = height * aspect;
  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspect;
  }
  const boardStyle: ViewStyle = { width, height, borderRadius: borderRadius.lg, overflow: 'hidden' };

  return (
    // Decorative — the config is already conveyed by the chips, so hide the art
    // from screen readers rather than landing on an unlabeled image.
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <BoardImageNative
        frames=""
        boardName={boardName}
        layoutId={layoutId}
        sizeId={sizeId}
        setIds={setIds}
        boardWidth={renderData.boardWidth}
        boardHeight={renderData.boardHeight}
        renderWidth={Math.round(width)}
        style={boardStyle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    padding: spacing[4],
    gap: spacing[2],
  },
  preview: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: PREVIEW_MAX_HEIGHT,
    borderRadius: borderRadius.lg,
    padding: spacing[3],
    marginBottom: spacing[2],
  },
  previewPlaceholder: {
    alignItems: 'center',
    gap: spacing[2],
  },
  previewHint: {
    textAlign: 'center',
  },
  lockedHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: borderRadius.md,
  },
  lockedHintText: {
    flex: 1,
  },
  sectionLabel: {
    marginTop: spacing[3],
    marginBottom: spacing[1],
    textTransform: 'uppercase',
  },
  angleDiagram: {
    alignItems: 'center',
    paddingVertical: spacing[2],
  },
  input: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 17,
  },
  advancedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing[5],
    paddingVertical: spacing[2],
  },
  advancedBody: {
    gap: spacing[2],
  },
  serialHint: {
    marginTop: spacing[1],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
