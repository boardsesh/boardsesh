/// <reference types="node" />
/** Match packaged ELF build IDs to unstripped owned libraries before release. */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createSentryUploadEnvironment } from './mobile-upload-sourcemaps';
import { resolveSentryCli } from './mobile-upload-dsyms';

export const OWNED_ANDROID_LIBRARIES = [
  'libboard_renderer_jni.so',
  'libboard_renderer_ffi.so',
  'libboardsesh_diagnostics.so',
] as const;
export function parseElfDiagnostics(output: string): { buildId: string; hasDwarf: boolean } {
  const buildId = /Build ID:\s*([a-f0-9]+)/i.exec(output)?.[1]?.toLowerCase();
  if (!buildId) throw new Error('ELF library has no GNU build ID.');
  return { buildId, hasDwarf: /\.debug_info\b/.test(output) };
}
function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(filename) : entry.isFile() ? [filename] : [];
  });
}
export function matchOwnedElf(
  packaged: { name: string; abi: string; buildId: string },
  candidates: Array<{ path: string; abi: string; buildId: string; hasDwarf: boolean }>,
): string {
  const matching = candidates.filter(
    (candidate) =>
      candidate.abi === packaged.abi &&
      basename(candidate.path) === packaged.name &&
      candidate.buildId === packaged.buildId &&
      candidate.hasDwarf,
  );
  if (!matching.length)
    throw new Error(`No matching DWARF symbols for ${packaged.abi}/${packaged.name} (${packaged.buildId}).`);
  return matching[0].path;
}
export function parseSentryElfDebugId(output: string, buildId: string): string {
  const checked = JSON.parse(output) as {
    type?: string;
    is_usable?: boolean;
    features?: string;
    variants?: Array<{ debug_id?: string; code_id?: string }>;
  };
  const matching = checked.variants?.find((variant) => variant.code_id === buildId);
  if (
    checked.type !== 'elf' ||
    checked.is_usable !== true ||
    !/\bdebug\b/.test(checked.features ?? '') ||
    !matching?.debug_id
  )
    throw new Error('Sentry ELF check has no usable DWARF matching the packaged build ID.');
  return matching.debug_id;
}
export function assertPackagedOwnedLibraries(archive: string, entries: Array<{ name: string; abi: string }>): void {
  const abis = new Set(entries.map((entry) => entry.abi));
  if (!abis.size) throw new Error(`No packaged native libraries in ${archive}.`);
  for (const abi of abis) {
    for (const name of OWNED_ANDROID_LIBRARIES) {
      if (!entries.some((entry) => entry.name === name && entry.abi === abi))
        throw new Error(`Required owned library ${abi}/${name} is absent from ${archive}.`);
    }
  }
}
export function uploadAndroidSymbols(mobileDir = resolve('packages/mobile')): void {
  const environment = createSentryUploadEnvironment(process.env);
  const androidSdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!androidSdk) throw new Error('ANDROID_HOME is required for llvm-readelf.');
  const ndkVersions = readdirSync(join(androidSdk, 'ndk')).sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  const readelf = filesBelow(join(androidSdk, 'ndk', ndkVersions.at(-1) ?? '', 'toolchains', 'llvm', 'prebuilt')).find(
    (filename) => basename(filename) === 'llvm-readelf',
  );
  if (!readelf) throw new Error('Installed Android NDK has no llvm-readelf.');
  const inspect = (filename: string) =>
    parseElfDiagnostics(execFileSync(readelf, ['--notes', '--sections', filename], { encoding: 'utf8' }));
  const symbols = filesBelow(join(mobileDir, 'modules'))
    .filter((filename) =>
      OWNED_ANDROID_LIBRARIES.includes(basename(filename) as (typeof OWNED_ANDROID_LIBRARIES)[number]),
    )
    .flatMap((filename) => {
      try {
        return [
          {
            path: filename,
            abi:
              filename.split('/').find((segment) => ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'].includes(segment)) ??
              '',
            ...inspect(filename),
          },
        ];
      } catch {
        return [];
      }
    });
  const outputRoot = join(mobileDir, 'android', 'app', 'build', 'outputs');
  const archives = filesBelow(outputRoot).filter((filename) =>
    /(?:apk|bundle)\/release\/[^/]+\.(apk|aab)$/.test(filename),
  );
  if (
    !archives.some((filename) => filename.endsWith('.aab')) ||
    !archives.some((filename) => filename.endsWith('.apk'))
  )
    throw new Error('Release APK and AAB archives are required for native inventory.');
  const extractedRoot = mkdtempSync(join(tmpdir(), 'boardsesh-packaged-elf-'));
  const packaged: Array<{ filename: string; archive: string }> = [];
  try {
    for (const [index, archive] of archives.entries()) {
      const destination = join(extractedRoot, String(index));
      mkdirSync(destination);
      execFileSync('unzip', ['-q', archive, '-d', destination]);
      const libraries = filesBelow(destination).filter((filename) => filename.endsWith('.so'));
      assertPackagedOwnedLibraries(
        basename(archive),
        libraries.map((filename) => ({ name: basename(filename), abi: basename(dirname(filename)) })),
      );
      packaged.push(...libraries.map((filename) => ({ filename, archive })));
    }
  } catch (error) {
    rmSync(extractedRoot, { recursive: true, force: true });
    throw error;
  }
  if (!packaged.length) throw new Error('Release packaged native libraries are missing.');
  const receiptDir = join(mobileDir, 'diagnostic-artifacts', 'android-native');
  mkdirSync(receiptDir, { recursive: true });
  const inventory = packaged.map(({ filename, archive }) => {
    const name = basename(filename);
    const abi = basename(dirname(filename));
    const owned = OWNED_ANDROID_LIBRARIES.includes(name as (typeof OWNED_ANDROID_LIBRARIES)[number]);
    const diagnostics = owned
      ? inspect(filename)
      : (() => {
          try {
            return inspect(filename);
          } catch {
            return { buildId: '', hasDwarf: false };
          }
        })();
    return {
      archive: basename(archive),
      archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      name,
      abi,
      ...diagnostics,
      owned,
      sha256: createHash('sha256').update(readFileSync(filename)).digest('hex'),
      symbolPath: owned ? matchOwnedElf({ name, abi, buildId: diagnostics.buildId }, symbols) : null,
      limitation: owned ? null : 'Vendor library: upstream DWARF availability is not asserted.',
    };
  });
  rmSync(extractedRoot, { recursive: true, force: true });
  for (const name of OWNED_ANDROID_LIBRARIES) {
    if (!inventory.some((entry) => entry.name === name))
      throw new Error(`Required owned library ${name} is absent from release.`);
  }
  writeFileSync(
    join(receiptDir, 'inventory.json'),
    JSON.stringify({ commit: process.env.GITHUB_SHA ?? null, inventory }, null, 2),
  );
  const cliPath = resolveSentryCli(mobileDir);
  const expectedIds = new Set<string>();
  for (const entry of inventory) {
    if (!entry.symbolPath) continue;
    const destination = join(receiptDir, entry.buildId, entry.abi, entry.name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(entry.symbolPath, destination);
    expectedIds.add(
      parseSentryElfDebugId(
        execFileSync(cliPath, ['debug-files', 'check', '--json', destination], { encoding: 'utf8' }),
        entry.buildId,
      ),
    );
  }
  execFileSync(
    cliPath,
    [
      'debug-files',
      'upload',
      '--wait',
      '--require-all',
      ...[...expectedIds].flatMap((debugId) => ['--id', debugId]),
      receiptDir,
    ],
    {
      cwd: mobileDir,
      env: environment,
      stdio: 'inherit',
      timeout: 600_000,
    },
  );
  writeFileSync(
    join(receiptDir, 'accepted.json'),
    JSON.stringify({
      accepted: true,
      debugIds: [...expectedIds],
      buildIds: inventory.filter((entry) => entry.owned).map((entry) => entry.buildId),
    }),
  );
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    uploadAndroidSymbols();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
