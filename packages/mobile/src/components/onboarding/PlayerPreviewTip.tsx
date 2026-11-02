// The one-shot preview-first card (2.7, brief B5): climbs open as a preview, Put
// on board lights one and drives the wall for a while, and what the frosted
// wall button means.
//
//   [💡 A tap opens a preview. Put on board lights it.        (×)]
//   [   Then you drive the wall: each climb you pick lights…   ]
//   [   [💡   You are driving the wall   (me)]   ← the real button  ]
//   [   The frost means you're driving the wall…                  ]
//   [   [Lighting settings]                         [Got it]       ]
//
// The player docks it as the first section under the board, above Logbook: its
// headline sits in the Logbook peek's slot, and the board never moves or shrinks
// for it ("Nothing over the climb"). It does not feed the first-screen maths.
//
// The middle is the REAL `WallControlButton`, drawn in its frosted driving look
// in this climb's hold colours (or the flat amber where there are no holds to
// frost), so the picture can never drift from the button the climber will see.
// It is a picture: no touches, hidden from screen readers (the copy carries its
// meaning), and left alone by Smart Invert.
//
// The host owns showing it once (`use-preview-first-tip.ts`); this draws it and
// says when it should go: Got it, close, Lighting settings, or a drive started.

import { memo, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PressableSurface } from '../PressableSurface';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useScreenReaderEnabled } from '../../hooks/use-screen-reader-enabled';
import { useProfile } from '../../lib/graphql/hooks';
import { withAlpha } from '../../theme/colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { WallControlButton } from '../play-drawer/WallControlButton';
import { resolveWallControl, type WallControlFace, type WallControlModel } from '../play-drawer/wall-control';
import { useDriveMode } from '../play-drawer/drive-mode-store';
import type { WallGlowInput } from '../play-drawer/use-wall-glow';
import {
  previewFirstTipRetiredByDrive,
  resolvePreviewFirstFrostLine,
  resolvePreviewFirstWindowLine,
  type PreviewFirstFrostLine,
  type PreviewFirstTipDrive,
  type PreviewFirstWindowLine,
} from '../../lib/onboarding/preview-first-tip';
import type { KeepLightingPlan } from '../../lib/keep-lighting';

/** Why the card went away. */
export type PlayerPreviewTipExit = 'got_it' | 'close' | 'settings' | 'drive';

/** The close target: iOS's 44 pt and Material's 48 dp minimum. */
const CLOSE_TARGET = Platform.OS === 'android' ? 48 : 44;
/** The buttons' floor on Android, where a small Compose button lands at 40 dp. */
const ACTION_MIN_HEIGHT = Platform.OS === 'android' ? 48 : 44;
/** From this font scale the two buttons stack, each the card's full width. */
export const PLAYER_PREVIEW_TIP_STACK_FONT_SCALE = 1.5;

const noop = () => {};

/**
 * The model of the button while this climber drives the wall: this phone holds
 * the board, the climb is lit and every pick lights. Built by the one rule
 * every view of the board control uses, so its label, face and frost are the
 * ones the player draws.
 */
export function buildDrivingSampleModel(selfFace: WallControlFace | null): WallControlModel {
  return resolveWallControl({
    commitButton: null,
    pressAction: 'disconnect',
    holderIsAuthoritative: false,
    localConnected: true,
    pending: false,
    displayedLit: true,
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace,
    crewFace: null,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    navigationCommits: false,
    driveMode: 'live',
  });
}

export type PlayerPreviewTipProps = {
  /** The climb on screen's lit holds, for the sample button's frost. */
  glow: WallGlowInput | null;
  /**
   * What Put on board's drive does here (`resolveKeepLightingPlan`, Stop
   * driving after), or null when it lights one climb: Right
   * away, or a session with In a session too off, or the swipe flag off.
   */
  keepLighting: KeepLightingPlan | null;
  /**
   * Always drive the wall drives here (`alwaysDriveApplies`): this phone drives
   * with no end once it holds the board, so the card promises driving until
   * the climber stops, whatever Stop driving after says.
   */
  alwaysDrive?: boolean;
  /** The card should go, and why. */
  onExit: (exit: PlayerPreviewTipExit) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
};

