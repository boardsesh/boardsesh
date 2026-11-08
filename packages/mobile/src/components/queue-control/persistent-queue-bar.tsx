/**
 * PersistentQueueBar — the persistent climb toolbar that mounts at the app root
 * and is visible on every screen while a current climb is set.
 *
 * It is a thin adapter: it decides *whether* the climb bar should show (a climb
 * to show exists, the climber's last pick or the queue's current, and the
 * native iOS 26 bottom accessory isn't already owning it),
 * then lays it out per variant via {@link ActiveContextBar}:
 *
 *   Liquid Glass / fallback   [ grade · name ]        [ ✓ tick ]
 *     centered capsule + standalone hero tick (tap = PlayDrawer)
 *
 *   Material                 ╭ ▢ name · byline   ⏭  💡  ✓ ╮
 *     the MiniPlayer card (`FloatingMiniPlayerCard`): the iOS accessory's row
 *     on a rounded M3 card, 8dp in from each edge, sitting straight on the tab bar
 *
 * On the Liquid Glass variant on iOS 26 the native bottom accessory owns this
 * pair (iPhone and iPad), so `useCurrentClimbSurface` answers `nativeAccessory`
 * and this returns null.
 */

import { useSegments } from 'expo-router';
import { MATERIAL_MINI_PLAYER_CARD_GAP, TOOLBAR_RESERVE, TAB_BAR_HEIGHT, glassSize } from '../../theme/layout';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { isTopLevelTabRoute, tabsActiveSegment } from '../../lib/route-segments';
import { useCurrentClimbSurface } from '../../hooks/use-current-climb-surface';
import { ActiveContextBar } from './ActiveContextBar';
import { ClimbCapsule } from './ClimbCapsule';
import { LogAscentFab } from './LogAscentFab';
import { MATERIAL_MINI_PLAYER_CARD_INSET } from './mini-player-controls';
import { FloatingMiniPlayerCard } from '../navigation/FloatingMiniPlayerCard';
import { TabBarHideFollower } from '../navigation/TabBarHideFollower';
import { ReturnToSessionButton } from './ReturnToSessionButton';
import { useBarClimb } from './use-bar-climb';

// Re-export so layout consumers that already import toolbar metrics from this
// module don't need to know which file owns them. Source of truth: theme/layout.
export { TOOLBAR_RESERVE, TAB_BAR_HEIGHT };

export function PersistentQueueBar() {
  const { variant } = useTheme();
  const segments = useSegments();
  const { home } = useCurrentClimbSurface();
  // sessionId-only subscription (mirrors the tab layout's own read) — a "return to
  // session" affordance while a session is live and the user isn't already on the
  // Record tab.
  const { sessionId } = useQueueSessionId();

  // The climber's last pick, or the queue's current when THAT changed after it
  // (owner decision A). Never the wall's lit climb: that lives in the top "On
  // the wall" strip. ✓ logs the climb the bar shows.
  const { climb: currentClimb, pick } = useBarClimb();
  // A pick logs the flip the bar draws, its own; the queue's current, its slot's.
  const pickMirrored = pick ? pick.mirrored : undefined;

  // One climb, one surface: the JS tablet shell's pane (IpadPlayPane) or the
  // native accessory (iPhone, iPad, and the iPhone Duo's split) already show it,
  // so the floating bar renders only where neither does.
  if (home !== 'floatingBar') return null;
  if (!currentClimb) return null;
  // Show the climb bar only on a top-level tab page (a tab's own index), never on a
  // pushed sub-route or any root push/modal. This single gate subsumes the old
  // per-surface bail-outs — auth, gym-discovery, and the player are all non-tab
  // routes, and every in-tab sub-route is ≥ 3 segments deep, so all of them read as
  // not-top-level here.
  if (!isTopLevelTabRoute(segments)) return null;

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  if (isMaterial) {
    // The card logs and lights from its own row, so it needs neither the tick
    // nor the return-to-session button the glass capsule floats beside it. On an
    // Android phone it follows the nav bar down when the bar hides on scroll,
    // landing straight on the gesture inset with every control still there.
    return (
      <TabBarHideFollower>
        <ActiveContextBar
          fillPrimary
          anchorToMeasuredTabBar
          gapAboveTabBar={MATERIAL_MINI_PLAYER_CARD_GAP}
          horizontalInset={MATERIAL_MINI_PLAYER_CARD_INSET}
          primary={<FloatingMiniPlayerCard />}
        />
      </TabBarHideFollower>
    );
  }

  // Excludes the Record tab itself — this bar renders on every top-level tab page
  // including Record's own index, so without this guard the button would point at
  // the screen it's already on.
  const onRecordTab = tabsActiveSegment(segments) === 'record';
  const showReturnToSession = sessionId !== null && !onRecordTab;

  // The capsule follows the nav bar too: an Android phone with the Liquid Glass
  // preference still gets the Material bar, which still hides on scroll, and the
  // rest pill above the capsule moves with it. Wrapping both branches keeps every
  // floating control in step (on iOS and the web the follower is a passthrough).
  return (
    <TabBarHideFollower>
      <ActiveContextBar
        primary={
          <ClimbCapsule
            endAction={showReturnToSession ? <ReturnToSessionButton /> : undefined}
            endActionSize={showReturnToSession ? glassSize.inline : undefined}
          />
        }
        trailing={<LogAscentFab climb={currentClimb} isMirror={pickMirrored} />}
      />
    </TabBarHideFollower>
  );
}
