/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sentinel = 'BOARDSESH_BUILD_RELEASE_UNSTAMPED';
const releaseSha = '0123456789abcdef0123456789abcdef01234567';

const targets = [
  {
    dockerfile: 'Dockerfile.web',
    source: 'packages/web/app/api/health/build-release.ts',
  },
  {
    dockerfile: 'Dockerfile.backend',
    source: 'packages/backend/src/build-release.ts',
  },
];

describe('Docker build release stamping', () => {
  for (const target of targets) {
    it(`stamps exactly one immutable release in ${target.dockerfile}`, async () => {
      const dockerfileSource = readFileSync(join(repositoryRoot, target.dockerfile), 'utf8');
      const releaseSource = readFileSync(join(repositoryRoot, target.source), 'utf8');
      const sentinelMatches = releaseSource.match(new RegExp(sentinel, 'g')) ?? [];
      const sentinelPrecheck = `test "$(grep -Fxc "const STAMPED_RELEASE = '${sentinel}';" ${target.source})" -eq 1`;
      const releasePostcheck = `grep -Fqx "const STAMPED_RELEASE = '$BOARDSESH_BUILD_RELEASE';" ${target.source}`;
      const sentinelPostcheck = `! grep -qF '${sentinel}' ${target.source}`;
      const replacement = `s/${sentinel}/$BOARDSESH_BUILD_RELEASE/`;

      expect(sentinelMatches).toHaveLength(1);
      expect(dockerfileSource).toContain(replacement);
      expect(dockerfileSource).toContain(sentinelPrecheck);
      expect(dockerfileSource).toContain(releasePostcheck);
      expect(dockerfileSource).toContain(sentinelPostcheck);
      expect(dockerfileSource.indexOf(sentinelPrecheck)).toBeLessThan(dockerfileSource.indexOf(replacement));
      expect(dockerfileSource.indexOf(releasePostcheck)).toBeGreaterThan(dockerfileSource.indexOf(replacement));
      expect(dockerfileSource.indexOf(sentinelPostcheck)).toBeGreaterThan(dockerfileSource.indexOf(replacement));

      const stampedSource = releaseSource.replace(sentinel, releaseSha);
      expect(stampedSource).not.toContain(sentinel);
      expect(stampedSource).toContain(`const STAMPED_RELEASE = '${releaseSha}'`);
      expect(stampedSource).toContain("STAMPED_RELEASE.endsWith('_UNSTAMPED')");

      const stampedModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stampedSource)}#${target.dockerfile}`;
      const stampedModule = (await import(/* @vite-ignore */ stampedModuleUrl)) as { BUILD_RELEASE: unknown };
      expect(stampedModule.BUILD_RELEASE).toBe(releaseSha);
    });
  }
});
