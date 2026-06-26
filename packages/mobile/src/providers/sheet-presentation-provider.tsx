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
 *      sheet handoffs safe and enforces docs hard-rule 1 at runtime.
 *
 * "Settled" is detected two ways: a fixed per-platform timer (the baseline, works
 * with no native support), upgraded to the real post-animation signal when the
 * `@expo/ui` patch forwards SwiftUI's `onDismiss` (see notifyFullyDismissed). The
 * timer then degrades to a ceiling/fallback.
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

/** How long after JS asks a native sheet to dismiss we treat it as still
 * animating (the ceiling before we let the next transition run). iOS modal sheet
 * present/dismiss is ~0.4-0.5s; Android material is quicker. Used as a fallback
 * when the accurate native `onDismiss` signal isn't available (pre-patch, or when
 * a Host was torn down mid-animation and the event never arrives). */
const IOS_SHEET_SETTLE_MS = 550;
const ANDROID_SHEET_SETTLE_MS = 350;
const SETTLE_MS = Platform.OS === 'ios' ? IOS_SHEET_SETTLE_MS : ANDROID_SHEET_SETTLE_MS;

type Registration = {
  group: PresenterGroup;
  present: () => void;
  dismiss: () => void;
  onFullyDismissed?: () => void;
};

type InFlight = {
  op: 'present' | 'dismiss';
  id: string;
  timer: ReturnType<typeof setTimeout>;
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
        registrations.current.get(inFlight.id)?.onFullyDismissed?.();
        if (__DEV__ && viaCeiling) {
          console.warn(
            `[sheet-presentation] dismiss of "${inFlight.id}" settled via the ${SETTLE_MS}ms ceiling timer ` +
              `(no native onDismiss). If this is frequent on a device, the dismiss animation outran the ceiling.`,
          );
        }
      }
      pump(group);
    }

    function startTransition(group: PresenterGroup, op: 'present' | 'dismiss', id: string): void {
      const state = groupState(group);
      const timer = setTimeout(() => onSettle(group, true), SETTLE_MS);
      state.inFlight = { op, id, timer };
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
        startTransition(group, 'dismiss', have);
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
        });
        groupState(reg.group);
        return () => {
          const state = groupState(reg.group);
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
            state.inFlight = { op: 'dismiss', id: reg.id, timer };
          } else {
            pump(reg.group);
          }
        };
      },

      setDesiredOpen(id, open) {
        const prev = desired.current.get(id);
        const seq = open ? (seqCounter.current += 1) : (prev?.seq ?? 0);
        desired.current.set(id, { open, seq });
        const group = groupOf(id);
        if (group) pump(group);
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
          state.inFlight = { op: 'dismiss', id, timer };
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
>;

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
  /** Snap index used when presenting (default 0). */
  presentIndex?: number;
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
  presentIndex = 0,
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
  const desiredIndexRef = useRef(presentIndex);
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

  useEffect(
    () => coordinator.register({ id, group, present, dismiss, onFullyDismissed: fireFullyDismissed }),
    [coordinator, id, group, present, dismiss, fireFullyDismissed],
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
