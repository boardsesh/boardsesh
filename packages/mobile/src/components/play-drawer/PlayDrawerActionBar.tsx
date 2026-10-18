import { PressableSurface } from '../PressableSurface';
import { memo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
import type { BleLightbulbLabelKind } from '../ble/ble-lightbulb-button-state';
import { LightbulbHolderBadge } from './LightbulbHolderBadge';
import { FirstConnectPill } from './FirstConnectPill';
import { PlayDrawerCommitBar } from './PlayDrawerCommitBar';
import type { CommitBarMode, CommitButtonLabel } from './wall-state';
import { resolveActionBarLayout, type ActionBarSecondaryItem } from './action-bar-layout';
import { DEFAULT_PLAYER_BUTTONS, type PlayerButtonsLayout } from '../../lib/player-buttons';
import { ActionButton, SIZES, type ButtonSize, drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { useTheme } from '../../providers/theme-provider';
// Aliased: foregrounds in this file read scheme-aware brand from `useTheme()`.
// `staticBrandColors` is the static set, used only for the count badge — a FILL
// with white text that must stay legible in both schemes.
import { brandColors as staticBrandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { useVariantValue } from '../../theme/variants';
import { hapticMedium, hapticSelection } from '../../lib/haptics';
import { COUNT_BADGE_MAX_FONT_SCALE, countBadgeBox, countBadgeText } from '../count-badge-style';

type PlayDrawerActionBarProps = {
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  isMirrored: boolean;
  supportsMirroring: boolean;
  isFavorited: boolean;
  remainingQueueCount: number;
  /** Filled/lit visual — OR'd in the parent (this device's BLE, a board-presence
   *  holder, or the session wall-lit signal). Visual only. */
  lightbulbActive: boolean;
  /** Whether THIS device's BLE link is connected. Drives the tap action's
   *  meaning, so it also drives the accessibility label + selected state:
   *  connected → tapping disconnects ("turn off"); not connected → tapping
   *  connects ("connect board"). Distinct from `lightbulbActive`, which a peer
   *  can light. */
  lightbulbConnected: boolean;
  lightbulbPending?: boolean;
  autoDisconnectWarning?: boolean;
  lightbulbAccessibilityLabel?: string;
  /**
   * Which sentence the bulb's label carries, resolved from what a tap actually
   * does (`getBleLightbulbLabelKind`). Defaults to the old connected/not-connected
   * split for callers that don't pass it.
   */
  lightbulbLabelKind?: BleLightbulbLabelKind;
  lightbulbLongPressAccessibilityHint?: string;
  lightbulbLongPressEnabled?: boolean;
  /**
   * Whether the host platform has a Bluetooth provider at all. Only that — an
   * anonymous viewer never gets the bulb regardless, and that rule lives here
   * rather than at the call site (see `viewer`).
   */
  showLightbulb?: boolean;
  /**
   * The connect-step test's treatment (#5654, PR 7): the bulb leaves the first
   * row and comes back as a labelled "Light it on the board" pill at the right
   * end of the second row. Share (and the queue, on a mirror board) moves into
   * the top row's ⋯, the heart and angle stay, and the tick keeps the hero slot.
   * The host decides it (`useFirstConnectPill`); commit mode and an anonymous
   * viewer still win here, like every other row rule (`resolveActionBarLayout`).
   */
  connectPill?: boolean;
  /**
   * The pill's tap. Separate from `onLightbulb` so a connect from the pill is
   * logged as the pill's (Board Connect Tapped `first_connect_pill`), not the
   * bare bulb's. Falls back to `onLightbulb`.
   */
  onConnectPill?: () => void;
  /** Show the holder avatar pip on the lightbulb. Suppressed when the wall-state
   *  pill already carries the driver's face in the header, so the same face never
   *  appears twice in the drawer (see `shouldShowHolderBadge` in wall-state.ts). */
  showHolderBadge?: boolean;
  /**
   * What the SECOND row is doing. `'commit'` swaps the utilities (heart, angle,
   * share, and the queue on a mirror board) for the browse latch's own controls —
   * same 64pt row, no added height. Resolved by `resolveCommitBarModel`; an
   * anonymous viewer is forced back to `'actions'` here, alongside the rest of the
   * `viewer` rules.
   */
  secondaryMode?: CommitBarMode;
  /** Commit-mode only: leave the latch and go back to the committed climb. */
  showBackToLive?: boolean;
  /** Commit-mode only: hidden when the displayed climb is already the lit one. */
  showPutOnWall?: boolean;
  /** Commit-mode only: someone moved the wall mid-browse, so the pair swaps to
   *  Keep theirs / Put mine up and the question floats above the row. */
  showConfirm?: boolean;
  /** Commit-mode only: the lit climb's name, for the confirm's question. */
  wallClimbName?: string | null;
  /** Commit-mode only: "Put on the wall" vs "Set active" where no wall is reachable. */
  commitLabel?: CommitButtonLabel;
  onBackToLive?: () => void;
  onCommit?: () => void;
  ascentCount: number;
  currentAngle?: number;
  /**
   * Who is looking.
   *
   * `'anonymous'` is the signed-out reader on the web export's read-only climb
   * view (`AnonymousClimbView`). Every affordance that writes is REMOVED rather
   * than disabled — a dead button a visitor taps and nothing happens is worse
   * than the login wall this view replaced — and the tick becomes the one
   * conversion prompt in the bar.
   *
   * Two of the removals are about navigation, not writes: the drawer is rendered
   * IN PLACE on the canonical `/…/view/{segment}` URL, and the anonymous gate
   * re-reads `window.location.pathname` on every navigation. Anything that
   * pushes a route outside the read-only allow-set (`/boards`, `/play`,
   * `/climbs/{uuid}`) bounces the visitor to login mid-session, so the queue
   * has to go whether or not its target would 401. (The player's ⋯ menu, in the
   * top row, is not rendered for them either.)
   */
  viewer?: 'member' | 'anonymous';
  /** Anonymous only: what the tick button does instead of opening the tick sheet. */
  onSignInPress?: () => void;
  onPrevClick: () => void;
  onNextClick: () => void;
  onMirror: () => void;
  onToggleFavorite: () => void;
  onLightbulb: () => void;
  onLightbulbLongPress?: () => void;
  onOpenQueue: () => void;
  /** Absent on a draft: only its setter can open it, so a link goes nowhere (#5960). */
  onShare?: () => void;
  onTickPress: () => void;
  onTickLongPress: () => void;
  onOpenAngleSelector?: () => void;
  /**
   * The climber's buttons from View options (#6229): order and switches.
   * `resolveActionBarLayout` decides what that means here, and ignores it for an
   * anonymous reader. Defaults to today's bar.
   */
  buttons?: PlayerButtonsLayout;
  /** The Previous and next switch. Off leaves both slots empty, so Log stays centred. */
  previousNext?: boolean;
  /**
   * The edge that faces the board, where the hairline goes: `top` under the
   * board (where the bar has always been), `bottom` when the controls sit above it.
   */
  edge?: 'top' | 'bottom';
};

export const PlayDrawerActionBar = memo(function PlayDrawerActionBar({
  canSwipePrevious,
  canSwipeNext,
  isMirrored,
  supportsMirroring,
  isFavorited,
  remainingQueueCount,
  lightbulbActive,
  lightbulbConnected,
  lightbulbPending = false,
  autoDisconnectWarning = false,
  lightbulbAccessibilityLabel,
  lightbulbLabelKind,
  lightbulbLongPressAccessibilityHint,
  lightbulbLongPressEnabled = lightbulbActive,
  showLightbulb = true,
  connectPill = false,
  onConnectPill,
  showHolderBadge = true,
  secondaryMode = 'actions',
  showBackToLive = false,
  showPutOnWall = false,
  showConfirm = false,
  wallClimbName = null,
  commitLabel = 'putOnWall',
  onBackToLive,
  onCommit,
  ascentCount,
  currentAngle,
  viewer = 'member',
  onSignInPress,
  onPrevClick,
  onNextClick,
  onMirror,
  onToggleFavorite,
  onLightbulb,
  onLightbulbLongPress,
  onOpenQueue,
  onShare,
  onTickPress,
  onTickLongPress,
  onOpenAngleSelector,
  buttons = DEFAULT_PLAYER_BUTTONS,
  previousNext = true,
  edge = 'top',
}: PlayDrawerActionBarProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { t: tSettings } = useTranslation('settings');
  const theme = useTheme();
  // What the bulb says it does. Resolved here rather than inline in the JSX so
  // the four cases read as four cases. Callers that don't pass a kind fall back
  // to the old connected/not-connected split.
  const resolvedLabelKind = lightbulbLabelKind ?? (lightbulbConnected ? 'disconnect' : 'connect');
  const lightbulbLabel =
    resolvedLabelKind === 'releaseWall'
      ? tSettings('ble.releaseWall')
      : resolvedLabelKind === 'takeWall'
        ? tSettings('ble.takeWall')
        : resolvedLabelKind === 'relay'
          ? tSettings('ble.relayToWall')
          : resolvedLabelKind === 'peerDriving'
            ? tSettings('ble.peerDrivingBoard')
            : resolvedLabelKind === 'disconnect'
              ? tSettings('ble.turnOff')
              : tSettings('ble.connectBoard');
  const isAnonymous = viewer === 'anonymous';
  // A signed-out reader has no queue to commit into and no wall to take, so the
  // suppression lives here with the rest of the `viewer` rules rather than only
  // in the resolver — the same shape as `showLightbulb` above.
  const inCommitMode = secondaryMode === 'commit' && !isAnonymous && onBackToLive != null && onCommit != null;
  // Which button sits where. The host resolves the same layout to learn which
  // buttons ⋯ has to stand in for, so both read one rule.
  const layout = resolveActionBarLayout({
    supportsMirroring,
    isAnonymous,
    connectPill,
    inCommitMode,
    showLightbulb,
    hasShare: onShare != null,
    angleAvailable: onOpenAngleSelector != null && currentAngle != null,
    buttons,
    previousNext,
  });
  // No second row at all: the climber switched every small button off, and
  // neither the commit bar nor the connect pill wants the row.
  const hasSecondaryRow = layout.secondaryRow === 'commit' || layout.secondaryRow.length > 0;

  // Haptics follow HIG "Playing haptics": plain buttons (prev / next / share /
  // sign in / angle) get none — the press itself is the feedback. The two
  // toggles get a selection tick. Outcomes (a save, a failure) buzz through the
  // toast that reports them, not here.
  const handleSignIn = useCallback(() => onSignInPress?.(), [onSignInPress]);

  const handleMirror = useCallback(() => {
    hapticSelection();
    onMirror();
  }, [onMirror]);

  const handleFavorite = useCallback(() => {
    hapticSelection();
    onToggleFavorite();
  }, [onToggleFavorite]);

  return (
    <View
      testID="play-drawer-action-bar"
      style={
        edge === 'top'
          ? [drawerActionBarStyles.container, { borderTopColor: theme.systemColors.separator }]
          : [styles.containerAbove, { borderBottomColor: theme.systemColors.separator }]
      }
    >
      <View style={[drawerActionBarStyles.rowPrimary, !hasSecondaryRow && styles.rowPrimaryAlone]}>
        {/* Mirror, or the queue where a board can't mirror: the list ⏮ and ⏭
            walk, and up here it survives commit mode and the connect pill. An
            anonymous reader has no queue, so on a board without mirror the slot
            stays empty and the row keeps its five-slot spacing either way. */}
        <View style={drawerActionBarStyles.primarySlot}>
          {layout.leadingSlot === 'mirror' ? (
            <ActionButton
              size="lg"
              iconName="mirror"
              onPress={handleMirror}
              active={isMirrored}
              activeColor={theme.brandColors.primary}
              accessibilityLabel={
                isMirrored ? t('playView.actionBar.unmirrorAria') : t('playView.actionBar.mirrorAria')
              }
            />
          ) : layout.leadingSlot === 'queue' ? (
            <QueueButton size="lg" remainingCount={remainingQueueCount} onPress={onOpenQueue} />
          ) : null}
        </View>
        {/* Previous and next switched off leaves both slots standing empty,
            so Log keeps the middle. Swiping the board still moves. */}
        <View style={drawerActionBarStyles.primarySlot}>
          {layout.showPreviousNext ? (
            <ActionButton
              size="lg"
              iconName="skip.previous"
              onPress={onPrevClick}
              disabled={!canSwipePrevious}
              accessibilityLabel={t('playView.actionBar.previousAria')}
            />
          ) : null}
        </View>
        <View style={drawerActionBarStyles.primarySlot}>
          {/* The one prompt in the anonymous bar. It stays the hero slot and
              keeps its glyph — a visitor who came to log a send should not have
              to hunt for the way in — but it opens login carrying this URL
              instead of the tick sheet, and drops the ascent badge, which counts
              a logbook they do not have. */}
          <TickButton
            size="lg"
            ascentCount={isAnonymous ? 0 : ascentCount}
            onPress={isAnonymous ? handleSignIn : onTickPress}
            onLongPress={isAnonymous ? undefined : onTickLongPress}
            accessibilityLabel={isAnonymous ? t('mobile.anonymous.tickAria') : t('playView.tickFab.logAscentAria')}
          />
        </View>
        <View style={drawerActionBarStyles.primarySlot}>
          {layout.showPreviousNext ? (
            <ActionButton
              size="lg"
              iconName="skip.next"
              onPress={onNextClick}
              disabled={!canSwipeNext}
              accessibilityLabel={t('playView.actionBar.nextAria')}
            />
          ) : null}
        </View>
        <View style={drawerActionBarStyles.primarySlot}>
          {/* With the connect pill up, this slot stays empty: the bulb is the
              pill in the row below, and the row keeps its five-slot spacing. */}
          {layout.trailingSlot === 'lightbulb' ? (
            <>
              <BleLightbulbButton
                isConnected={lightbulbActive}
                accessibilitySelected={lightbulbConnected}
                isScanning={lightbulbPending}
                autoDisconnectWarning={autoDisconnectWarning}
                onPress={onLightbulb}
                onLongPress={lightbulbLongPressEnabled ? onLightbulbLongPress : undefined}
                accessibilityLabel={lightbulbAccessibilityLabel ?? lightbulbLabel}
                scanningAccessibilityHint={tSettings('ble.scanning')}
                writingAccessibilityHint={tSettings('ble.writing')}
                longPressAccessibilityHint={
                  lightbulbLongPressEnabled
                    ? (lightbulbLongPressAccessibilityHint ?? tSettings('ble.holdForControls'))
                    : undefined
                }
                haptic="medium"
                size={SIZES.lg.icon}
                containerSize={SIZES.lg.dim}
              />
              {/* "Who's connected" pip — the board-presence holder's avatar overlaid
                  on the lightbulb's top-right. Self-reads board presence and renders
                  nothing when the wall is free, so it never disturbs the slot's layout.
                  Suppressed when the on-wall banner already shows the driver in the
                  header, so the same face never appears twice in the drawer. */}
              {showHolderBadge ? (
                <View style={styles.connectionBadge} pointerEvents="none">
                  <LightbulbHolderBadge size={18} />
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      </View>

      {/* Commit mode paints the row's own faint violet track edge-to-edge — a
          bottom "mode strip" that pairs with the header pill up top, and still
          0pt: it's a background on a row that already exists. With every small
          button switched off the row goes, and commit mode or the connect pill
          brings it back. */}
      {hasSecondaryRow ? (
        <View
          style={[
            drawerActionBarStyles.rowSecondary,
            styles.rowSecondaryHeight,
            inCommitMode && { backgroundColor: theme.systemColors.fill },
          ]}
        >
          {/* `inCommitMode` already needs both handlers; restated so TS sees them. */}
          {layout.secondaryRow === 'commit' && onBackToLive && onCommit ? (
            <PlayDrawerCommitBar
              showBackToLive={showBackToLive}
              showPutOnWall={showPutOnWall}
              showConfirm={showConfirm}
              wallClimbName={wallClimbName}
              commitLabel={commitLabel}
              onBackToLive={onBackToLive}
              onCommit={onCommit}
            />
          ) : layout.secondaryRow === 'commit' ? null : (
            layout.secondaryRow.map((item: ActionBarSecondaryItem) => {
              switch (item) {
                case 'mirror':
                  return (
                    <ActionButton
                      key={item}
                      size="sm"
                      iconName="mirror"
                      onPress={handleMirror}
                      active={isMirrored}
                      activeColor={theme.brandColors.primary}
                      accessibilityLabel={
                        isMirrored ? t('playView.actionBar.unmirrorAria') : t('playView.actionBar.mirrorAria')
                      }
                    />
                  );
                case 'favorite':
                  return <FavoriteButton key={item} size="sm" isFavorited={isFavorited} onPress={handleFavorite} />;
                case 'angle':
                  return onOpenAngleSelector && currentAngle != null ? (
                    <PressableSurface
                      key={item}
                      onPress={onOpenAngleSelector}
                      accessibilityRole="button"
                      accessibilityLabel={t('mobile.angleSelector.title')}
                      // A label-only mini pill (32pt); hit-slop lifts the tap target back to
                      // the 44pt floor without growing the visual chip.
                      hitSlop={8}
                      style={({ pressed }) => [
                        styles.anglePill,
                        { borderColor: theme.systemColors.separator },
                        pressed && drawerActionBarStyles.actionButtonPressed,
                      ]}
                    >
                      <Text variant="caption1" color={theme.systemColors.secondaryLabel} style={styles.angleText}>
                        {currentAngle}°
                      </Text>
                    </PressableSurface>
                  ) : null;
                case 'spacer':
                  return <View key={item} style={drawerActionBarStyles.spacer} />;
                case 'connectPill':
                  return (
                    <FirstConnectPill key={item} pending={lightbulbPending} onPress={onConnectPill ?? onLightbulb} />
                  );
                // Share is a pure client action and the whole point of a read-only
                // climb page, so an anonymous reader keeps it.
                case 'share':
                  return onShare ? (
                    <ShareButton
                      key={item}
                      size="sm"
                      onPress={onShare}
                      accessibilityLabel={tClimbs('mobile.climbRow.share')}
                    />
                  ) : null;
                case 'queue':
                  return (
                    <QueueButton key={item} size="sm" remainingCount={remainingQueueCount} onPress={onOpenQueue} />
                  );
              }
            })
          )}
        </View>
      ) : null}
    </View>
  );
});

type FavoriteButtonProps = {
  size: ButtonSize;
  isFavorited: boolean;
  onPress: () => void;
};

function FavoriteButton({ size, isFavorited, onPress }: FavoriteButtonProps) {
  const { t } = useTranslation('session');
  const { actionColors } = useTheme();
  return (
    <ActionButton
      size={size}
      iconName={isFavorited ? 'favorite.fill' : 'favorite'}
      onPress={onPress}
      iconColor={isFavorited ? actionColors.favoriteSelected : undefined}
      accessibilityLabel={
        isFavorited ? t('playView.actionBar.removeFavoriteAria') : t('playView.actionBar.addFavoriteAria')
      }
    />
  );
}

type QueueButtonProps = {
  size: ButtonSize;
  /** Climbs a forward swipe can still reach; spoken, never drawn. */
  remainingCount: number;
  onPress: () => void;
};

// A queue means nothing without a wall or a session, and the sheet it opens is
// a write surface, so an anonymous reader never gets one (see `viewer`).
function QueueButton({ size, remainingCount, onPress }: QueueButtonProps) {
  const { t } = useTranslation('session');
  return (
    <ActionButton
      size={size}
      iconName="queue"
      onPress={onPress}
      accessibilityLabel={t('playView.actionBar.queueCountAria', { count: remainingCount })}
    />
  );
}

type ShareButtonProps = {
  size: ButtonSize;
  onPress: () => void;
  accessibilityLabel: string;
};

// The share glyph resolves to the native iOS share symbol (square.and.arrow.up) on
// iOS and the Material Design share icon on Android — Icon picks per platform from
// the shared icon-map.
function ShareButton({ size, onPress, accessibilityLabel }: ShareButtonProps) {
  const { dim, icon } = SIZES[size];
  const { systemColors } = useTheme();
  const shareColor = useVariantValue({ liquidGlass: systemColors.label, material: systemColors.secondaryLabel });
  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        drawerActionBarStyles.actionButton,
        { width: dim, height: dim, borderRadius: dim / 2 },
        pressed && drawerActionBarStyles.actionButtonPressed,
      ]}
    >
      <Icon maxFontSizeMultiplier={1} name="share" size={icon} color={shareColor} />
    </PressableSurface>
  );
}

type TickButtonProps = {
  size: ButtonSize;
  ascentCount: number;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
};

function TickButton({ size, ascentCount, onPress, onLongPress, accessibilityLabel }: TickButtonProps) {
  const { dim, icon } = SIZES[size];
  const theme = useTheme();
  const handleLongPress = useCallback(() => {
    if (!onLongPress) return;
    hapticMedium();
    onLongPress();
  }, [onLongPress]);

  return (
    <PressableSurface
      onPress={onPress}
      onLongPress={handleLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        drawerActionBarStyles.actionButton,
        { width: dim, height: dim, borderRadius: dim / 2 },
        pressed && drawerActionBarStyles.actionButtonPressed,
      ]}
    >
      {/* The primary log action: a green glyph on the glass sheet (colour on the
          icon, not a fill) — its hue and the count badge mark it as the hero. */}
      <Icon maxFontSizeMultiplier={1} name="tick.outline" size={icon} color={theme.brandColors.success} />
      {ascentCount > 0 && (
        <View style={styles.countBadge}>
          <Text
            variant="caption2"
            color={iosSystemColors.white}
            numeric
            maxFontSizeMultiplier={COUNT_BADGE_MAX_FONT_SCALE}
            style={styles.countText}
          >
            {ascentCount > 99 ? '99' : String(ascentCount)}
          </Text>
        </View>
      )}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  // Above the board the hairline moves to the edge that faces it.
  containerAbove: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // The first row closes the bar on its own, so it takes the second row's bottom padding.
  rowPrimaryAlone: {
    paddingBottom: spacing[3],
  },
  // The second row's usual 64pt (its padding plus one small button), held even
  // when a draft leaves it nothing to draw, so the board doesn't move.
  rowSecondaryHeight: {
    minHeight: spacing[2] + SIZES.sm.dim + spacing[3],
  },
  // Holder avatar overlaid on the lightbulb's top-right corner.
  connectionBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
  },
  // A neutral, label-only outlined capsule (no colour fill) — the mini inline tier.
  anglePill: {
    height: glassSize.mini,
    borderRadius: glassSize.mini / 2,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  angleText: {
    fontWeight: '600',
  },
  // caption2 (11pt) in a box that grows with the text (count-badge-style.ts).
  countBadge: {
    ...countBadgeBox,
    position: 'absolute',
    top: -3,
    right: -3,
    // FILL with white count text → static brand (see import note).
    backgroundColor: staticBrandColors.primary,
  },
  countText: countBadgeText,
});
