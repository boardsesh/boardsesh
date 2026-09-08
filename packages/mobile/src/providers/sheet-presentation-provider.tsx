/**
 * SheetPresentationProvider — a global serializer for native bottom-sheet
 * present/dismiss transitions.
 *
 * `@expo/ui/community/bottom-sheet` is a SwiftUI `.sheet(isPresented:)` wrapper.
 * Every sheet presents off the SAME root window view controller, and the library
 * does ZERO serialization: `present()` just flips `isPresented` true, `dismiss()`
 * flips it false and fires its close callbacks SYNCHRONOUSLY (before the native
 * animation finishes). UIKit forbids presenting/dismissing a view controller
 * while another transition is in flight on the same presenter — overlap them and
 * UIKit DEADLOCKS: the close animation never completes and the whole app freezes
 * (renders, ignores every tap/gesture). See docs/mobile-sheets-vs-routes.md.
 *
 * This provider is a pure-JS scheduler (no native view, no React state, no
 * re-renders) that enforces three invariants PER presenter group:
 *   1. At most one present-or-dismiss transition is in flight at a time.
 *   2. A queued `present` waits until the prior `dismiss` has actually SETTLED —
 *      not merely "JS asked it to close."
 *   3. One active sheet per exclusive group: presenting B while A is open
 *      auto-sequences dismiss(A) → settle → present(B). This makes sheet-over-
 *      sheet handoffs safe and enforces docs hard-rule 1 at runtime. A sheet
 *      displaced this way is CLOSED, not suspended — its parent is notified
 *      (onDisplaced → onClose) and its desired-open flag cleared, so it never
 *      re-presents by itself when B later closes.
 *
 * "Settled" is detected two ways. On iOS the real post-animation signal arrives
 * via `notifyFullyDismissed`: our `@expo/ui` patch forwards SwiftUI's
 * `.sheet(onDismiss:)` closure out of the community bottom-sheet wrapper (see
 * patches/@expo%2Fui@…patch and useManagedSheet's onFullyDismissed handler). A
 * fixed per-platform timer is the fallback: it's the only settle signal on
 * Android (Compose has no post-animation event), and on iOS it's the ceiling for
 * the rare case the native event is late or never arrives (e.g. a Host torn down
 * mid-animation).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { Platform } from 'react-native';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';

export type PresenterGroup = 'root' | (string & {});

/** Result of an awaitable surface dismissal. `aborted` means the registered
 * host disappeared before its native dismiss settled; callers must stop the
 * handoff instead of presenting a replacement over an indeterminate teardown. */
export type DismissAndWaitResult = { status: 'dismissed' } | { status: 'aborted' };

const DISMISSED_RESULT: DismissAndWaitResult = { status: 'dismissed' };
const ABORTED_RESULT: DismissAndWaitResult = { status: 'aborted' };

/** How long after JS asks a native sheet to dismiss we treat it as still
 * animating (the ceiling before we let the next transition run). iOS modal sheet
 * present/dismiss is ~0.4-0.5s; Android material is quicker. This is the primary
 * settle signal on Android and the fallback ceiling on iOS (where the accurate
 * native `onDismiss` normally resolves the settle first, unless a Host was torn
 * down mid-animation and the event never arrives). */
const IOS_SHEET_SETTLE_MS = 550;
const ANDROID_SHEET_SETTLE_MS = 350;
/**
 * Ceiling for "a dismissed sheet is fully gone". Exported so a caller that has to
 * act AFTER a native sheet has left the screen — raising a toast, which is a
 * root-level JS view and would otherwise render behind it — waits the same amount
 * of time this coordinator does, instead of guessing its own number.
 */
export const SHEET_SETTLE_MS = Platform.OS === 'ios' ? IOS_SHEET_SETTLE_MS : ANDROID_SHEET_SETTLE_MS;
const SETTLE_MS = SHEET_SETTLE_MS;

type Registration = {
  group: PresenterGroup;
  present: () => void;
  dismiss: () => void;
  onFullyDismissed?: () => void;
  /** The coordinator displaced this sheet to present another one in the same
   * group. A displaced sheet is CLOSED, not suspended: the parent must clear
   * whatever state drove `open`, exactly as it does for a user pan-down.
   * Without this, the parent's stale open-state left the sheet flagged as
   * desired-open, and it re-presented "at random" when the displacing sheet
   * closed (the phantom tick-sheet bug). */
  onDisplaced?: () => void;
};

