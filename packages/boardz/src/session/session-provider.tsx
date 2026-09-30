import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
import { useBoard } from '../board/board-provider';
import { readJson, removeStored, writeJson } from '../storage/json-storage';
import {
  endSession,
  isSession,
  startSession,
  withServerUuid,
  withTick,
  withoutTick,
  type Session,
  type SessionTick,
} from './session';

const CURRENT_KEY = 'boardz.session.current';
const LAST_KEY = 'boardz.session.last';

export type NewTick = Omit<SessionTick, 'id' | 'loggedAt'>;

type SessionContextValue = {
  /** The running session, if any. */
  session: Session | null;
  /** The most recent finished session. */
  lastSession: Session | null;
  start: () => void;
  /** Finish the running session; it becomes `lastSession`. */
  end: () => void;
  /** Add a tick to the running session, starting one first if needed. Returns the tick's local id. */
  addTick: (tick: NewTick) => string;
  setTickServerUuid: (tickId: string, serverUuid: string) => void;
  removeTick: (tickId: string) => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { board } = useBoard();
  const [session, setSession] = useState<Session | null>(null);
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([readJson(CURRENT_KEY, isSession), readJson(LAST_KEY, isSession)]).then(([current, last]) => {
      if (cancelled) return;
      setSession(current);
      setLastSession(last);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist after hydration, so the first render's nulls never overwrite what's stored.
  useEffect(() => {
    if (!hydrated) return;
    if (session) writeJson(CURRENT_KEY, session);
    else removeStored(CURRENT_KEY);
  }, [session, hydrated]);

  useEffect(() => {
    if (hydrated && lastSession) writeJson(LAST_KEY, lastSession);
  }, [lastSession, hydrated]);

  const createSession = (now: Date, id: string): Session =>
    startSession({ id, now, boardLabel: board?.name ?? 'Board', angle: board?.angle ?? 0 });

  const value: SessionContextValue = {
    session,
    lastSession,
    start: () => {
      const id = randomUUID();
      setSession((current) => current ?? createSession(new Date(), id));
    },
    end: () => {
      if (!session) return;
      const finished = endSession(session, new Date());
      setLastSession(finished);
      setSession(null);
    },
    addTick: (tick) => {
      const tickId = randomUUID();
      const sessionId = randomUUID();
      const now = new Date();
      setSession((current) =>
        withTick(current ?? createSession(now, sessionId), { ...tick, id: tickId, loggedAt: now.toISOString() }),
      );
      return tickId;
    },
    setTickServerUuid: (tickId, serverUuid) => {
      setSession((current) => (current ? withServerUuid(current, tickId, serverUuid) : current));
    },
    removeTick: (tickId) => {
      setSession((current) => (current ? withoutTick(current, tickId) : current));
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
