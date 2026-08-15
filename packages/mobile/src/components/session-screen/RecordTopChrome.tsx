import { useCallback } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { CollapsingTopChrome, GlassToolbarAction, TOP_ACTION_SIZE } from '../chrome';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { iconMap } from '../icon-map';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

// Record's defining action is the Start/End footer button, so the chrome's
// create island is gated off — its handler is never invoked.
const noop = () => {};

// M3 text-button height. The pill sits in a 56dp app-bar row, so 40dp leaves the
// bar's own breathing room; `hitSlop` lifts the effective target back over 48dp.
const MATERIAL_EXIT_HEIGHT = 40;

type RecordTopChromeProps = {
  /** The session title — shown in the Material app bar; on glass the board pill +
   *  in-body session content carry context (no scrolled title). */
  title: string;
  /** Open the rename sheet. Wired to the Material app-bar title (a tappable
   *  title); on glass the in-body large title carries its own edit affordance. */
  onEditTitle?: () => void;
  /** Open the full board switcher; the board pill doubles as the board picker. */
  onOpenBoardSwitcher: () => void;
  /** Report the measured chrome height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** Open the invite sheet. Provided only while a session is live; the share
   *  glyph then docks at the far right of the chrome's right toolbar. */
  onShare?: () => void;
  /** Open the session-exit confirmation. Provided only while a session is live; the
   *  glyph docks beside the share control so the session's exit lives in the
   *  nav-bar trailing slot, off the bottom edge. */
  onEndSession?: () => void;
  /**
   * What this device's exit actually does, which decides the control's label
   * and tint: `end` is the destructive red Stop, `leave` is a neutral Leave.
   * A red Stop that only drops you out of someone else's party is a lie, and
   * it trains climbers to distrust the destructive colour on the one surface
   * where that trust matters (#3502). Defaults to `end` so callers that don't
   * know (and the existing tests) keep the original chrome.
   */
  exitVariant?: 'end' | 'leave';
};

/**
 * The Record tab's top chrome, routed by UI variant.
 *
 * Liquid Glass: a thin wrapper over the shared `CollapsingTopChrome` (mirroring
 * `DiscoverTopChrome`) that injects the session title plus the board / invite
 * i18n strings. Record's primary action is the Start/End footer button, so
 * there's no create "+"; instead, while a session is live it docks a
 * share/invite control as the chrome's `trailingAction`. The board pill, angle,
 * and light islands come for free from `CollapsingTopChrome`.
 *
 * Material: an absolutely-positioned, `onHeightChange`-measured M3 small app bar
 * (mirroring `ClimbTopChrome`) — the session title via `Appbar.Content`, and (only
 * while a session is live) a share `Appbar.Action` plus a labelled M3 text button
 * for the exit, the flat counterpart of the glass Stop pill. The board is switched
 * from the in-body `BoardSummaryCard` (which carries the full name · size · angle),
 * so the app bar stays session-titled rather than duplicating a board switcher.
 */