type InFlight = {
  op: 'present' | 'dismiss';
  id: string;
  timer: ReturnType<typeof setTimeout>;
  /** True when an accurate native `onDismiss` is expected to resolve this settle
   * (an iOS coordinator- or user-driven dismiss of a still-registered sheet). If
   * the ceiling timer fires first for one of these, the animation genuinely
   * outran the ceiling — the one case the __DEV__ warning is meant to catch.
   * False on Android (no native signal) and for unmount teardowns (the
   * registration is gone, so notifyFullyDismissed can never match). */
  expectNative: boolean;
};

type GroupState = {
  /** The sheet currently presented (a present transition has settled and no
   * dismiss has settled since). Null = nothing up in this group. */
  presentedId: string | null;
  inFlight: InFlight | null;
};

export type SheetCoordinator = {
  register: (reg: { id: string } & Registration) => () => void;
  /** Declarative entry point: the desired open/closed state for a sheet. The
   * scheduler reconciles it against what's physically presented. */
  setDesiredOpen: (id: string, open: boolean) => void;
  /** Close this sheet and resolve only after the coordinator's existing native
   * settle signal / platform ceiling. Duplicate callers share the same settle;
   * unregistering the host resolves every pending caller as `aborted`. */
  dismissAndWait: (id: string) => Promise<DismissAndWaitResult>;
  /** The native sheet finished its dismiss animation (patched `@expo/ui`
   * `onDismiss`). Early-resolves the settle so the next transition can start. */
  notifyFullyDismissed: (id: string) => void;
  /** The native sheet started closing on its own (user pan-down / backdrop tap),
   * i.e. NOT driven by the coordinator. Opens a settle window so nothing presents
   * over the still-animating dismiss. */
  notifyClosed: (id: string) => void;
  isPresented: (id: string) => boolean;
  isBusy: (group?: PresenterGroup) => boolean;
};

const SheetPresentationContext = createContext<SheetCoordinator | null>(null);

export function useSheetPresentation(): SheetCoordinator {
  const context = useContext(SheetPresentationContext);
  if (!context) throw new Error('useSheetPresentation must be used within SheetPresentationProvider');
  return context;
}

