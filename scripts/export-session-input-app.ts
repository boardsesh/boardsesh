/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  inspectCachedSimulatorApp,
  SESSION_INPUT_APP_CACHE,
  SESSION_INPUT_NATIVE_HASHES,
  sha256,
} from './lib/session-input-observation/cached-app.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, '.boardsesh/session-input-app-export');
export function exportCachedInputApp(): number {
  const metadata = join(DIRECTORY, 'metadata');
  mkdirSync(metadata, { recursive: true });
  const receipt: Record<string, unknown> = {
    kind: 'cached-debug-dev-client-export-only',
    safe: false,
    cacheHit: process.env.OBSERVATION_CACHE_HIT === 'true',
    cacheKey: process.env.OBSERVATION_CACHE_KEY,
    expectedNativeHashes: SESSION_INPUT_NATIVE_HASHES,
  };
  const writeReceipt = () => writeFileSync(join(metadata, 'inventory.json'), JSON.stringify(receipt, null, 2) + '\n');
  try {
    if (process.platform !== 'darwin' || process.env.CI !== 'true' || process.env.SESSION_INPUT_APP_EXPORT !== '1')
      throw new Error('ci_export_only');
    if (!receipt.cacheHit || receipt.cacheKey !== SESSION_INPUT_APP_CACHE)
      throw new Error('exact_cached_app_required_no_build');
    const app = join(ROOT, 'packages/mobile/.app-cache/Boardsesh.app');
    if (!existsSync(app)) throw new Error('cached_app_missing');
    const inventory = inspectCachedSimulatorApp(app);
    Object.assign(receipt, inventory);
    writeReceipt();
    if (!inventory.safe) throw new Error('cached_app_inventory_rejected');
    // Signing is read-only. Only entitlement KEY names are retained, never XML/config values.
    const signing = spawnSync('codesign', ['-d', '--entitlements', ':-', app], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    if (signing.status !== 0) throw new Error('signing_metadata_unavailable');
    const entitlements = spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      input: signing.stdout,
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    if (entitlements.status !== 0) throw new Error('entitlement_metadata_unreadable');
    receipt.entitlementKeys = Object.keys(JSON.parse(entitlements.stdout) as Record<string, unknown>);
    const source = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    if (source.status !== 0) throw new Error('source_identity_unavailable');
    receipt.source = source.stdout.trim();
    const binary = join(DIRECTORY, 'binary');
    mkdirSync(binary, { recursive: true });
    const archive = join(binary, 'Boardsesh-ci-sdk26_5.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', dirname(app), 'Boardsesh.app'], {
      stdio: 'ignore',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    if (tar.status !== 0) throw new Error('archive_failed');
    const afterArchive = inspectCachedSimulatorApp(app);
    if (!afterArchive.safe || JSON.stringify(afterArchive.files) !== JSON.stringify(inventory.files))
      throw new Error('source_app_changed_during_archive');
    receipt.archive = {
      file: 'Boardsesh-ci-sdk26_5.tar.gz',
      bytes: readFileSync(archive).length,
      sha256: sha256(readFileSync(archive)),
      format: 'tar-gzip; original paths, permissions, symlinks and file bytes; no resign or plist edits',
    };
    receipt.safe = true;
    writeReceipt();
    if (!process.env.GITHUB_OUTPUT) throw new Error('github_output_missing');
    appendFileSync(process.env.GITHUB_OUTPUT, 'safe=true\n');
    console.log('cached_app_export_inspected_and_ready');
    return 0;
  } catch (error) {
    receipt.safe = false;
    receipt.failure =
      error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'inventory_error_redacted';
    writeReceipt();
    console.error('cached_app_export_stopped_before_binary_upload');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = exportCachedInputApp();
