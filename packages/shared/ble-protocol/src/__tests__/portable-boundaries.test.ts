/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const portablePackages = [
  'ble-core',
  'aurora-ble-protocol',
  'kilter-ble-protocol',
  'moonboard-ble-protocol',
  'woods-ble-protocol',
  'wled-ble-protocol',
];
const allowedDependencies = portablePackages.map((name) => `@boardsesh/${name}`);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('portable BLE dependency boundary', () => {
  it.each(portablePackages)('%s imports only its sources or other portable BLE packages', (name) => {
    const directory = join(packagesRoot, name);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      expect(allowedDependencies).toContain(dependency);
    for (const path of sourceFiles(join(directory, 'src'))) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (specifier.startsWith('.')) {
          expect(resolve(dirname(path), specifier).startsWith(`${directory}/src/`), `${path}: ${specifier}`).toBe(true);
        } else {
          expect(allowedDependencies, `${path}: ${specifier}`).toContain(
            specifier.replace(/^(@boardsesh\/[^/]+).*$/, '$1'),
          );
        }
      }
    }
  });
});