export function SheetPresentationProvider({ children }: { children: ReactNode }) {
  // All scheduler state lives in refs: this provider never re-renders, and the
  // coordinator object below is stable for the app's lifetime.
  const registrations = useRef(new Map<string, Registration>());
  const desired = useRef(new Map<string, { open: boolean; seq: number }>());
  const groups = useRef(new Map<PresenterGroup, GroupState>());
  const dismissWaiters = useRef(new Map<string, Set<(result: DismissAndWaitResult) => void>>());
  const seqCounter = useRef(0);

  const coordinator = useMemo<SheetCoordinator>(() => {
    function groupState(group: PresenterGroup): GroupState {
      let state = groups.current.get(group);
      if (!state) {
        state = { presentedId: null, inFlight: null };
        groups.current.set(group, state);
      }
      return state;
    }

    function groupOf(id: string): PresenterGroup | null {
      return registrations.current.get(id)?.group ?? null;
    }

    // The single sheet that SHOULD be presented in a group: among ids marked
    // open, the one most recently requested (highest seq). This makes a handoff
    // (open B while A is still flagged open) resolve to B without the coordinator
    // having to mutate A's desired state.
    function computeWant(group: PresenterGroup): string | null {
      let bestId: string | null = null;
      let bestSeq = -1;
      for (const [id, want] of desired.current) {
        if (!want.open) continue;
        if (registrations.current.get(id)?.group !== group) continue;
        if (want.seq > bestSeq) {
          bestSeq = want.seq;
          bestId = id;
        }
      }
      return bestId;
    }

    function settleDismissWaiters(id: string, result: DismissAndWaitResult): void {
      const waiters = dismissWaiters.current.get(id);
      if (!waiters) return;
      dismissWaiters.current.delete(id);
      for (const resolve of waiters) resolve(result);
    }

    function onSettle(group: PresenterGroup, viaCeiling: boolean): void {
      const state = groupState(group);
      const inFlight = state.inFlight;
      if (!inFlight) return;
      clearTimeout(inFlight.timer);
      state.inFlight = null;
      if (inFlight.op === 'present') {
        state.presentedId = inFlight.id;
      } else {
        state.presentedId = null;
        // Resolve before the consumer's onFullyDismissed callback: that callback
        // may unmount/unregister the Host, which is an abort only while a native
        // dismissal is still outstanding, not after it has settled.
        settleDismissWaiters(inFlight.id, DISMISSED_RESULT);
        registrations.current.get(inFlight.id)?.onFullyDismissed?.();
        if (__DEV__ && viaCeiling && inFlight.expectNative) {
          console.warn(
            `[sheet-presentation] dismiss of "${inFlight.id}" settled via the ${SETTLE_MS}ms ceiling timer ` +
              `before the native onDismiss arrived — the dismiss animation outran the ceiling. ` +
              `If this is frequent on a device, raise SETTLE_MS.`,
          );
        }
      }
      pump(group);
    }

    function startTransition(group: PresenterGroup, op: 'present' | 'dismiss', id: string): void {
      const state = groupState(group);
      const timer = setTimeout(() => onSettle(group, true), SETTLE_MS);
      state.inFlight = { op, id, timer, expectNative: op === 'dismiss' && Platform.OS === 'ios' };
      const registration = registrations.current.get(id);
      if (op === 'present') registration?.present();
      else registration?.dismiss();
    }

    function pump(group: PresenterGroup): void {
      const state = groupState(group);
      if (state.inFlight) return; // a transition is animating; re-pump on settle
      const want = computeWant(group);
      const have = state.presentedId;
      if (have === want) return; // settled
      if (have !== null) {
        // Must clear the currently-presented sheet first (plain close OR the
        // dismiss half of a handoff). present(want) runs after this settles.
        const haveDesired = desired.current.get(have);
        const displaced = want !== null && haveDesired?.open === true;
        if (displaced) {
          // Displacement: `have` is still flagged open but a different sheet won
          // the group. Treat the displaced sheet as closed — clear its desired
          // flag so computeWant can never resurrect it once `want` goes away,
          // and tell its parent so the state that drove `open` is cleared too.
          // (A plain close, want === null, or a handoff whose first sheet already
          // closed itself needs neither: the parent drove those.)
          desired.current.set(have, { open: false, seq: haveDesired.seq });
        }
        startTransition(group, 'dismiss', have);
        // Notify via microtask, AFTER the dismiss is in flight. Deferring keeps
        // the parent's setState (onDisplaced → onClose) out of whatever context
        // pump() ran in (an event handler or another component's effect), and
        // the inFlight guard is already up so a re-entrant pump from the parent
        // can't start a second transition for this group. Re-resolve the
        // registration inside the task: if the sheet unmounted meanwhile, the
        // notification is correctly a no-op. A parent that responds to
        // onDisplaced/onClose by re-opening (setDesiredOpen true) queues a
        // legitimate re-present after the displacer closes — that's the
        // deliberate escape hatch for a sheet that truly must resume; nothing
        // uses it today.
        if (displaced) {
          const displacedId = have;
          queueMicrotask(() => registrations.current.get(displacedId)?.onDisplaced?.());
        }
      } else {
        startTransition(group, 'present', want as string);
      }
    }

    return {
      register(reg) {
        registrations.current.set(reg.id, {
          group: reg.group,
          present: reg.present,
          dismiss: reg.dismiss,
          onFullyDismissed: reg.onFullyDismissed,
          onDisplaced: reg.onDisplaced,
        });
        groupState(reg.group);
        return () => {
          const state = groupState(reg.group);
          // A caller waiting to navigate must not continue after this Host is
          // torn down. Resolve (never reject) so fire-and-forget action paths do
          // not create unhandled promise rejections.
          settleDismissWaiters(reg.id, ABORTED_RESULT);
          // Was this sheet presented or mid-transition when it unmounted? If so its
          // native teardown is still animating out, even though no coordinator
          // dismiss was issued (e.g. a present-on-mount sheet the parent unmounts
          // on select). We must keep the group "busy" across that teardown.
          const involved = state.presentedId === reg.id || state.inFlight?.id === reg.id;
          if (state.inFlight?.id === reg.id) {
            clearTimeout(state.inFlight.timer);
            state.inFlight = null;
          }
          desired.current.delete(reg.id);
          registrations.current.delete(reg.id);
          if (involved) {
            // Open a settle window so the next same-group present can't start while
            // the unmounted sheet's native dismiss is still in flight — that overlap
            // is the UIKit deadlock this provider exists to prevent. onSettle nulls
            // presentedId and pumps; the registration is already gone so its
            // onFullyDismissed is a no-op (the component unmounted).
            state.presentedId = null;
            const timer = setTimeout(() => onSettle(reg.group, true), SETTLE_MS);
            // The registration is already gone, so no native onDismiss can match
            // here — the ceiling is the only possible settle; don't warn on it.
            state.inFlight = { op: 'dismiss', id: reg.id, timer, expectNative: false };
          } else {
            pump(reg.group);
          }
        };
      },

      setDesiredOpen(id, open) {
        const prev = desired.current.get(id);
        const seq = open ? (seqCounter.current += 1) : (prev?.seq ?? 0);
        desired.current.set(id, { open, seq });
        // A fresh open supersedes an in-flight caller-owned dismissal. Resolve
        // those waiters as aborted so the caller does not navigate away while
        // the source surface is being deliberately re-presented.
        if (open) settleDismissWaiters(id, ABORTED_RESULT);
        const group = groupOf(id);
        if (group) pump(group);
      },

      dismissAndWait(id) {
        const registration = registrations.current.get(id);
        // No registration and no transition owned by this id means there is no
        // native surface left to wait for.
        if (!registration) return Promise.resolve(DISMISSED_RESULT);

        const state = groupState(registration.group);
        const involved = state.presentedId === id || state.inFlight?.id === id;
        const previous = desired.current.get(id);
        desired.current.set(id, { open: false, seq: previous?.seq ?? 0 });

        if (!involved) {
          // It may have been desired while another group member was transitioning,
          // but it never reached the native presenter. Cancel that queued desire
          // and finish immediately.
          pump(registration.group);
          return Promise.resolve(DISMISSED_RESULT);
        }

        return new Promise<DismissAndWaitResult>((resolve) => {
          let waiters = dismissWaiters.current.get(id);
          if (!waiters) {
            waiters = new Set();
            dismissWaiters.current.set(id, waiters);
          }
          waiters.add(resolve);
          // Presented → dismiss now. Present-in-flight → the desired-close is
          // observed when that transition settles, then the normal pump starts a
          // dismiss. An already-running dismiss simply keeps this waiter attached.
          pump(registration.group);
        });
      },

      notifyFullyDismissed(id) {
        const group = groupOf(id);
        if (!group) return;
        const state = groupState(group);
        if (state.inFlight && state.inFlight.op === 'dismiss' && state.inFlight.id === id) {
          onSettle(group, false);
        }
      },

      notifyClosed(id) {
        const group = groupOf(id);
        if (!group) return;
        const prev = desired.current.get(id);
        desired.current.set(id, { open: false, seq: prev?.seq ?? 0 });
        const state = groupState(group);
        // The native sheet is already animating out on its own. Open a settle
        // window (unless we were already driving a dismiss for it) so the next
        // present waits for the animation, then reconcile.
        if (state.presentedId === id && !state.inFlight) {
          const timer = setTimeout(() => onSettle(group, true), SETTLE_MS);
          // A user pan-down / backdrop tap still fires SwiftUI's onDismiss on iOS,
          // so the native settle is expected to early-resolve this window there.
          state.inFlight = { op: 'dismiss', id, timer, expectNative: Platform.OS === 'ios' };
        } else {
          pump(group);
        }
      },

      isPresented(id) {
        const group = groupOf(id);
        if (!group) return false;
        return groupState(group).presentedId === id;
      },

      isBusy(group = 'root') {
        return groupState(group).inFlight !== null;
      },
    };
  }, []);

  return <SheetPresentationContext.Provider value={coordinator}>{children}</SheetPresentationContext.Provider>;
}

