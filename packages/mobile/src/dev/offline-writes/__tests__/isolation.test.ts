import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadOfflineWriteRoot, loadOfflineWriteScreen } from '../load';

const root = readFileSync(new URL('../../../../app/_layout.tsx', import.meta.url), 'utf8');
const isolated = readFileSync(new URL('../root.tsx', import.meta.url), 'utf8');

describe('native write QA isolation', () => {
  it('selects the development root before loading live application providers', () => {
    const selection = root.slice(root.indexOf('export default function RootLayout'));
    expect(selection.indexOf('const OfflineWriteRoot = loadOfflineWriteRoot()')).toBeLessThan(
      selection.indexOf('renderApplication()'),
    );
    expect(selection).toContain("__DEV__ && (process.env.EXPO_PUBLIC_OFFLINE_WRITE_QA === '1'");
    const boundary = root.slice(
      root.indexOf('export function ErrorBoundary'),
      root.indexOf('function renderApplication'),
    );
    expect(boundary.indexOf('const Boundary = loadOfflineWriteErrorBoundary()')).toBeLessThan(
      boundary.indexOf('loadApplication().ErrorBoundary'),
    );
    expect(isolated).not.toMatch(/AuthProvider|DatabaseProvider|QueryProvider|BluetoothProvider|AnalyticsProvider/);
  });

  it('guards every native QA entry point with compile-time __DEV__', () => {
    // The full release bundle check separately verifies Metro elimination.
    const loader = readFileSync(new URL('../load.ts', import.meta.url), 'utf8');
    expect(loader.match(/return __DEV__ \?/g)).toHaveLength(3);
    expect(typeof loadOfflineWriteRoot).toBe('function');
    expect(typeof loadOfflineWriteScreen).toBe('function');
  });
});
