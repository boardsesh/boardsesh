import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vite-plus/test';

const geometryModuleUrl = new URL('../quantum-geometry-data.ts', import.meta.url);

describe('Quantum geometry module loading', () => {
  it('loads fixed geometry lazily from bare Node ESM, regardless of the working directory', () => {
    const nodeRequire = createRequire(import.meta.url);
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        nodeRequire.resolve('tsx/esm'),
        '--input-type=module',
        '--eval',
        `
          import { createRequire } from 'node:module';
          const nodeRequire = createRequire(${JSON.stringify(geometryModuleUrl.href)});
          const geometryPath = nodeRequire.resolve('./generated/quantum-geometry.cjs');
          const { getQuantumBundledGeometry } = await import(${JSON.stringify(geometryModuleUrl.href)});
          const loadedOnImport = geometryPath in nodeRequire.cache;
          const geometry = getQuantumBundledGeometry(9101, 9201);
          console.log(JSON.stringify({
            loadedOnImport,
            loadedOnAccess: geometryPath in nodeRequire.cache,
            placementCount: geometry.placements.length,
            frozen: Object.isFrozen(geometry.placements),
            sameGeometry: getQuantumBundledGeometry(9101, 9201) === geometry,
          }));
        `,
      ],
      { cwd: tmpdir(), encoding: 'utf8' },
    );

    expect(JSON.parse(output)).toEqual({
      loadedOnImport: false,
      loadedOnAccess: true,
      placementCount: 657,
      frozen: true,
      sameGeometry: true,
    });
  });
});
