/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { jobBlocks } from './helpers/workflow-yaml';

/**
 * The BuildKit cache contract for every service image, in one place.
 *
 * Why it is its own file rather than assertions bolted onto each workflow's
 * test: the three images share one contract, and the failure mode is asymmetry
 * — build-web fully asserted while build-backend only checked that it was NOT
 * using the old backend, and sync-deploy.yml asserted by nothing at all. A
 * shared table makes adding a fourth image a one-line change and makes a
 * missing image obvious.
 *
 * Background, so the option list below is not cargo-culted. `type=gha` cannot
 * work for these images: the repo Actions cache measured 36.45 GB across 227
 * entries against GitHub's 10 GB ceiling on 2026-09-02, so eviction is
 * continuous — four distinct ~843 MB dependency-layer blobs were written in 19
 * hours, i.e. the scope missed on essentially every build, while evicting the
 * mobile gradle caches it was competing with.
 */
const SERVICE_IMAGES = [
  {
    label: 'web',
    workflow: '.github/workflows/production-deploy.yml',
    job: 'build-web',
    // Written with the workflow's `env.` indirection, which is what keeps the
    // cache ref and the pushed image on the same repository.
    ref: '${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ env.WEB_IMAGE_NAME }}:buildcache-main',
  },
  {
    label: 'backend',
    workflow: '.github/workflows/production-deploy.yml',
    job: 'build-backend',
    ref: '${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ env.IMAGE_NAME }}:buildcache-main',
  },
  {
    label: 'sync',
    workflow: '.github/workflows/sync-deploy.yml',
    job: 'build-sync',
    ref: '${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ env.IMAGE_NAME }}:buildcache-main',
  },
] as const;

function jobSource(workflow: string, job: string): string {
  const block = jobBlocks(readFileSync(workflow, 'utf8')).get(job);
  if (!block) throw new Error(`${workflow} has no \`${job}\` job`);
  // Strip comment lines so a job's own rationale can never satisfy an assertion.
  return block.filter((line) => !line.trimStart().startsWith('#')).join('\n');
}

describe('service image build cache', () => {
  it('covers every job that builds and pushes a service image', () => {
    // Guards the table itself: a new service image whose build job nobody added
    // here would otherwise be silently unasserted, which is exactly how
    // sync-deploy.yml ended up with no coverage.
    const pushingJobs: string[] = [];
    for (const workflow of ['.github/workflows/production-deploy.yml', '.github/workflows/sync-deploy.yml']) {
      for (const [job, block] of jobBlocks(readFileSync(workflow, 'utf8'))) {
        const body = block.join('\n');
        if (body.includes('docker/build-push-action') && body.includes('push: true')) {
          pushingJobs.push(`${workflow}:${job}`);
        }
      }
    }
    expect(pushingJobs.sort()).toEqual(SERVICE_IMAGES.map((image) => `${image.workflow}:${image.job}`).sort());
  });

  describe.each(SERVICE_IMAGES)('$label', ({ workflow, job, ref }) => {
    const source = jobSource(workflow, job);

    it('reads and writes a registry cache on the same repository as the image', () => {
      // Same repository, not a separate `*-cache` package: when a cached layer
      // is also an image layer the blob already exists there under its own
      // digest, so the export is a manifest write plus "layer already exists"
      // instead of a second upload of the same ~843 MB.
      expect(source).toContain(`cache-from: type=registry,ref=${ref}`);
      expect(source).toContain(`cache-to: type=registry,ref=${ref},`);
    });

    it('exports every stage, in the media type GHCR accepts, without failing the release', () => {
      const cacheTo = source.split('\n').find((line) => line.includes('cache-to:'));
      expect(cacheTo, 'expected a cache-to line').toBeDefined();

      // mode=max is not cosmetic: Dockerfile.web is multi-stage, and both the
      // dependency layer and `next build` live in a stage the final image
      // discards. mode=min would cache the cheap runner COPYs and none of the
      // expensive work.
      expect(cacheTo).toContain('mode=max');
      // GHCR needs this pair; neither works without the other.
      expect(cacheTo).toContain('image-manifest=true');
      expect(cacheTo).toContain('oci-mediatypes=true');
      // This runs on the production deploy path: a GHCR 5xx while exporting a
      // cache must not turn a shipped release red.
      expect(cacheTo).toContain('ignore-error=true');
    });

    it('does not compress every layer twice', () => {
      // The image export stays gzip because that is what Railway pulls. A zstd
      // cache cannot share those blobs, so BuildKit would compress each layer
      // once for the image and again for the cache.
      expect(source).not.toContain('compression=zstd');
    });

    it('does not fall back to the Actions cache', () => {
      expect(source).not.toContain('type=gha');
    });
  });

  it('leaves no build pointing at an orphaned `-main` Actions cache scope', () => {
    // branch-deploy.yml used to fall back to `type=gha,scope=backend-main` and
    // `scope=web-main`. Nothing writes either any more — production-deploy.yml
    // exports to GHCR, and `web-main` was never written by anything — so those
    // fallbacks were guaranteed misses. A fallback that cannot hit is a lie in
    // the config, so it is asserted gone rather than left to reading.
    for (const workflow of [
      '.github/workflows/production-deploy.yml',
      '.github/workflows/sync-deploy.yml',
      '.github/workflows/branch-deploy.yml',
      '.github/workflows/ci.yml',
    ]) {
      const live = readFileSync(workflow, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      for (const scope of ['scope=web-main', 'scope=backend-main', 'scope=sync-main']) {
        expect(live, `${workflow} still uses ${scope}`).not.toContain(scope);
      }
    }
  });
});