/** The imperative shim a wrapper exposes via `forwardRef`. Source-compatible with
 * `@expo/ui` `BottomSheetMethods` for the methods our call sites use, but
 * present/dismiss/close route through the coordinator instead of the native ref. */
export type ManagedSheetHandle = Pick<
  BottomSheetMethods,
  'present' | 'dismiss' | 'close' | 'forceClose' | 'snapToIndex' | 'snapToPosition' | 'expand' | 'collapse'
> & {
  dismissAndWait: () => Promise<DismissAndWaitResult>;
};

/** Await a mounted managed sheet, or succeed immediately when no native
 * surface exists. `aborted` is reserved for a registered host disappearing
 * while its dismissal is already in flight. */
export function dismissManagedSheetAndWait(
  handle: Pick<ManagedSheetHandle, 'dismissAndWait'> | null | undefined,
): Promise<DismissAndWaitResult> {
  return handle ? handle.dismissAndWait() : Promise.resolve(DISMISSED_RESULT);
}

type UseManagedSheetOptions = {
  /** Controlled open state. Pass a boolean to drive the sheet declaratively;
   * leave `undefined` for purely imperative consumers (drive via the returned
   * `handle` / a forwarded ref) — then the prop never fights the ref. */
  open?: boolean;
  group?: PresenterGroup;
  /** The native `@expo/ui` sheet ref the wrapper renders. */
  sheetRef: RefObject<BottomSheetMethods | null>;
  /** Fired when the user closes the sheet themselves (pan-down / backdrop), so
   * the parent can clear the state that drove `open`. Not fired for coordinator-
   * initiated closes (the parent already drove those). */
  onClose?: () => void;
  /** Fired AFTER the dismiss animation has really settled. */
  onFullyDismissed?: () => void;
};

