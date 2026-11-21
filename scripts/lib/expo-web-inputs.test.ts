/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appAffectingPaths, hasAppAffectingChanges, isAppAffecting } from './expo-web-inputs.mjs';

describe('standalone Expo web build inputs', () => {
  it('selects app inputs from a mixed PR while skipping unrelated work', () => {
    const changedPaths = [
      'docs/expo-web-deployment.md',
      'packages/backend/src/graphql/resolvers/climbs.ts',
      'packages/web/app/about/page.tsx',
      'packages/mobile/src/components/climb-row.tsx',
      'packages/shared/queue/src/reducer.ts',
      'packages/shared-schema/src/schema.ts',
      'packages/board-constants/src/generated/boards.ts',
      'packages/board-renderer/wasm/src/lib.rs',
    ];

    expect(appAffectingPaths(changedPaths)).toEqual(changedPaths.slice(3));
    expect(hasAppAffectingChanges(changedPaths)).toBe(true);
    expect(hasAppAffectingChanges(changedPaths.slice(0, 3))).toBe(false);
  });

  it('rebuilds for dependency, export, and deployed host changes', () => {
    const changedPaths = [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches/react-native-screens@4.26.2.patch',
      'packages/mobile/web-runtime/pnpm-lock.yaml',
      'scripts/build-expo-web-export.sh',
      'scripts/lib/patch-expo-web-pwa-manifest.mjs',
      'scripts/lib/inspect-expo-web-export.mjs',
      'deploy/app-subdomain/robots.txt',
      'deploy/app-subdomain/_routes.json',
      'deploy/app-subdomain/functions/_middleware.ts',
      '.github/workflows/expo-web-preview.yml',
      'scripts/lib/expo-web-preview-controller.cjs',
      'scripts/lib/expo-web-preview-cloudflare.mjs',
    ];

    expect(appAffectingPaths(changedPaths)).toEqual(changedPaths);
  });

  it('includes every board background statically required by the real app manifest', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const manifestPath = resolve(repoRoot, 'packages/mobile/src/lib/board-backgrounds-manifest.ts');
    const manifestSource = readFileSync(manifestPath, 'utf8');
    // Read the manifest as text: executing it would load Metro-only image
    // modules, and the trusted classifier must not execute app code.
    const bundledPaths = [...manifestSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(([, assetPath]) =>
      relative(repoRoot, resolve(dirname(manifestPath), assetPath)).replaceAll('\\', '/'),
    );

    expect(bundledPaths.length).toBeGreaterThan(0);
    expect(bundledPaths).toContain('packages/web/public/images/kilter/product_sizes_layouts_sets/36-1.webp');
    expect(bundledPaths.filter((filePath) => !isAppAffecting(filePath))).toEqual([]);
  });

  it('keeps marketing images and retained board PNG sources out of app inputs', () => {
    expect(
      appAffectingPaths([
        'packages/web/public/images/marketing/app-preview.webp',
        'packages/web/public/images/help/preview.webp',
        'packages/web/public/brand/boardsesh-mark.webp',
        'packages/web/public/images/kilter/product_sizes_layouts_sets/36-1.png',
        'packages/web/public/images/woods/woods-8x10-bg.png',
      ]),
    ).toEqual([]);
  });

  it('skips documentation and test-only revisions under app directories', () => {
    const changedPaths = [
      'packages/mobile/README.md',
      'packages/shared/queue/README.MD',
      'packages/shared/queue/src/__tests__/reducer.test.ts',
      'packages/mobile/src/__mocks__/renderer.ts',
      'packages/mobile/src/components/climb-row.spec.tsx',
      'packages/shared-schema/src/schema.test.ts',
      'deploy/app-subdomain/README.md',
      'deploy/app-subdomain/__tests__/headers.test.ts',
      'scripts/lib/expo-web-preview-controller.test.ts',
      'scripts/lib/expo-web-preview-controller.d.cts',
    ];

    expect(appAffectingPaths(changedPaths)).toEqual([]);
    expect(hasAppAffectingChanges(changedPaths)).toBe(false);
  });

  it('does not accidentally exclude native module or platform configuration inputs', () => {
    expect(isAppAffecting('packages/mobile/modules/board-renderer/ios/BoardRenderer.swift')).toBe(true);
    expect(isAppAffecting('packages/mobile/app.config.ts')).toBe(true);
    expect(isAppAffecting('packages/mobile/metro.config.js')).toBe(true);
    expect(isAppAffecting('packages/mobile/public/index.html')).toBe(true);
    expect(isAppAffecting('packages/shared/analytics/src/__tests__/fixture.md')).toBe(false);
  });

  it('accepts iterable path sources and handles an empty diff', () => {
    expect(appAffectingPaths(new Set(['docs/readme.md', 'packages/mobile/app/index.tsx']))).toEqual([
      'packages/mobile/app/index.tsx',
    ]);
    expect(hasAppAffectingChanges(new Set())).toBe(false);
  });
});
