import { type MutableRefObject, useCallback, useMemo, useRef } from 'react';
import { Gesture, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, type SharedValue } from 'react-native-reanimated';
import { resolveHoldAtPoint, type HoldHitTarget } from './holdLayout';

// Match the zoomed overlay (use-zoomed-hold-tap-gesture) so a tap at rest
// behaves exactly like a tap while zoomed. Keep in sync.
export const REST_TAP_MAX_DURATION_MS = 300;
export const REST_TAP_MAX_DISTANCE_PX = 15;
export const REST_LONG_PRESS_MIN_DURATION_MS = 400;

/**
 * Movement budget (px) before the long-press leg gives up, mirroring the zoomed
 * board's `panActivationOffset`. At rest there is no pan to hand the drag to —
 * the drag belongs to whatever scroll container hosts the board (the create
 * board lives inside a BottomSheetScrollView). RNGH only yields the touch to
 * that scroll while this overlay's legs are still un-activated, so the
 * long-press must fail on the same small offset the zoomed pan activates on.
 * RNGH's default is 10px; 8 keeps it identical to PAN_ACTIVATION_OFFSET.
 */
export const REST_LONG_PRESS_MAX_DISTANCE_PX = 8;

type UseRestHoldTapGestureOptions = {
  /** Hold hit circles in board-local render px (from buildHoldHitTargets). */
  hitTargets: HoldHitTarget[];
  /** Tap handler (paint / open picker). When omitted the hook returns null and
   *  the caller should mount no overlay — used by zone mode, which has no
   *  per-hold taps. */
  onTap?: (holdId: number) => void;
  /** Long-press handler (role sheet). Falls back to onTap when omitted. */
  onLongPress?: (holdId: number) => void;
  /** The board's ancestor pinch. Both legs declare themselves simultaneous with
   *  it so a finger resting on the overlay can't stall pinch-to-zoom. */
  pinchRef?: MutableRefObject<GestureType | undefined>;
  /** True while a pinch is in progress. The legs are simultaneous with the pinch
   *  (above), so RNGH won't fail them when it activates — gate both callbacks on
   *  this or a small/slow pinch paints the hold under a finger. */
  isPinchingSV?: SharedValue<boolean>;
};

/**
 * Resolve an at-rest (un-zoomed) board tap to the hold **nearest** the touch
 * point, as one full-bleed overlay instead of one detector per hold.
 *
 * Why this exists (#4496): HoldTargetLayer used to give every hold its own
 * absolutely-positioned square View + GestureDetector, inflated to
 * `max(ringDiameter * 1.6, 44)` px so small holds stay tappable. At fit-to-screen
 * those squares overlap heavily, and overlapping sibling Views are arbitrated by
 * **z-order** — the last hold in the list wins every touch inside its square,
 * however far off-centre. Sets are concatenated in `set_ids` order, so on Kilter
 * layout 1 (Bolt Ons, then Screw Ons) the screw-ons render last and sit on top:
 * at a 340 dp board, 289 of 323 bolt-on centres (90%) fall inside some screw-on's
 * 44 dp hit circle, so tapping the dead centre of a bolt-on handed the touch to a
 * screw-on nine times in ten. That is the reported "only screw-ons get selected"
 * plus the felt offset. Zooming "fixed" it only because the squares stop
 * overlapping. One overlay + `resolveHoldAtPoint` replaces z-order with
 * nearest-centre, which is what the user is actually aiming at.
 *
 * Residual limit, on purpose: every hold on a board shares one hit radius
 * (`r = xSpacing * 4` for Aurora boards, a constant cell radius for MoonBoard),
 * so nearest-centre is a plain Voronoi partition of the board. That removes the
 * bias but not the fineness: on Kilter layout 1 at 340 dp the holds sit 13.4 dp
 * apart, so each cell is only ~6.7 dp (~1.1 mm) wide — far under a fingertip. A
 * miss is now unbiased and deterministic rather than systematically the same
 * neighbour, and zooming still gives you room, but landing on one specific hold
 * at fit-to-screen still takes care. A precision affordance (auto-zoom on first
 * tap, confirm-and-nudge) is the open half of #4496 and is not attempted here.
 *
 * Composition is `Gesture.Race(longPress, tap)`, never `Exclusive`: Exclusive
 * makes the tap wait for the long-press to fail, which only happens on
 * finger-up, so a composite that later grows a pan leg deadlocks. With Race the
 * first leg to activate wins — a quick release activates the tap, a 400ms hold
 * activates the long-press and cancels the tap. Both legs fail on movement
 * (`maxDistance`), which is what lets a drag reach the parent scroll instead of
 * turning into a whole-board long-press. See REST_LONG_PRESS_MAX_DISTANCE_PX.
 *
 * The composed gesture is built ONCE per mount: its deps are only stable shared
 * values, and the JS handlers read render-scoped values (hitTargets, callbacks)
 * through a ref. Rebuilding a live gesture mid-session has wedged iOS RNGH
 * before (see use-carousel-gesture / use-zoom-pan-gesture).
 */
