/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Nothing in CI builds Dockerfile.web: branch-deploy.yml's `pull_request`
// trigger is commented out (workflow_dispatch only) and railway.toml carries a
// `[deploy]` block for the backend image alone. So there is no build to fail if
// the retired Expo export step comes back — this text pin is the only oracle.
// W-24 / #4438.
const dockerfile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Dockerfile.web'), 'utf8');

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
});
