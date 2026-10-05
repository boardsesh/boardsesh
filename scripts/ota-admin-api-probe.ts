/// <reference types="node" />

/**
 * Checks that the xprem admin API is still where scripts/lib/xprem-admin.mts
 * expects it, by reading the one public description of that API there is: the
 * dashboard's own JavaScript bundle.
 *
 * It downloads `/dashboard/`, finds the `assets/index-*.js` it names, and looks
 * for every string in XPREM_BUNDLE_MARKERS. A server upgrade that renames or
 * removes an endpoint drops its marker, and this exits 1 naming what is gone.
 *
 * What this proves: the paths and payload keys the client uses still appear in
 * the dashboard's source. What it does not prove: that a response still has the
 * shape the client parses, or that a write behaves as before. The markers are
 * fragments of minified source, so a marker can also disappear because the
 * bundler spelled the same path differently; read the bundle before assuming an
 * endpoint moved.
 *
 * No credentials and no writes: two anonymous GETs of public files.
 *
 *   vp run ota:api-probe
 *   node --experimental-strip-types scripts/ota-admin-api-probe.ts
 *
 * Env: OTA_BASE_URL or EXPO_UPDATES_URL (optional), else the declared server.
 * Exit codes: 0 every marker present, 1 a marker is missing, 2 the bundle could
 * not be fetched.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BASE_URL } from './lib/ota-branch-probe.ts';
import { XPREM_BUNDLE_MARKERS, adminBaseUrl, missingBundleMarkers } from './lib/xprem-admin.mts';

const LOG = '[ota-api-probe]';

/** The bundle the client was written against. A different name is expected after any server upgrade. */
export const BUNDLE_LAST_READ = 'index-Cnt5-VRw.js';

export interface ProbeResult {
  bundleName: string;
  missing: { marker: string; usedFor: string }[];
}

/** The bundle could not be downloaded, so nothing is known either way. */
export class BundleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleUnavailableError';
  }
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new BundleUnavailableError(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new BundleUnavailableError(`GET ${url} answered HTTP ${response.status}.`);
  return response.text();
}

export async function probeAdminApi(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const page = await fetchText(fetchImpl, `${baseUrl}/dashboard/`);
  const bundleName = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(page)?.[1];
  if (!bundleName) throw new BundleUnavailableError('The dashboard page names no assets/index-*.js bundle.');
  const bundleSource = await fetchText(fetchImpl, `${baseUrl}/dashboard/assets/${bundleName}`);
  return { bundleName, missing: missingBundleMarkers(bundleSource) };
}

export function formatProbe(result: ProbeResult): string[] {
  const lines = [`${LOG} dashboard bundle: ${result.bundleName}`];
  if (result.bundleName !== BUNDLE_LAST_READ) {
    lines.push(
      `${LOG} note: the client was written against ${BUNDLE_LAST_READ}. A new bundle is normal after a server upgrade.`,
    );
  }
  if (result.missing.length === 0) {
    lines.push(`${LOG} All ${XPREM_BUNDLE_MARKERS.length} admin API markers are present.`);
    return lines;
  }
  for (const { marker, usedFor } of result.missing) {
    lines.push(`${LOG} MISSING: ${marker} (used for: ${usedFor})`);
  }
  lines.push(
    `${LOG} ${result.missing.length} marker(s) are gone from the dashboard bundle. ` +
      'Re-read it and update scripts/lib/xprem-admin.mts before trusting ota:apply or the rollout tools.',
  );
  return lines;
}

async function main(): Promise<void> {
  const baseUrl = adminBaseUrl(process.env.OTA_BASE_URL || process.env.EXPO_UPDATES_URL || DEFAULT_BASE_URL);
  const result = await probeAdminApi(baseUrl);
  for (const line of formatProbe(result)) console.log(line);
  process.exitCode = result.missing.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof BundleUnavailableError ? 2 : 1;
  });
}
