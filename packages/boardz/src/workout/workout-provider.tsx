import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
import type { Climb } from '@boardsesh/shared-schema';
import { readJson, removeStored, writeJson } from '../storage/json-storage';
import type { WorkoutKind } from './catalog';
import {
  applyEvent,
  startRunner,
  type RunnerEvent,
  type RunnerLog,
  type RunnerState,
  type WorkoutTiming,
} from './engine';

const STORAGE_KEY = 'boardz.workout.active';

export type ActiveWorkout = {
  id: string;
  kind: WorkoutKind;
  title: string;
  climbs: Climb[];
  /** Null for free climbing, which runs on the session clock alone. */
  timing: WorkoutTiming | null;
  runner: RunnerState | null;
  goalMinutes: number | null;
  startedAt: number;
};

export type NewWorkout = Pick<ActiveWorkout, 'kind' | 'title' | 'climbs' | 'timing' | 'goalMinutes'>;

// Only the fields the app reads back are checked; a stored workout from an
// older build that doesn't match is simply dropped.
function isActiveWorkout(value: unknown): value is ActiveWorkout {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.kind === 'string' &&
    typeof candidate.title === 'string' &&
    Array.isArray(candidate.climbs) &&
    candidate.climbs.every(
      (climb) =>
        typeof climb === 'object' &&
        climb !== null &&
        typeof (climb as Record<string, unknown>).uuid === 'string' &&
        typeof (climb as Record<string, unknown>).frames === 'string',
    ) &&
    typeof candidate.startedAt === 'number' &&
    (candidate.timing === null || typeof candidate.timing === 'object') &&
    (candidate.runner === null || typeof candidate.runner === 'object')
  );
}

type WorkoutContextValue = {
  workout: ActiveWorkout | null;
  start: (workout: NewWorkout) => void;
  /** Feed the runner a tap or a clock tick. Returns what to log, if anything. */
  dispatch: (event: RunnerEvent) => RunnerLog | null;
  end: () => void;
};

const WorkoutContext = createContext<WorkoutContextValue | null>(null);

export function WorkoutProvider({ children }: { children: ReactNode }) {
  const [workout, setWorkout] = useState<ActiveWorkout | null>(null);
  // Mirrors `workout` so two events in one frame each build on the other's result.
  const workoutRef = useRef<ActiveWorkout | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readJson(STORAGE_KEY, isActiveWorkout).then((stored) => {
      if (cancelled || workoutRef.current) return;
      workoutRef.current = stored;
      setWorkout(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = (next: ActiveWorkout | null) => {
    workoutRef.current = next;
    setWorkout(next);
    if (next) writeJson(STORAGE_KEY, next);
    else removeStored(STORAGE_KEY);
  };

  const value: WorkoutContextValue = {
    workout,
    start: (newWorkout) => {
      const now = Date.now();
      commit({
        ...newWorkout,
        id: randomUUID(),
        startedAt: now,
        runner: newWorkout.timing
          ? startRunner({ timing: newWorkout.timing, climbCount: newWorkout.climbs.length }, now)
          : null,
      });
    },
    dispatch: (event) => {
      const current = workoutRef.current;
      if (!current?.timing || !current.runner) return null;
      const { state, log } = applyEvent(
        { timing: current.timing, climbCount: current.climbs.length },
        current.runner,
        event,
      );
      if (state !== current.runner) commit({ ...current, runner: state });
      return log;
    },
    end: () => commit(null),
  };

  return <WorkoutContext.Provider value={value}>{children}</WorkoutContext.Provider>;
}

export function useWorkout(): WorkoutContextValue {
  const context = useContext(WorkoutContext);
  if (!context) throw new Error('useWorkout must be used inside WorkoutProvider');
  return context;
}
