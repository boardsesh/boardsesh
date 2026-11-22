/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserAppAffectingPaths,
  hasBrowserAppAffectingChanges,
  hasNativeAppAffectingChanges,
  isBrowserAppAffecting,
  isNativeAppAffecting,
  nativeAppAffectingPaths,
} from './app-build-inputs.mjs';

describe('native and browser app build inputs', () => {
  it('skips backend work with shared regression tests and app QA recordings', () => {
    const changedPaths = [
      'packages/backend/src/graphql/resolvers/queue.ts',
      'packages/db/drizzle/0310_queue_fix.sql',
      'packages/shared/queue/src/__tests__/reducer.test.ts',
      'packages/mobile/src/lib/__mocks__/backend.ts',
      'packages/mobile/src/lib/reconnect.spec.tsx',
      'packages/mobile/.maestro/session.yaml',
      'packages/mobile/screenshot-fixtures/GetBoard/recording.json',
      'packages/mobile/vite.config.ts',
      'packages/shared/queue/docs/sequence.svg',
      'packages/mobile/docs/session.md',
      'packages/mobile/README.MD',
    ];

    expect(nativeAppAffectingPaths(changedPaths)).toEqual([]);
    expect(browserAppAffectingPaths(changedPaths)).toEqual([]);
    expect(hasNativeAppAffectingChanges(changedPaths)).toBe(false);
    expect(hasBrowserAppAffectingChanges(changedPaths)).toBe(false);
  });

  it('keeps shared schemas and root dependency changes conservative', () => {
    const changedPaths = [
      'packages/shared-schema/src/schema/support.ts',
      'packages/shared-schema/src/generated/schema.graphql',
      'packages/shared-schema/src/generated/types.ts',
      'packages/shared/graphql/src/generated/graphql.ts',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches/react-native@0.86.0.patch',
    ];

    expect(nativeAppAffectingPaths(changedPaths)).toEqual(changedPaths);
    expect(browserAppAffectingPaths(changedPaths)).toEqual(changedPaths);
  });

  it('builds each target for its shipped platform-specific inputs', () => {
    const browserOnlyPaths = [
      'packages/mobile/src/components/SignIn.web.tsx',
      'packages/mobile/src/lib/storage.web.js',
      'packages/shared/board-react/src/storage.web.mts',
      'packages/mobile/src/web-shims/sqlite.tsx',
      'packages/mobile/web-runtime/package.json',
      'packages/mobile/web-runtime/pnpm-lock.yaml',
      'packages/mobile/public/index.html',
      'packages/mobile/public/wasm/board_renderer_wasm_bg.wasm',
    ];

    expect(nativeAppAffectingPaths(browserOnlyPaths)).toEqual([]);
    expect(browserAppAffectingPaths(browserOnlyPaths)).toEqual(browserOnlyPaths);
    for (const changedPath of [
      'packages/mobile/app/play.tsx',
      'packages/shared/queue/src/reducer.ts',
      'packages/mobile/src/lib/auth.native.ts',
      'packages/mobile/modules/board-renderer/ios/BoardRenderer.swift',
      'packages/mobile/app.config.ts',
      'packages/mobile/metro.config.js',
      'packages/mobile/fingerprint.config.js',
    ]) {
      expect(isNativeAppAffecting(changedPath), changedPath).toBe(true);
      expect(isBrowserAppAffecting(changedPath), changedPath).toBe(true);
    }
  });

  it('does not confuse runtime fixture data with test recordings', () => {
    const changedPaths = [
      'packages/mobile/src/dev/fixtures/climbs.ts',
      'packages/mobile/src/lib/board-render/fixtures/recorded-climbs.json',
      'packages/shared/board-config/src/fixtures/board.json',
      'packages/board-constants/src/generated/boards.ts',
      'packages/board-renderer/wasm/src/lib.rs',
    ];

    expect(nativeAppAffectingPaths(changedPaths)).toEqual(changedPaths);
    expect(browserAppAffectingPaths(changedPaths)).toEqual(changedPaths);
  });

  it('includes every statically required board background for both targets', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const manifestPath = resolve(repoRoot, 'packages/mobile/src/lib/board-backgrounds-manifest.ts');
    const bundledPaths = [...readFileSync(manifestPath, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(
      ([, assetPath]) => relative(repoRoot, resolve(dirname(manifestPath), assetPath)).replaceAll('\\', '/'),
    );

    expect(bundledPaths.length).toBeGreaterThan(0);
    expect(bundledPaths.filter((filePath) => !isNativeAppAffecting(filePath))).toEqual([]);
    expect(bundledPaths.filter((filePath) => !isBrowserAppAffecting(filePath))).toEqual([]);
    expect(isNativeAppAffecting('packages/web/public/images/marketing/home.webp')).toBe(false);
    expect(isNativeAppAffecting('packages/web/public/images/kilter/original.png')).toBe(false);
  });

  it('keeps production and preview control inputs separate', () => {
    expect(isNativeAppAffecting('.github/workflows/mobile-ota-preview.yml')).toBe(true);
    expect(isNativeAppAffecting('.github/workflows/mobile-ota-preview.yml', 'production')).toBe(false);
    expect(isNativeAppAffecting('scripts/mobile-ota-promote.ts')).toBe(false);
    expect(isNativeAppAffecting('scripts/mobile-ota-promote.ts', 'production')).toBe(true);
    expect(isNativeAppAffecting('scripts/mobile-publish.ts')).toBe(true);
    expect(isNativeAppAffecting('scripts/mobile-publish.ts', 'production')).toBe(true);
    expect(isNativeAppAffecting('scripts/lib/app-build-inputs.mjs')).toBe(true);
    expect(isNativeAppAffecting('scripts/lib/app-build-inputs.mjs', 'production')).toBe(true);
    expect(isBrowserAppAffecting('scripts/lib/app-build-inputs.mjs')).toBe(true);
    expect(isBrowserAppAffecting('deploy/app-subdomain/functions/_middleware.ts')).toBe(true);
    expect(isNativeAppAffecting('deploy/app-subdomain/functions/_middleware.ts')).toBe(false);
    expect(isNativeAppAffecting('scripts/lib/app-build-inputs.test.ts')).toBe(false);
  });

  it('preserves mixed-diff ordering and accepts iterable path sources', () => {
    const changedPaths = new Set([
      'packages/backend/src/index.ts',
      'packages/mobile/app/play.tsx',
      'packages/mobile/src/components/climb-row.test.tsx',
      'packages/shared/queue/src/reducer.ts',
    ]);
    const expected = ['packages/mobile/app/play.tsx', 'packages/shared/queue/src/reducer.ts'];

    expect(nativeAppAffectingPaths(changedPaths)).toEqual(expected);
    expect(browserAppAffectingPaths(changedPaths)).toEqual(expected);
    expect(hasNativeAppAffectingChanges(new Set())).toBe(false);
    expect(hasBrowserAppAffectingChanges(new Set())).toBe(false);
  });
});
