'use client';

import { useSyncExternalStore } from 'react';
import type { BrowserSessionContextValue as SessionContextValue } from '../providers/session-provider';
import type { ConsentAccountTransport } from '../consent/consent-account-transport';

type MarketingSessionSnapshot = {
  session: SessionContextValue;
  token: string | null;
  transport?: ConsentAccountTransport;
};
const LOADING_SESSION: SessionContextValue = { data: null, status: 'loading', update: async () => null };
const INITIAL_SNAPSHOT: MarketingSessionSnapshot = { session: LOADING_SESSION, token: null };
let snapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();

export function publishMarketingSession(session: SessionContextValue): void {
  const previous = snapshot.session;
  const sameOwner =
    previous.data?.user.id === session.data?.user.id && previous.data?.authSessionId === session.data?.authSessionId;
  snapshot = {
    session,
    token: sameOwner && session.status === 'authenticated' ? snapshot.token : null,
    transport: snapshot.transport,
  };
  listeners.forEach((listener) => listener());
}

export function publishMarketingConsentTransport(
  token: string | null,
  transport: ConsentAccountTransport,
  owner: SessionContextValue,
): void {
  const current = snapshot.session;
  if (
    current.status !== 'authenticated' ||
    owner.status !== 'authenticated' ||
    current.data.user.id !== owner.data.user.id ||
    current.data.authSessionId !== owner.data.authSessionId
  )
    return;
  snapshot = { ...snapshot, token, transport };
  listeners.forEach((listener) => listener());
}

export function clearMarketingSession(): void {
  snapshot = INITIAL_SNAPSHOT;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** This store only mirrors the one guarded session owner; it never reads a cookie. */
export function useMarketingSession(): MarketingSessionSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => INITIAL_SNAPSHOT,
  );
}
