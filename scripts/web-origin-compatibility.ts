/// <reference types="node" />
import { appendFileSync } from 'node:fs';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { normalizeRailwayWebOrigin } from './production-web-deploy-targets.mjs';
import { readWebRollbackBaseline } from './railway-deployment-rollback.mjs';
import { checkRetainedNextAssets, readBounded, type RetainedAssetFetch } from './retained-next-assets-smoke.ts';

type WebOriginOptions = {
  base: string;
  serviceId: string;
  expectedImage: string;
  expectedDeploymentId?: string;
  expectedRelease?: string;
  token: string;
  fetchImpl?: RetainedAssetFetch;
};

const RELEASE_SHA = /^[0-9a-f]{40}$/;

async function readPlatformJson(response: Response): Promise<unknown> {
  try {
    // The service history is limited to 100 rows, each including Railway's deployment metadata.
    return JSON.parse((await readBounded(response, 16 * 1024 * 1024)).toString('utf8')) as unknown;
  } finally {
    await response.body?.cancel();
  }
}

export async function checkWebOriginCompatibility({
  base,
  serviceId,
  expectedImage,
  expectedDeploymentId,
  expectedRelease,
  token,
  fetchImpl = fetch,
}: WebOriginOptions): Promise<{ deploymentId: string; release: string }> {
  const origin = normalizeRailwayWebOrigin(base);
  const options = { serviceId, expectedImage, token, fetchImpl, readJson: readPlatformJson };
  const before = await readWebRollbackBaseline(options);
  const deploymentId = before.serving.id;
  if (expectedDeploymentId !== undefined && deploymentId !== expectedDeploymentId.toLowerCase()) {
    throw new Error('Serving deployment differs from the captured previous deployment ID');
  }
  if (expectedRelease !== undefined && !RELEASE_SHA.test(expectedRelease))
    throw new Error('Expected a full previous release SHA');
  let verified;
  try {
    verified = await checkRetainedNextAssets(origin, { deploymentId, release: expectedRelease }, fetchImpl);
  } catch {
    // An invalid health body, redirect or header can contain private origin data.
    throw new Error('Serving web deployment failed its identity, capability or retained asset check');
  }
  if (!RELEASE_SHA.test(verified.release)) throw new Error('Serving web release is not a full commit SHA');
  const after = await readWebRollbackBaseline(options);
  if (!isDeepStrictEqual(before, after))
    throw new Error('Railway deployment state changed during the retained asset check');
  return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { base: { type: 'string' } } });
    const verified = await checkWebOriginCompatibility({
      base: values.base ?? '',
      serviceId: process.env.RAILWAY_SERVICE_ID ?? '',
      expectedImage: process.env.EXPECTED_IMAGE ?? '',
      expectedDeploymentId: process.env.EXPECTED_PREVIOUS_DEPLOYMENT_ID,
      expectedRelease: process.env.EXPECTED_PREVIOUS_RELEASE,
      token: process.env.RAILWAY_TOKEN ?? '',
    });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `verified_previous_deployment_id=${verified.deploymentId}\nverified_previous_release=${verified.release}\n`,
      );
    }
    console.log(`Verified web rollback deployment ${verified.deploymentId} at ${verified.release}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Web origin compatibility check failed');
    process.exitCode = 1;
  }
}