export function useRestHoldTapGesture({
  hitTargets,
  onTap,
  onLongPress,
  pinchRef,
  isPinchingSV,
}: UseRestHoldTapGestureOptions): ComposedGesture | null {
  const hasTap = onTap != null;

  const callbacksRef = useRef({ hitTargets, onTap, onLongPress });
  callbacksRef.current = { hitTargets, onTap, onLongPress };

  // Identity-stable for the life of the hook: both read every render-scoped
  // value through callbacksRef, so neither needs a dep. That stability is what
  // makes the capture in the gesture memo below safe — a fresh function per
  // render would be captured once and go stale, or force the whole composite to
  // rebuild mid-session.
  const handleTap = useCallback((boardX: number, boardY: number) => {
    const current = callbacksRef.current;
    if (!current.onTap) return;
    const holdId = resolveHoldAtPoint(boardX, boardY, current.hitTargets);
    if (holdId != null) current.onTap(holdId);
  }, []);
  const handleLongPress = useCallback((boardX: number, boardY: number) => {
    const current = callbacksRef.current;
    const handler = current.onLongPress ?? current.onTap;
    if (!handler) return;
    const holdId = resolveHoldAtPoint(boardX, boardY, current.hitTargets);
    if (holdId != null) handler(holdId);
  }, []);

  return useMemo(() => {
    if (!hasTap) return null;

    // The overlay sits inside the board's zoom transform and is only mounted
    // while un-zoomed (scale 1, no translation), so the gesture's local x/y are
    // already board-local render px — no inverse transform needed here.
    const tap = Gesture.Tap()
      .maxDuration(REST_TAP_MAX_DURATION_MS)
      .maxDistance(REST_TAP_MAX_DISTANCE_PX)
      .onStart((event) => {
        'worklet';
        if (isPinchingSV?.value) return;
        runOnJS(handleTap)(event.x, event.y);
      });

    const longPress = Gesture.LongPress()
      .minDuration(REST_LONG_PRESS_MIN_DURATION_MS)
      .maxDistance(REST_LONG_PRESS_MAX_DISTANCE_PX)
      .onStart((event) => {
        'worklet';
        if (isPinchingSV?.value) return;
        runOnJS(handleLongPress)(event.x, event.y);
      });

    // Applied per-leg — the relation method is on the individual gestures, not
    // the Race composite.
    if (pinchRef) {
      tap.simultaneousWithExternalGesture(pinchRef);
      longPress.simultaneousWithExternalGesture(pinchRef);
    }

    return Gesture.Race(longPress, tap);
    // handleTap/handleLongPress are useCallback([]) — listed for honesty, they
    // never change, so this composite is still built once per mount.
  }, [hasTap, pinchRef, isPinchingSV, handleTap, handleLongPress]);
}
