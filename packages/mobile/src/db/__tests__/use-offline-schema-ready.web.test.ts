// The browser app has no offline SQLite: metro.config.js aliases `expo-sqlite` to
// src/web-shims/sqlite.tsx and database-provider.web.tsx never calls
// initializeDatabase, so nothing publishes a handle and the native readiness store
// would read false forever. Every gate built on it would then be permanently off,
// turning surfaces that render safe empty states today into dead ones.
//
// This fork is invisible to the native bundle and to `vp run typecheck:mobile`'s
// default resolution, so only `check:mobile-web-bundle` would catch it going wrong.
// Importing it explicitly here is the guard.

import { describe, expect, it } from 'vitest';
import { useOfflineSchemaReady } from '../use-offline-schema-ready.web';

describe('useOfflineSchemaReady (Expo web fork)', () => {
  it('reports ready unconditionally, with no store to subscribe to', () => {
    // Callable outside a render because it holds no hooks — that is the point: it
    // must not reach for the native store, which web never populates.
    expect(useOfflineSchemaReady()).toBe(true);
    expect(useOfflineSchemaReady()).toBe(true);
  });
});
