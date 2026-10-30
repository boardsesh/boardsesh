import { PressableSurface } from '../PressableSurface';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { BusyWallQuestionGroup } from './BusyWallQuestionGroup';
import type { BusyWallQuestionModel } from './busy-wall-question';
import { WorkoutOutcomeRow } from './WorkoutOutcomeRow';
import { AnglePill } from './AnglePill';
import type { WorkoutOutcomeTarget } from './workout-outcome';
import { WALL_CONTROL_HEIGHT, WallControlButton } from './WallControlButton';
import { WallControlBulb } from './WallControlBulb';
import { EMPTY_WALL_CONTROL, type WallControlModel } from './wall-control';
import type { WallGlowInput } from './use-wall-glow';
import { resolveActionBarLayout, type ActionBarCommitButton } from './action-bar-layout';
import {
  DEFAULT_PLAYER_BUTTONS,
  type PlayerBoardControl,
  type PlayerButtonId,
  type PlayerButtonsLayout,
} from '../../lib/player-buttons';
import type { WallControlSurface } from '../../lib/analytics-wall-control';
import type { DriveStartOutcome } from './use-wall-control';
import { ActionButton, SIZES, type ButtonSize, drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { useTheme } from '../../providers/theme-provider';
// Aliased: foregrounds in this file read scheme-aware brand from `useTheme()`.
// `staticBrandColors` is the static set, used only for the count badge — a FILL
// with white text that must stay legible in both schemes.
import { brandColors as staticBrandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { useVariantValue } from '../../theme/variants';
import { hapticMedium, hapticSelection } from '../../lib/haptics';
import { COUNT_BADGE_MAX_FONT_SCALE, countBadgeBox, countBadgeText, formatCountBadge } from '../count-badge-style';

/**
 * The second row's height: its padding plus the wall button (or, for the
 * signed-out reader, one small button), whichever is taller. Held in every
 * state, so the board never moves.
 */
export const ACTION_BAR_SECONDARY_ROW_HEIGHT = spacing[2] + Math.max(SIZES.sm.dim, WALL_CONTROL_HEIGHT) + spacing[3];

type PlayDrawerActionBarProps = {
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  isMirrored: boolean;
  supportsMirroring: boolean;
  isFavorited: boolean;
  remainingQueueCount: number;
  /**
   * Up next while the player walks a list (#6238), when Next plays the list and
   * not the queue: badged on the queue button and spoken in its label. Zero
   * draws no badge but still speaks Up next; null (no list walked) keeps the
   * plain queue label.
   */
  upNextBadgeCount?: number | null;
  /**
   * The board control's model (`resolveWallControl`): what the wall button and
   * the bulb draw. Both views draw only this, so they can't disagree.
   */
  wallControl?: WallControlModel;
  /** A tap on one view of the board control; the host's `useWallControl` runs it. */
  onWallControlPress?: (control: WallControlSurface) => void;
  /** A hold on one view of the board control: the board sheet, while this phone holds the link. */
  onWallControlLongPress?: (control: WallControlSurface) => void;
  /** Start driving the wall from the wall button's "Light every climb" action (#7113). */
  onWallControlDrive?: (control: WallControlSurface) => DriveStartOutcome;
  /**
   * The wall button's swipe left to drive (#7113): let go past the commit
   * point. Omitted (the `wall-swipe-to-drive` flag off), the button offers no swipe.
   */
  onWallControlSwipe?: (control: WallControlSurface) => DriveStartOutcome;
  /** The swipe let go short of the commit point. */
  onWallControlSwipeCancel?: (control: WallControlSurface) => void;
  /** View options › Buttons › Board control: the wall button (the default) or the bulb. */
  boardControl?: PlayerBoardControl;
  /** The lit wall button's glow (F1b): the climb's lit holds, while it is lit. */
  wallGlow?: WallGlowInput | null;
  /**
   * The MiniPlayer beside the player stands in for its first row (#7000: the
   * open Duo's pane, a tablet's player route; `playerMirroredByMiniPlayer`).
   */
  miniPlayerMirrors?: boolean;
  /**
   * Whether the host platform has a Bluetooth provider at all. Only that — an
   * anonymous viewer never gets the bulb regardless, and that rule lives here
   * rather than at the call site (see `viewer`).
   */
  showLightbulb?: boolean;
  /** A wall with lights to put a climb on; without one the wall button's row folds (`resolveActionBarLayout`). */
  hasWall?: boolean;
  /**
   * Show the holder's face on the bulb. Suppressed while the header's back chip
   * carries the driver's face, so the same face never appears twice in the
   * drawer (see `shouldShowHolderBadge` in wall-state.ts).
   */
  showHolderBadge?: boolean;
  /**
   * The browse latch's control. `putOnWall` is one of the wall button's states;
   * `confirm` (someone else moved the wall while you looked around) swaps the
   * wall button for Keep theirs / Put mine up. Resolved from
   * `resolveCommitBarModel`; an anonymous viewer never gets either, alongside
   * the rest of the `viewer` rules.
   */
  commitButton?: ActionBarCommitButton;
  /**
   * The climb up is in a timed workout block (#6231): the second row becomes
   * one-tap Fell / Sent for it. Resolved by the host (`shouldShowWorkoutOutcome`);
   * the browse latch's controls and an anonymous viewer still win here.
   */
  workoutOutcome?: WorkoutOutcomeTarget | null;
  /**
   * Set while the host holds Fell / Sent for a climb the wall just left
   * (`useWorkoutOutcomeHold`): when it left. Null while `workoutOutcome` is the
   * climb on the wall.
   */
  workoutOutcomeWallLeftAtMs?: number | null;
  /** Confirm only: the busy-wall question's model (`useBusyWallQuestion`). */
  busyWall?: BusyWallQuestionModel | null;
  /** Confirm only: leave their climb up. Debounced by `useBusyWallQuestion`. */
  onKeepTheirs?: () => void;
  /** Confirm only: Put mine up. Debounced by `useBusyWallQuestion`. */
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
  onOpenQueue: () => void;
  /** Absent on a draft: only its setter can open it, so a link goes nowhere (#5960). */
  onShare?: () => void;
  onTickPress: () => void;
  onTickLongPress: () => void;
  onOpenAngleSelector?: () => void;
  /**
   * The climber's buttons from View options (#6229, #7000): order and switches.
   * `resolveActionBarLayout` decides which fill the first row's ends, and
   * ignores them for an anonymous reader. Defaults to Marco's bar.
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
  upNextBadgeCount = null,
  wallControl = EMPTY_WALL_CONTROL,
  onWallControlPress,
  onWallControlLongPress,
  onWallControlDrive,
  onWallControlSwipe,
  onWallControlSwipeCancel,
  boardControl = 'wallButton',
  wallGlow = null,
  miniPlayerMirrors = false,
  showLightbulb = true,
  hasWall = true,
  showHolderBadge = true,
  commitButton = null,
  workoutOutcome = null,
  workoutOutcomeWallLeftAtMs = null,
  busyWall = null,
  onKeepTheirs,
  onCommit,
  ascentCount,
  currentAngle,
  viewer = 'member',
  onSignInPress,
  onPrevClick,
  onNextClick,
  onMirror,
  onToggleFavorite,
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
  const theme = useTheme();
  const isAnonymous = viewer === 'anonymous';
  // A signed-out reader has no queue to commit into and no wall to take, so the
  // suppression lives here with the rest of the `viewer` rules rather than only
  // in the resolver — the same shape as `showLightbulb` above.
  const commit: ActionBarCommitButton =
    isAnonymous || onCommit == null || (commitButton === 'confirm' && (onKeepTheirs == null || busyWall === null))
      ? null
      : commitButton;
  // Which button sits where. The host resolves the same layout to learn which
  // buttons ⋯ has to stand in for, so both read one rule.
  const layout = resolveActionBarLayout({
    supportsMirroring,
    isAnonymous,
    commitButton: commit,
    workoutOutcome: workoutOutcome !== null,
    showLightbulb,
    hasShare: onShare != null,
    angleAvailable: onOpenAngleSelector != null && currentAngle != null,
    buttons,
    previousNext,
    hasWall,
    boardControl,
    miniPlayerMirrors,
  });
  // No wall to light and nothing to commit: the second row folds away.
  const hasSecondaryRow = typeof layout.secondaryRow === 'string' || layout.secondaryRow.length > 0;

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

  // One handler behind both views (`useWallControl` in the host): each says which it is.
  const pressWallButton = useCallback(() => onWallControlPress?.('button'), [onWallControlPress]);
  const holdWallButton = useCallback(() => onWallControlLongPress?.('button'), [onWallControlLongPress]);
  const driveWallButton = useMemo(
    () => (onWallControlDrive ? () => void onWallControlDrive('button') : undefined),
    [onWallControlDrive],
  );
  const swipeWallButton = useMemo(
    () => (onWallControlSwipe ? () => onWallControlSwipe('button') : undefined),
    [onWallControlSwipe],
  );
  const cancelWallButtonSwipe = useCallback(() => onWallControlSwipeCancel?.('button'), [onWallControlSwipeCancel]);
  const pressBulb = useCallback(() => onWallControlPress?.('bulb'), [onWallControlPress]);
  const holdBulb = useCallback(() => onWallControlLongPress?.('bulb'), [onWallControlLongPress]);

  // One of the climber's buttons in a first-row end slot (`resolveActionBarLayout`).
  const slotButton = (buttonId: PlayerButtonId): ReactNode => {
    switch (buttonId) {
      case 'mirror':
        return (
          <ActionButton
            size="lg"
            iconName="mirror"
            onPress={handleMirror}
            active={isMirrored}
            activeColor={theme.brandColors.primary}
            accessibilityLabel={isMirrored ? t('playView.actionBar.unmirrorAria') : t('playView.actionBar.mirrorAria')}
          />
        );
      case 'favorite':
        return <FavoriteButton size="lg" isFavorited={isFavorited} onPress={handleFavorite} />;
      case 'queue':
        return (
          <QueueButton
            size="lg"
            remainingCount={remainingQueueCount}
            upNextBadgeCount={upNextBadgeCount}
            onPress={onOpenQueue}
          />
        );
      // A draft has no link anybody else could open (#5960): its slot stays empty.
      case 'share':
        return onShare ? (
          <ShareButton size="lg" onPress={onShare} accessibilityLabel={tClimbs('mobile.climbRow.share')} />
        ) : null;
      case 'angle':
        return onOpenAngleSelector && currentAngle != null ? (
          <AnglePill
            angle={currentAngle}
            onPress={onOpenAngleSelector}
            accessibilityLabel={t('mobile.angleSelector.title')}
          />
        ) : null;
    }
  };

  return (
    <View
      testID="play-drawer-action-bar"
      style={
        edge === 'top'
          ? [drawerActionBarStyles.container, { borderTopColor: theme.systemColors.separator }]
          : [styles.containerAbove, { borderBottomColor: theme.systemColors.separator }]
      }
    >
      {layout.primaryCenter === 'none' ? null : layout.primaryCenter === 'confirm' &&
        busyWall &&
        onKeepTheirs &&
        onCommit ? (
        // The busy-wall question beside a MiniPlayer (#7017): the pair takes the
        // full-width wall button's place.
        <View
          key="confirm"
          style={[drawerActionBarStyles.rowPrimary, styles.rowWallControl, !hasSecondaryRow && styles.rowPrimaryAlone]}
          testID="play-drawer-action-bar-wall-row"
        >
          <BusyWallQuestionGroup model={busyWall} onKeep={onKeepTheirs} onPut={onCommit} />
        </View>
      ) : layout.primaryCenter === 'wallControlFull' ? (
        // Beside a MiniPlayer that has ⏮ ⏭, the climber's buttons and ✓ (#7000,
        // tablets and the open Duo): the wall button takes the first row, full width.
        <View
          key="wallControlFull"
          style={[drawerActionBarStyles.rowPrimary, styles.rowWallControl, !hasSecondaryRow && styles.rowPrimaryAlone]}
          testID="play-drawer-action-bar-wall-row"
        >
          <WallControlButton
            model={wallControl}
            spansRow
            glow={wallGlow}
            onPress={pressWallButton}
            onLongPress={holdWallButton}
            onDrive={driveWallButton}
            onSwipe={swipeWallButton}
            onSwipeCancel={cancelWallButtonSwipe}
          />
        </View>
      ) : layout.primaryCenter === 'wallControl' ? (
        // A timed block with the wall button chosen (#7000): ⏮ [wall button] ⏭.
        // Fell / Sent below log each go, and Log and the climber's buttons wait
        // in ⋯. The ⏮ ⏭ slots hold their width and height even when switched
        // off, so the button stays centred and the board keeps its size.
        <View
          key="wallControl"
          style={[drawerActionBarStyles.rowPrimary, !hasSecondaryRow && styles.rowPrimaryAlone]}
          testID="play-drawer-action-bar-workout-row"
        >
          <View style={styles.compactSlot}>
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
          <View style={styles.compactCenter}>
            <WallControlButton
              model={wallControl}
              compact
              glow={wallGlow}
              onPress={pressWallButton}
              onLongPress={holdWallButton}
              onDrive={driveWallButton}
              onSwipe={swipeWallButton}
              onSwipeCancel={cancelWallButtonSwipe}
            />
          </View>
          <View style={styles.compactSlot}>
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
        </View>
      ) : (
        // Keyed, like each first row above, so swapping rows mounts fresh views.
        // Reused across the swap, a slot kept a stale style from the
        // `⏮ [wall button] ⏭` row it had been (the fixed 48pt ⏮ ⏭ slots, the
        // button's flexible middle), and the five slots came back uneven: ✓ 23pt
        // right of the wall button's centre, ☰ 53pt from ⏭ (#7017).
        <View
          key="tick"
          style={[drawerActionBarStyles.rowPrimary, !hasSecondaryRow && styles.rowPrimaryAlone]}
          testID="play-drawer-action-bar-primary-row"
        >
          {/* The climber's first button on (Mirror or the heart by default).
            An empty slot keeps the row's five-slot spacing. */}
          <View style={drawerActionBarStyles.primarySlot}>
            {layout.leadingSlot ? slotButton(layout.leadingSlot) : null}
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
            {layout.trailingSlot === 'lightbulb' ? (
              // The bulb chosen, or back while Fell / Sent takes the second row
              // with no wall button. It draws the same model as the wall button.
              <WallControlBulb
                model={wallControl}
                showFace={showHolderBadge}
                onPress={pressBulb}
                onLongPress={holdBulb}
              />
            ) : layout.trailingSlot ? (
              slotButton(layout.trailingSlot)
            ) : null}
          </View>
        </View>
      )}

      {hasSecondaryRow ? (
        <View style={[drawerActionBarStyles.rowSecondary, styles.rowSecondaryHeight]}>
          {layout.secondaryRow === 'confirm' && busyWall && onKeepTheirs && onCommit ? (
            <BusyWallQuestionGroup model={busyWall} onKeep={onKeepTheirs} onPut={onCommit} />
          ) : layout.secondaryRow === 'workoutOutcome' && workoutOutcome ? (
            <WorkoutOutcomeRow
              target={workoutOutcome}
              wallLeftAtMs={workoutOutcomeWallLeftAtMs}
              onOpenLogSheet={onTickPress}
            />
          ) : typeof layout.secondaryRow === 'string' ? null : (
            layout.secondaryRow.map((item, index) => {
              switch (item) {
                case 'wallControl':
                  return (
                    <WallControlButton
                      key={item}
                      model={wallControl}
                      // Alone in the row it reaches the screen's edges; between
                      // the bulb row's buttons it doesn't.
                      spansRow={layout.secondaryRow.length === 1}
                      glow={wallGlow}
                      onPress={pressWallButton}
                      onLongPress={holdWallButton}
                      onDrive={driveWallButton}
                      onSwipe={swipeWallButton}
                      onSwipeCancel={cancelWallButtonSwipe}
                    />
                  );
                case 'angle':
                  return onOpenAngleSelector && currentAngle != null ? (
                    <AnglePill
                      key={item}
                      angle={currentAngle}
                      onPress={onOpenAngleSelector}
                      accessibilityLabel={t('mobile.angleSelector.title')}
                    />
                  ) : null;
                case 'spacer':
                  return <View key={`${item}-${index}`} style={drawerActionBarStyles.spacer} />;
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
                // The bulb's row (#7000): the climber's other buttons, small, either side.
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
                case 'queue':
                  return (
                    <QueueButton
                      key={item}
                      size="sm"
                      remainingCount={remainingQueueCount}
                      upNextBadgeCount={upNextBadgeCount}
                      onPress={onOpenQueue}
                    />
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
  /**
   * Up next while a list is walked, spoken instead of `remainingCount` and
   * badged when above zero; null when no list is walked.
   */
  upNextBadgeCount: number | null;
  onPress: () => void;
};

// A queue means nothing without a wall or a session, and the sheet it opens is
// a write surface, so an anonymous reader never gets one (see `viewer`).
//
// Walking a list, a forward swipe counts the list, so "N climbs" would say
// nothing about the queue: the badge and the label carry Up next instead.
function QueueButton({ size, remainingCount, upNextBadgeCount, onPress }: QueueButtonProps) {
  const { t } = useTranslation('session');
  const listWalked = upNextBadgeCount !== null;
  return (
    <ActionButton
      size={size}
      iconName="queue"
      onPress={onPress}
      accessibilityLabel={
        listWalked
          ? t('playView.actionBar.queueUpNextAria', { count: upNextBadgeCount })
          : t('playView.actionBar.queueCountAria', { count: remainingCount })
      }
      badge={
        listWalked && upNextBadgeCount > 0 ? (
          // On the button's corner, like the tick count. Drawn only: the
          // button's label already says the number.
          <View
            style={styles.countBadge}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="play-drawer-queue-badge"
          >
            <Text
              variant="caption2"
              color={iosSystemColors.white}
              numeric
              maxFontSizeMultiplier={COUNT_BADGE_MAX_FONT_SCALE}
              style={styles.countText}
            >
              {formatCountBadge(upNextBadgeCount)}
            </Text>
          </View>
        ) : undefined
      }
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
            {formatCountBadge(ascentCount)}
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
  // The second row's fixed height, held in every state so the board doesn't move.
  rowSecondaryHeight: {
    minHeight: ACTION_BAR_SECONDARY_ROW_HEIGHT,
  },
  // The full-width wall button's row: as tall as the icon row it replaces, so
  // nothing jumps between a phone-sized pane and a tablet's.
  rowWallControl: {
    minHeight: SIZES.lg.dim + spacing[3],
  },
  // ⏮ and ⏭ beside the workout's wall button: the big buttons' own size, held
  // even when switched off, so the row keeps its height and the button its centre.
  compactSlot: {
    width: SIZES.lg.dim,
    height: SIZES.lg.dim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ~239pt on a 375pt phone: 343pt of row less two 48pt buttons and 4pt either side.
  compactCenter: {
    flex: 1,
    flexDirection: 'row',
    marginHorizontal: spacing[1],
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
