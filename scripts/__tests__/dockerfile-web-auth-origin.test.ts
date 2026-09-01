/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Nothing in CI builds Dockerfile.web (branch-deploy.yml is workflow_dispatch
// only, and railway.toml's [deploy] block covers the backend image), so a text
// pin is the only oracle this file has. Same reasoning as
// dockerfile-web-no-expo-export.test.ts.
//
// What is being pinned: the runner stage must carry a canonical-origin variable
// of its own. It used to carry none — `ARG BASE_URL` / `ENV BASE_URL` sat in the
// BUILDER stage, and Next's standalone writer copies only `.env` and
// `.env.production`, never the tracked `packages/web/.env.local` that supplies
// NEXTAUTH_URL/BASE_URL on a laptop and on Vercel. The resulting container had
// no idea what origin it served: plain-named, Domain-less session cookies and
// localhost OAuth redirects, silently (issue #4651).
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfile = readFileSync(join(repositoryRoot, 'Dockerfile.web'), 'utf8');
const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));
const builderStage = dockerfile.slice(dockerfile.indexOf('AS builder'), dockerfile.indexOf('AS runner'));

describe('Dockerfile.web canonical auth origin', () => {
  it('splits into a builder and a runner stage', () => {
    // Every assertion below slices on these markers; if the stage names change,
    // the slices silently become the whole file and the pins stop meaning anything.
    expect(dockerfile).toContain('AS builder');
    expect(dockerfile).toContain('AS runner');
    expect(dockerfile.indexOf('AS builder')).toBeLessThan(dockerfile.indexOf('AS runner'));
  });

  it('declares BASE_URL in the runner stage, not only in the builder', () => {
    // Whole-line matches: `toContain('ARG BASE_URL')` is happily satisfied by
    // `ARG BASE_URL_SOMETHING_ELSE`, and text pinning is this file's only job.
    expect(builderStage).toMatch(/^ENV BASE_URL=\$BASE_URL$/m);
    expect(runnerStage).toMatch(/^ARG BASE_URL$/m);
    expect(runnerStage).toMatch(/^ENV BASE_URL=\$BASE_URL$/m);
  });

  it('documents that the runner ENV is an empty string without the build arg', () => {
    // `ENV BASE_URL=$BASE_URL` with no `--build-arg` bakes BASE_URL="" — the
    // variable is PRESENT and empty, not absent. Three transactional-email
    // routes read it, and `??` would have kept that empty string and stripped
    // the origin off every verification and password-reset link. They use
    // `?.trim() ||`; this pins the reason next to the cause.
    expect(runnerStage).toMatch(/empty string/i);
  });

  it('does not bake a NEXTAUTH_URL into the image', () => {
    // NEXTAUTH_URL is the direct authority for the cookie name, the cookie
    // domain and the OAuth redirect_uri. Baking one into a reusable image is how
    // a preview container ends up claiming the production origin — and writing
    // Domain=.boardsesh.com from a preview host, which a browser accepts and a
    // preview sign-out then uses to delete the production cookie. It is supplied
    // at run time (branch-deploy.yml `-e NEXTAUTH_URL=…`, Railway service vars).
    expect(dockerfile).not.toContain('ENV NEXTAUTH_URL');
  });

  it('healthchecks over HTTP, not a bare TCP connect', () => {
    // A socket that accepts proves nothing: Next keeps listening after a failed
    // server prepare and 500s every request. The pre-#4651 container reported
    // `healthy` while answering nothing — measured, not assumed.
    expect(runnerStage).toContain('HEALTHCHECK');
    expect(runnerStage).not.toContain("require('net')");
    expect(runnerStage).toContain("require('http')");
    expect(runnerStage).toContain('statusCode<500');
  });

  it('keeps the runner on NODE_ENV=production, which is what the boot guard keys on', () => {
    // diagnoseCanonicalOrigin() treats NODE_ENV=production as "this is a built
    // production server" — the host-agnostic replacement for VERCEL_ENV. Drop
    // this and the container that has no origin boots quietly again.
    expect(runnerStage).toContain('ENV NODE_ENV=production');
  });

  it('stamps immutable build identity into source before compiling', () => {
    expect(builderStage).toMatch(/^ARG SENTRY_RELEASE$/m);
    expect(builderStage).toMatch(/^ARG BOARDSESH_BUILD_RELEASE$/m);
    expect(builderStage).toContain('BOARDSESH_BUILD_RELEASE_UNSTAMPED');
    expect(builderStage).toContain('packages/web/app/api/health/build-release.ts');
    expect(runnerStage).not.toMatch(/^ENV SENTRY_RELEASE=/m);
  });
});
