import { useMemo, useState } from 'react';
import {
  View,
  ScrollView,
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
import { useForeignSerialBoard } from '../../lib/boards/use-foreign-serial-board';
import { serialReuseDisclosure } from '../../lib/boards/serial-reuse';
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
import { TimerPairingSheet } from '../ble/TimerPairingSheet';
import { GymPickerSheet } from './GymPickerSheet';
import { BoardIdentityFields, BoardVisibilityFields, BuilderTextInput, SectionLabel } from './BoardMetaFields';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

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
  /**
   * A submit failure, rendered inline above the action. The create/edit screens
   * are `presentation: 'modal'` routes and the toast overlay draws behind those,
   * so a toast here would never be seen (#4166) — feedback lives in the form.
   */
  errorMessage?: string | null;
  /**
   * The uuid of the board being edited, if any. Excluded from the serial-reuse
   * warning so editing your own board never warns about its own serial.
   */
  currentBoardUuid?: string;
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
  errorMessage = null,
  currentBoardUuid,
}: BoardFormProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  // Only warn on a same-config foreign board — cross-model serial reuse is
  // legitimate (see useForeignSerialBoard). Config is null until the form has
  // a complete layout/size/sets selection.
  const serialConflictConfig = useMemo(
    () =>
      builder.layoutId != null && builder.sizeId != null && builder.setIds.length > 0
        ? {
            boardType: builder.boardName,
            layoutId: builder.layoutId,
            sizeId: builder.sizeId,
            setIds: builder.setIds.join(','),
          }
        : null,
    [builder.boardName, builder.layoutId, builder.sizeId, builder.setIds],
  );
  const foreignSerialBoard = useForeignSerialBoard(builder.serialNumber, currentBoardUuid, serialConflictConfig);
  const foreignSerialDisclosure = foreignSerialBoard ? serialReuseDisclosure(foreignSerialBoard) : null;
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();
  const { width: windowWidth } = useWindowDimensions();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timerPairingOpen, setTimerPairingOpen] = useState(false);
  const [gymPickerOpen, setGymPickerOpen] = useState(false);

  // Chip options — memoised so the per-snap angle re-render doesn't rebuild them
  // (they don't depend on angle), letting the memoised chip rows bail out.
  // `SUPPORTED_BOARDS` already drops spray (`board-data.ts`): a wall is not a
  // catalogue board you pick a layout and a size for, it is a photograph you
  // take, and it gets its own front door in SW-09.
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

        {/* Gated the way the size and set rows below already are. Spray cannot be
            PICKED here, but an existing wall can still be opened for editing, and
            a wall has no catalogue layouts at all — its layout IS the wall — so
            without this it would show a "Layout" heading over an empty row. */}
        {builder.layouts.length > 0 ? (
          <>
            <SectionLabel>{t('mobile.custom.layout')}</SectionLabel>
            <BoardConfigChips
              groupLabel={t('mobile.custom.layout')}
              options={layoutOptions}
              onSelect={builder.selectLayout}
              disabled={lockedConfig}
            />
          </>
        ) : null}

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
          <BoardIdentityFields
            builder={builder}
            namePlaceholder={defaultName}
            onOpenGymPicker={() => setGymPickerOpen(true)}
          />
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
            <BoardVisibilityFields builder={builder} />

            {/* Lights heads the group the serial belongs to — both describe the
                LED hardware on the wall. Nothing below is hidden when the toggle
                goes off: buildUpdateInput submits the serial and timer from
                retained state either way, so hiding a field would be a silent
                submit trap, and the Rogue workout timer isn't an LED device. */}
            <SectionLabel>{t('mobile.create.lights')}</SectionLabel>
            <SwitchRow
              label={t('mobile.create.hasLeds')}
              description={t('mobile.create.hasLedsHint')}
              value={builder.hasLeds}
              onValueChange={builder.setHasLeds}
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

            <SectionLabel>{t('mobile.create.timer')}</SectionLabel>
            <View style={[styles.timerRow, { borderColor: systemColors.separator }]}>
              <Icon name="clock" size={20} color={systemColors.secondaryLabel} />
              <Text
                variant="body"
                color={builder.timerName ? systemColors.label : systemColors.tertiaryLabel}
                numberOfLines={1}
                style={styles.timerName}
              >
                {builder.timerName || t('mobile.create.timerNone')}
              </Text>
            </View>
            <View style={styles.timerActions}>
              <Button
                title={builder.timerName ? t('mobile.create.timerChangeCta') : t('mobile.create.timerPairCta')}
                variant="text"
                onPress={() => setTimerPairingOpen(true)}
              />
              {builder.timerName ? (
                <Button
                  title={t('mobile.create.timerRemoveCta')}
                  variant="text"
                  role="destructive"
                  onPress={() => builder.setTimerName('')}
                />
              ) : null}
            </View>
            <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.serialHint}>
              {t('mobile.create.timerHint')}
            </Text>

            {foreignSerialDisclosure ? (
              <View style={[styles.serialWarning, { borderColor: iosSystemColors.systemOrange }]}>
                <Icon name="info" size={16} color={iosSystemColors.systemOrange} />
                <Text variant="footnote" color={systemColors.label} style={styles.serialWarningText}>
                  {foreignSerialDisclosure.kind === 'public'
                    ? t('boardForm.serialReuse.warning', { name: foreignSerialDisclosure.board.name })
                    : t('boardForm.serialReuse.warningPrivate')}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {timerPairingOpen ? (
        <TimerPairingSheet
          onSelect={(timerName) => {
            builder.setTimerName(timerName);
            setTimerPairingOpen(false);
          }}
          onDismiss={() => setTimerPairingOpen(false)}
        />
      ) : null}

      {/* Presence-driven, like TimerPairingSheet — the two are never open at
          once and the sheet coordinator serialises them. A SIBLING of the
          ScrollView, never a child of it. */}
      {gymPickerOpen ? (
        <GymPickerSheet
          selectedUuid={builder.selectedGym?.uuid ?? null}
          boardCoords={builder.coords}
          onSelect={(gym) => {
            builder.setSelectedGym(gym);
            setGymPickerOpen(false);
          }}
          onRequestManualLocation={() => {
            builder.setSelectedGym(null);
            setGymPickerOpen(false);
            setAdvancedOpen(true);
          }}
          onDismiss={() => setGymPickerOpen(false)}
        />
      ) : null}

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
        {errorMessage ? (
          <Text
            variant="footnote"
            color={iosSystemColors.systemRed}
            style={styles.errorMessage}
            accessibilityLiveRegion="polite"
          >
            {errorMessage}
          </Text>
        ) : null}
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
  angleDiagram: {
    alignItems: 'center',
    paddingVertical: spacing[2],
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
  timerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  timerName: {
    flex: 1,
  },
  timerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  serialWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing[2],
  },
  serialWarningText: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  errorMessage: {
    marginBottom: spacing[2],
    textAlign: 'center',
  },
});