export function RecordTopChrome({
  title,
  onEditTitle,
  onOpenBoardSwitcher,
  onHeightChange,
  onShare,
  onEndSession,
  exitVariant = 'end',
}: RecordTopChromeProps) {
  const { t } = useTranslation('session');
  const { t: tBoards } = useTranslation('boards');
  const { brandColors, systemColors, variant, radii } = useTheme();
  const insets = useSafeAreaInsets();

  // Leaving is non-destructive, so it gets neither the red tint nor the stop
  // glyph. The accessibility label reuses the string web's queue bar already
  // ships for the same action, so the two surfaces read identically.
  const isLeaveExit = exitVariant === 'leave';
  const exitLabel = isLeaveExit ? t('queueBar.ariaLabels.leaveSession') : t('mobile.session.inEndSession');
  // The word printed on the control, deliberately shorter than the accessibility
  // label. A bare flag glyph reads as "report this climb" to climbers who have
  // never ended a session (#4281), so every exit control carries its verb.
  const exitActionLabel = isLeaveExit ? t('mobile.session.inLeave') : t('mobile.session.inStop');
  const exitTint = isLeaveExit ? systemColors.label : brandColors.error;
  const exitIcon = isLeaveExit ? 'leave.session' : 'flag';

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  if (isMaterial) {
    return (
      <View
        // NOT box-none — the opaque Material band must swallow touches; see ClimbTopChrome for the RNGH mechanism.
        pointerEvents="auto"
        style={[
          styles.materialContainer,
          {
            paddingTop: insets.top,
            backgroundColor: systemColors.secondaryBackground,
            borderBottomColor: systemColors.separator,
          },
        ]}
        onLayout={handleLayout}
      >
        <Appbar.Header
          statusBarHeight={0}
          mode="small"
          elevated
          style={[styles.materialAppbar, { backgroundColor: systemColors.secondaryBackground }]}
        >
          {/* Invite/share docks on the LEFT (leading) while a session is live; the
              destructive Stop sits on the right. */}
          <UserAvatarToolbarAction variant="material" />
          {onShare ? (
            <Appbar.Action
              icon={iconMap['person.badge.plus'].android}
              color={systemColors.label as string}
              onPress={onShare}
              accessibilityLabel={t('mobile.session.invite')}
            />
          ) : null}
          <Appbar.Content
            title={title}
            color={systemColors.label as string}
            onPress={onEditTitle}
            // The label must carry the session name (the bar's only rendering of
            // it); the rename action rides the hint + the pencil action below.
            accessibilityLabel={title}
            accessibilityHint={onEditTitle ? t('mobile.session.editTitleAria') : undefined}
          />
          {onEditTitle ? (
            // Visible rename cue: the title's own tap target has no affordance,
            // and unlike glass there is no in-body pencil on Material.
            <Appbar.Action
              icon={iconMap['edit'].android}
              color={systemColors.secondaryLabel as string}
              onPress={onEditTitle}
              accessibilityLabel={t('mobile.session.editTitleAria')}
            />
          ) : null}
          {onEndSession ? (
            // A labelled M3 text button rather than an `Appbar.Action`: Paper's
            // action slot is a 48dp circle with room for a glyph and nothing
            // else, and an icon-only exit is exactly what climbers misread
            // (#4281). Rendered as a plain app-bar child, the way
            // `BoardSwitcherButton` sits in the climbs chrome.
            <PressableSurface
              onPress={onEndSession}
              feedback="opacity"
              // M3 state layer, tinted from the same role the label uses, so Stop
              // ripples red and Leave ripples neutral. Cast matches the sibling
              // Appbar props: the iOS-flavoured tokens are a dynamic-colour union,
              // but the Material variant always resolves them to plain strings.
              rippleColor={exitTint as string}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={exitLabel}
              style={[styles.materialExitAction, { borderRadius: radii.button }]}
            >
              <Icon name={exitIcon} size={20} color={exitTint} />
              <Text
                variant="subheadline"
                color={exitTint}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={styles.exitLabel}
              >
                {exitActionLabel}
              </Text>
            </PressableSurface>
          ) : null}
        </Appbar.Header>
      </View>
    );
  }

  // Liquid-glass variant: the shared collapsing chrome. While a session is live the
  // invite/share control docks on the LEFT and a single exit control on the RIGHT,
  // with no lightbulb — so the active header reads invite | title | exit. The exit
  // is a destructive Stop on the device that started the session and a neutral Leave
  // everywhere else (see `exitVariant`). It sits up here rather than as a bottom bar,
  // keeping the bottom edge to the tab bar + climb accessory.
  const inSession = onEndSession !== undefined;
  const leadingAction = onShare ? (
    <GlassToolbarAction onPress={onShare} accessibilityLabel={t('mobile.session.invite')}>
      <Icon name="person.badge.plus" size={22} color={systemColors.label} />
    </GlassToolbarAction>
  ) : undefined;
  // Stop is a labelled glass pill (icon + "Stop"), not an icon-only slot, so it reads
  // clearly as the session-ending control. It occupies two toolbar slots to fit the
  // label.
  const trailingAction = onEndSession ? (
    <PressableSurface
      onPress={onEndSession}
      feedback="opacity"
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={exitLabel}
      style={styles.glassExitAction}
    >
      <Icon name={exitIcon} size={20} color={exitTint} />
      <Text
        variant="subheadline"
        color={exitTint}
        numberOfLines={1}
        // The pill's height is pinned to the glass slot ladder, so the label has
        // to stop growing before it clips.
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.exitLabel}
      >
        {exitActionLabel}
      </Text>
    </PressableSurface>
  ) : undefined;

  return (
    <CollapsingTopChrome
      // Record has no create action — the create island is gated off (canCreate
      // false), so onCreate / createAccessibilityLabel are inert.
      canCreate={false}
      onCreate={noop}
      createAccessibilityLabel={title}
      onOpenBoardSwitcher={onOpenBoardSwitcher}
      boardPillAccessibilityHint={tBoards('boardPill.switchHint')}
      onHeightChange={onHeightChange}
      leadingAction={leadingAction}
      leadingActionCount={onShare ? 1 : 0}
      trailingAction={trailingAction}
      // The Stop pill spans two icon-slots so its "Stop" label fits the toolbar width.
      trailingActionCount={onEndSession ? 2 : 0}
      hideLight={inSession}
    />
  );
}

const styles = StyleSheet.create({
  materialContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  materialAppbar: {
    elevation: 0,
    shadowOpacity: 0,
  },
  // The labelled Stop pill fills the two trailing toolbar slots it reserves.
  glassExitAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    height: TOP_ACTION_SIZE,
  },
  // M3 text-button metrics: 40dp tall, 12dp side padding, pill corners from the
  // variant radii. `overflow: hidden` keeps the Android ripple inside those
  // corners; the trailing margin lands the label near the bar's 16dp edge inset.
  materialExitAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    height: MATERIAL_EXIT_HEIGHT,
    marginRight: spacing[1],
    overflow: 'hidden',
  },
  exitLabel: {
    fontWeight: '600',
  },
});