/**
 * The bridge every sheet wrapper uses: registers with the coordinator, reconciles
 * the controlled `open` prop, and returns the native `onChange`/`onFullyDismissed`
 * handlers plus the imperative `handle`. All the "is it coordinator- or user-
 * initiated" bookkeeping lives here, in one place, instead of a per-consumer
 * `isPresentedRef` effect.
 */
export function useManagedSheet({
  open,
  group = 'root',
  sheetRef,
  onClose,
  onFullyDismissed,
}: UseManagedSheetOptions): {
  onChange: (index: number) => void;
  onFullyDismissed: () => void;
  handle: ManagedSheetHandle;
} {
  const id = useId();
  const coordinator = useSheetPresentation();
  // True while the coordinator is the one dismissing, so the synchronous native
  // close callback isn't mistaken for a user pan-down.
  const selfDismissRef = useRef(false);
  const desiredIndexRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onFullyDismissedRef = useRef(onFullyDismissed);
  onFullyDismissedRef.current = onFullyDismissed;

  const present = useCallback(() => {
    sheetRef.current?.snapToIndex(desiredIndexRef.current);
  }, [sheetRef]);
  const dismiss = useCallback(() => {
    selfDismissRef.current = true;
    sheetRef.current?.dismiss();
  }, [sheetRef]);
  const fireFullyDismissed = useCallback(() => {
    onFullyDismissedRef.current?.();
  }, []);
  // Displaced by another sheet in the group: closed, not suspended. Fire the
  // same onClose a user pan-down fires so the parent clears the state that
  // drove `open` — otherwise the sheet re-presents when the displacer closes.
  // No notifyClosed here: the coordinator is driving this dismiss itself.
  const fireDisplaced = useCallback(() => {
    onCloseRef.current?.();
  }, []);

  useEffect(
    () =>
      coordinator.register({
        id,
        group,
        present,
        dismiss,
        onFullyDismissed: fireFullyDismissed,
        onDisplaced: fireDisplaced,
      }),
    [coordinator, id, group, present, dismiss, fireFullyDismissed, fireDisplaced],
  );

  // Controlled mode only: an imperative consumer leaves `open` undefined so this
  // effect never overrides a ref-driven present/dismiss.
  useEffect(() => {
    if (open === undefined) return;
    coordinator.setDesiredOpen(id, open);
  }, [coordinator, id, open]);

  const handleNativeChange = useCallback(
    (index: number) => {
      if (index === -1) {
        const self = selfDismissRef.current;
        selfDismissRef.current = false;
        if (!self) {
          // User-initiated close (pan-down / backdrop). Let the parent clear its
          // state and open a settle window in the coordinator.
          onCloseRef.current?.();
          coordinator.notifyClosed(id);
        }
      } else {
        desiredIndexRef.current = index;
      }
    },
    [coordinator, id],
  );

  const handleNativeFullyDismissed = useCallback(() => {
    coordinator.notifyFullyDismissed(id);
  }, [coordinator, id]);

  const handle = useMemo<ManagedSheetHandle>(
    () => ({
      present: () => coordinator.setDesiredOpen(id, true),
      dismiss: () => coordinator.setDesiredOpen(id, false),
      dismissAndWait: () => coordinator.dismissAndWait(id),
      close: () => coordinator.setDesiredOpen(id, false),
      forceClose: () => coordinator.setDesiredOpen(id, false),
      snapToIndex: (index: number) => {
        if (index < 0) {
          coordinator.setDesiredOpen(id, false);
          return;
        }
        desiredIndexRef.current = index;
        // Already up → just change the detent live; otherwise open at this index.
        if (coordinator.isPresented(id)) sheetRef.current?.snapToIndex(index);
        else coordinator.setDesiredOpen(id, true);
      },
      snapToPosition: (position: string | number) => sheetRef.current?.snapToPosition(position),
      expand: () => sheetRef.current?.expand(),
      collapse: () => sheetRef.current?.collapse(),
    }),
    [coordinator, id, sheetRef],
  );

  return { onChange: handleNativeChange, onFullyDismissed: handleNativeFullyDismissed, handle };
}
