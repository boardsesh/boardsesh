/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ignoredRepoRelativePaths, services } from '../create-service-docker-context.mjs';

// Nothing in CI builds Dockerfile.web: branch-deploy.yml's `pull_request`
// trigger is commented out (workflow_dispatch only) and railway.toml carries a
// `[deploy]` block for the backend image alone. So there is no build to fail if
// the retired Expo export step comes back — this text pin is the only oracle.
// W-24 / #4438.
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfile = readFileSync(join(repositoryRoot, 'Dockerfile.web'), 'utf8');

describe('Dockerfile.web after the /app retirement', () => {
  it('runs no Expo web export', () => {
    // The browser app ships only at app.boardsesh.com. #3795 moves web serving
    // to this image, at which point a surviving export step would publish a
    // second SPA copy at www/app built with different env.
    expect(dockerfile).not.toContain('build-expo-web-export.sh');
    expect(dockerfile).not.toContain('packages/web/public/app');
  });

  it('keeps the runner-stage BOARDSESH_WEB flag', () => {
    // Read at REQUEST time, not build time: app/layout.tsx gates the
    // cross-subdomain Expo auth bridge on it (the www half of how
    // app.boardsesh.com signs in) and middleware.ts gates the /app carve-out.
    // Deleting it with the builder-stage copy would break sign-in on the
    // subdomain, silently.
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));
    expect(runnerStage).toContain('ARG BOARDSESH_WEB');
    expect(runnerStage).toContain('ENV BOARDSESH_WEB=$BOARDSESH_WEB');
  });

  it('still ships the built public/ directory to the runner', () => {
    // Unrelated to the export (it carries icons, images, the well-known files);
    // it just happens to be the COPY the export used to ride on, so it is the
    // plausible collateral casualty of removing the export step.
    expect(dockerfile).toContain('COPY --from=builder /app/packages/web/public ./packages/web/public');
  });

  it('keeps every local export output out of the web build context', () => {
    // With no builder-stage rebuild left to overwrite it, this exclusion is the
    // only thing stopping a developer's local export (from `vp run build:expo-web`,
    // `dev:mobile:web-static`, or the `--subdomain` run this PR's own manual gate
    // asks for) riding into the image and being served as real files by the
    // runner's public/ COPY.
    //
    // Read the export script's own DEFAULT_OUTPUT_DIR values rather than pinning
    // a literal Set: a text pin stays green when the script grows a new output
    // directory the exclusion doesn't cover, which is exactly how
    // packages/web/public/app-standalone was missed.
    const exportScript = readFileSync(join(repositoryRoot, 'scripts', 'build-expo-web-export.sh'), 'utf8');
    const defaultOutputDirs = [
      ...new Set(
        [...exportScript.matchAll(/^[ \t]*DEFAULT_OUTPUT_DIR="\$ROOT_DIR\/([^"]+)"[ \t]*$/gm)].map(
          ([, repoRelativePath]) => repoRelativePath,
        ),
      ),
    ];

    expect(defaultOutputDirs).toEqual(
      expect.arrayContaining(['packages/web/public/app', 'packages/web/public/app-standalone']),
    );
    for (const outputDir of defaultOutputDirs) {
      expect([...(ignoredRepoRelativePaths as Set<string>)]).toContain(outputDir);
    }
  });

  it('copies the manifest patcher alongside the export script it shells out to', () => {
    // The export script is dead weight in this context until W-26 (#4442) drops
    // it, but while it is copied it must stay runnable: it invokes
    // scripts/lib/patch-expo-web-pwa-manifest.mjs by path.
    const { extraSourceFiles } = services.web as { extraSourceFiles: string[] };
    if (extraSourceFiles.includes('scripts/build-expo-web-export.sh')) {
      expect(extraSourceFiles).toContain('scripts/lib/patch-expo-web-pwa-manifest.mjs');
    }
  });
});
