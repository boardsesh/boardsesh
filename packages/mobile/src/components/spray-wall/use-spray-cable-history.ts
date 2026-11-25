import { useMemo, useState } from 'react';
import type { TnutLayout, TnutWiring } from '@boardsesh/spray-wall-geometry';

type CableSnapshot = { wiring: TnutWiring | undefined; pendingSkip: number };
type CableSession = { current: CableSnapshot; history: CableSnapshot[]; topology: string };
const HISTORY_LIMIT = 300;

export type SprayCableHistory = {
  pendingSkip: number;
  canUndo: boolean;
  change: (wiring: TnutWiring, pendingSkip?: number) => void;
  changeSteps: (wirings: TnutWiring[]) => void;
  undo: () => void;
};

/** One cable-editing session, retained by the wizard across its setup screens. */
export function useSprayCableHistory(
  layout: TnutLayout,
  onChange: (update: Partial<TnutLayout>) => void,
): SprayCableHistory {
  const { wiring, ledPositions, ledGroups, ledStripes } = layout;
  const topology = useMemo(
    () =>
      JSON.stringify([ledPositions?.map(({ id }) => id), ledGroups, ledStripes?.stripes.map(({ ledIds }) => ledIds)]),
    [ledPositions, ledGroups, ledStripes],
  );
  const [stored, setStored] = useState<CableSession>(() => ({
    current: { wiring, pendingSkip: 0 },
    history: [],
    topology,
  }));
  let session = stored;
  // A rebuilt cable/LED topology is a new baseline. Unrelated layout changes and
  // ordinary navigation retain the same wiring object and keep their history.
  if (stored.current.wiring !== wiring || stored.topology !== topology) {
    session = { current: { wiring, pendingSkip: 0 }, history: [], topology };
    setStored(session);
  }

  function change(nextWiring: TnutWiring, pendingSkip = 0) {
    if (nextWiring === wiring && pendingSkip === session.current.pendingSkip) return;
    setStored({
      topology,
      current: { wiring: nextWiring, pendingSkip },
      history: [...session.history, session.current].slice(-HISTORY_LIMIT),
    });
    if (nextWiring !== wiring) onChange({ wiring: nextWiring });
  }

  return {
    pendingSkip: session.current.pendingSkip,
    canUndo: session.history.length > 0,
    change,
    changeSteps: (wirings) => {
      if (!wirings.length) return;
      const snapshots = [session.current, ...wirings.slice(0, -1).map((step) => ({ wiring: step, pendingSkip: 0 }))];
      const nextWiring = wirings[wirings.length - 1];
      setStored({
        topology,
        current: { wiring: nextWiring, pendingSkip: 0 },
        history: [...session.history, ...snapshots].slice(-HISTORY_LIMIT),
      });
      onChange({ wiring: nextWiring });
    },
    undo: () => {
      const previous = session.history.at(-1);
      if (!previous) return;
      setStored({ current: previous, history: session.history.slice(0, -1), topology });
      // Only cable state is restored: newer hold links or photo edits survive.
      if (previous.wiring !== wiring) onChange({ wiring: previous.wiring });
    },
  };
}