function PlayerPreviewTipComponent({
  glow,
  keepLighting,
  alwaysDrive = false,
  onExit,
  onLayout,
}: PlayerPreviewTipProps) {
  const { t } = useTranslation('common');
  const { brandColors, systemColors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const screenReaderEnabled = useScreenReaderEnabled();
  const stacked = fontScale >= PLAYER_PREVIEW_TIP_STACK_FONT_SCALE;

  const windowLine = resolvePreviewFirstWindowLine({ plan: keepLighting, alwaysDrive });

  // A drive that starts while the card is up means the frost has been learned:
  // a swipe, Light every climb, the board sheet's row, or Put on board where it
  // drives until stopped (Until I stop). Put on board's timed
  // drive (one with `windowMs`) is what the card describes, so it stays for
  // that until a swipe or Light every climb makes the same drive open-ended.
  const drive = useDriveMode();
  const shownAtRef = useRef(Date.now());
  const driveStartedAt = drive?.startedAt ?? null;
  const driveOpenEnded = drive !== null && drive.windowMs === null;
  const seenDriveRef = useRef<PreviewFirstTipDrive | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  useEffect(() => {
    const current = driveStartedAt === null ? null : { startedAt: driveStartedAt, openEnded: driveOpenEnded };
    const previous = seenDriveRef.current;
    seenDriveRef.current = current;
    if (previewFirstTipRetiredByDrive({ drive: current, previous, shownAt: shownAtRef.current })) {
      onExitRef.current('drive');
    }
  }, [driveStartedAt, driveOpenEnded]);

  // This climber's face at the trailing edge, as the button shows it while they
  // hold the board. The player asks for the same profile while linked, so this
  // is usually a cache read.
  const { data: profile } = useProfile();
  const selfFace = useMemo<WallControlFace | null>(
    () => (profile ? { name: profile.displayName ?? null, avatarUrl: profile.avatarUrl ?? null } : null),
    [profile],
  );
  const sampleModel = useMemo(() => buildDrivingSampleModel(selfFace), [selfFace]);
  const windowText = previewFirstWindowText(windowLine, t);
  // The clock and the shrinking frost only where Put on board's drive has one.
  const frostText = previewFirstFrostText(
    resolvePreviewFirstFrostLine({ plan: keepLighting, alwaysDrive }),
    screenReaderEnabled,
    t,
  );

  return (
    <View
      testID="player-preview-tip"
      onLayout={onLayout}
      style={[
        styles.surface,
        {
          backgroundColor: withAlpha(brandColors.primary, 0.08),
          borderColor: withAlpha(brandColors.primary, 0.2),
        },
      ]}
    >
      <View style={styles.headerRow}>
        {/* Brand violet: amber is kept for lit LEDs. */}
        <Icon name="lightbulb.fill" size={20} color={brandColors.primary} />
        <Text variant="headline" color={systemColors.label} accessibilityRole="header" style={styles.flex}>
          {t('mobile.onboarding.tips.previewFirst.title')}
        </Text>
        <PressableSurface
          testID="player-preview-tip-close"
          onPress={() => onExit('close')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.onboarding.tips.previewFirst.close')}
          style={styles.close}
        >
          <Icon name="close" size={16} color={systemColors.secondaryLabel} />
        </PressableSurface>
      </View>
      {windowText ? (
        <Text variant="subheadline" color={systemColors.label} testID="player-preview-tip-window">
          {windowText}
        </Text>
      ) : null}
      <View
        testID="player-preview-tip-sample"
        style={styles.sample}
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        accessibilityIgnoresInvertColors
      >
        <WallControlButton model={sampleModel} glow={glow} onPress={noop} onLongPress={noop} sample />
      </View>
      <Text variant="subheadline" color={systemColors.label} testID="player-preview-tip-frost">
        {frostText}
      </Text>
      <View style={[styles.actions, stacked && styles.actionsStacked]}>
        <Button
          testID="player-preview-tip-settings"
          title={t('mobile.onboarding.tips.previewFirst.settings')}
          variant="text"
          size="small"
          minHeight={ACTION_MIN_HEIGHT}
          ignoreContainerSafeArea
          onPress={() => onExit('settings')}
          style={stacked ? styles.actionStacked : undefined}
        />
        <Button
          testID="player-preview-tip-done"
          title={t('mobile.onboarding.tips.previewFirst.done')}
          variant="tonal"
          size="small"
          minHeight={ACTION_MIN_HEIGHT}
          ignoreContainerSafeArea
          onPress={() => onExit('got_it')}
          style={stacked ? styles.actionStacked : undefined}
        />
      </View>
    </View>
  );
}

export const PlayerPreviewTip = memo(PlayerPreviewTipComponent);

/** The card's second line in words, each key spelled out so the catalog checks see it. */
function previewFirstWindowText(line: PreviewFirstWindowLine, t: TFunction): string | null {
  if (line === null) return null;
  switch (line.key) {
    case 'windowSeconds':
      return t('mobile.onboarding.tips.previewFirst.windowSeconds', { seconds: line.seconds });
    case 'windowMinute':
      return t('mobile.onboarding.tips.previewFirst.windowMinute');
    case 'windowMinutes':
      return t('mobile.onboarding.tips.previewFirst.windowMinutes', { minutes: line.minutes });
    case 'untilStop':
      return t('mobile.onboarding.tips.previewFirst.untilStop');
  }
}

/**
 * The frost sentence. A screen reader can't see the glow or make the swipe, so
 * its form names the label and the action that needs no gesture instead.
 */
function previewFirstFrostText(line: PreviewFirstFrostLine, screenReader: boolean, t: TFunction): string {
  if (line === 'timed') {
    return screenReader
      ? t('mobile.onboarding.tips.previewFirst.frostScreenReader')
      : t('mobile.onboarding.tips.previewFirst.frost');
  }
  return screenReader
    ? t('mobile.onboarding.tips.previewFirst.frostOpenEndedScreenReader')
    : t('mobile.onboarding.tips.previewFirst.frostOpenEnded');
}

const styles = StyleSheet.create({
  surface: {
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  flex: {
    flex: 1,
  },
  // A 44 pt / 48 dp target drawn around the 16 pt glyph, pulled into the card's
  // corner so the glyph lines up with the headline's first line.
  close: {
    minWidth: CLOSE_TARGET,
    minHeight: CLOSE_TARGET,
    marginTop: -spacing[3],
    marginEnd: -spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
  sample: {
    flexDirection: 'row',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing[2],
  },
  actionsStacked: {
    flexDirection: 'column-reverse',
    alignItems: 'stretch',
  },
  actionStacked: {
    alignSelf: 'stretch',
  },
});
