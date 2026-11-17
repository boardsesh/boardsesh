/// <reference types="node" />

/** Preview-only, same-PR artifacts. Never read or write production's sealed store. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_BYTES = 1024 * 1024 * 1024;
export const MAX_RUNS = 30;
const INPUTS = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'packages/mobile/package.json',
  'packages/mobile/metro.config.js',
  'packages/mobile/metro-web-runtime-resolution.cjs',
  'packages/mobile/expo-web-response-headers.cjs',
  'packages/mobile/babel.config.js',
  'packages/mobile/app.config.ts',
  'patches',
];

export function cacheName(directory: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (!/^[1-9][0-9]*$/.test(env.PR_NUMBER ?? '')) throw new Error('Missing PR number');
  const digest = createHash('sha256');
  const field = (name: string, contents: string | Buffer) => {
    digest.update(name).update('\0').update(contents).update('\0');
  };
  field('format', 'metro-preview-v1');
  field('runtime', `${env.RUNNER_OS}/${env.RUNNER_ARCH}/${process.version}`);
  const paths = execFileSync('git', ['ls-files', '-z', '--', ...INPUTS], { cwd: directory, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const path of paths) field(path, readFileSync(join(directory, path)));
  // Written by the compatibility check from the exact environment used by exports.
  field('packages/mobile/.env', readFileSync(join(directory, 'packages/mobile/.env')));
  for (const name of Object.keys(env)
    .filter((name) => name.startsWith('EXPO_PUBLIC_'))
    .sort()) {
    field(name, env[name] ?? '');
  }
  return `metro-preview-pr-${env.PR_NUMBER}-${digest.digest('hex')}`;
}

export interface PreviewRun {
  id: number;
  path: string;
  event: string;
  status: string;
  conclusion: string;
  repository?: { id: number };
  head_repository?: { id: number };
  pull_requests?: Array<{ number: number }>;
}
export interface PreviewArtifact {
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
  workflow_run?: { id: number };
}
export function eligibleRun(run: PreviewRun, prNumber: number, currentRun: number): boolean {
  return (
    run.id !== currentRun &&
    run.path === '.github/workflows/mobile-ota-preview.yml' &&
    run.event === 'pull_request' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    typeof run.repository?.id === 'number' &&
    run.head_repository?.id === run.repository.id &&
    run.pull_requests?.some((pr) => pr.number === prNumber) === true
  );
}
export function eligibleArtifact(artifact: PreviewArtifact, runId: number, name: string): boolean {
  return (
    artifact.name === name &&
    !artifact.expired &&
    artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= MAX_BYTES &&
    artifact.workflow_run?.id === runId
  );
}
export async function selectStore(
  runs: PreviewRun[],
  artifacts: (runId: number) => Promise<PreviewArtifact[]>,
  prNumber: number,
  currentRun: number,
  name: string,
): Promise<{ run_id: number; artifact_id: number } | null> {
  for (const run of runs.slice(0, MAX_RUNS)) {
    if (!eligibleRun(run, prNumber, currentRun)) continue;
    const found = (await artifacts(run.id)).find((artifact) => eligibleArtifact(artifact, run.id, name));
    if (found) return { run_id: run.id, artifact_id: found.id };
  }
  return null;
}

// Treat every tar as untrusted. Validate all members before writing any bytes,
// then extract manually into a fresh sibling and atomically rename it. No tar -P,
// links, special files, duplicate paths, sparse expansion, or filesystem metadata.
const ARCHIVE_SCRIPT = String.raw`
import os, pathlib, re, shutil, stat, sys, tarfile, tempfile
mode, archive, parent, limit = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), int(sys.argv[4])
layout = re.compile(r'metro-cache(?:/[0-9a-f]{2}(?:/[0-9a-f]+\.mp)?)?')
def valid(name, directory):
    return bool(layout.fullmatch(name)) and (not directory or not name.endswith('.mp')) and (directory or name.endswith('.mp'))
parent.mkdir(parents=True, exist_ok=True)
store = parent / 'metro-cache'
if mode == 'unpack':
    if store.is_symlink(): store.unlink()
    elif store.exists(): shutil.rmtree(store)
    stage = pathlib.Path(tempfile.mkdtemp(prefix='metro-preview-', dir=parent))
    try:
        if not archive.exists():
            print(0)
            sys.exit(0)
        if archive.stat().st_size > limit: raise ValueError('archive exceeds budget')
        with tarfile.open(archive, 'r:') as source:
            members, names, total = [], set(), 0
            for entry in source:
                name = entry.name.rstrip('/') if entry.isdir() else entry.name
                if not (entry.isfile() or entry.isdir()) or not valid(name, entry.isdir()): raise ValueError('invalid member')
                if entry.sparse is not None or name in names: raise ValueError('sparse or duplicate member')
                names.add(name)
                total += entry.size
                if total > limit or len(names) > 100000: raise ValueError('members exceed budget')
                members.append((entry, name))
            for entry, name in members:
                destination = stage / name
                if entry.isdir(): destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with source.extractfile(entry) as contents, destination.open('xb') as output:
                        shutil.copyfileobj(contents, output)
        (stage / 'metro-cache').mkdir(exist_ok=True)
        (stage / 'metro-cache').rename(store)
        print(sum(1 for entry, name in members if entry.isfile()))
    finally:
        shutil.rmtree(stage)
        store.mkdir(exist_ok=True)
else:
    members, total = [], 0
    if store.is_symlink() or not store.is_dir(): raise ValueError('missing store')
    for directory, dirs, files in os.walk(store, followlinks=False):
        for name in dirs + files:
            path = pathlib.Path(directory) / name
            relative = path.relative_to(parent).as_posix()
            metadata = path.lstat()
            is_dir = stat.S_ISDIR(metadata.st_mode)
            if not (is_dir or stat.S_ISREG(metadata.st_mode)) or not valid(relative, is_dir): raise ValueError('invalid store member')
            total += metadata.st_size if not is_dir else 0
            members.append((path, relative, is_dir))
            if total > limit or len(members) > 100000: raise ValueError('store exceeds budget')
    count = sum(1 for path, relative, is_dir in members if not is_dir)
    if not count: raise ValueError('empty store')
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'w:') as output:
        for path, relative, is_dir in sorted(members):
            entry = output.gettarinfo(str(path), arcname=relative)
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = ''
            entry.mode = 0o755 if is_dir else 0o644
            if is_dir: output.addfile(entry)
            else:
                with path.open('rb') as contents: output.addfile(entry, contents)
    if archive.stat().st_size > limit: raise ValueError('archive exceeds budget')
    print(count)
`;

export function archiveStore(mode: 'pack' | 'unpack', archive: string, parent: string, maxBytes = MAX_BYTES): number {
  return Number(
    execFileSync('python3', ['-c', ARCHIVE_SCRIPT, mode, archive, parent, String(maxBytes)], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
  );
}

function output(entries: Record<string, string | number>, env: Readonly<Record<string, string | undefined>>) {
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(entries)
        .map(([name, contents]) => `${name}=${contents}\n`)
        .join(''),
    );
  }
}
function summary(message: string, env: Readonly<Record<string, string | undefined>>) {
  console.log(message);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

export async function main(
  args = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const [mode, first, second] = args;
  try {
    if (mode === 'key') {
      if (!first) throw new Error('Missing candidate');
      output({ store_artifact: cacheName(first, env) }, env);
    } else if (mode === 'select') {
      const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, METRO_STORE_ARTIFACT: name } = env;
      const prNumber = Number(env.PR_NUMBER);
      if (!repository || !token || !name?.startsWith(`metro-preview-pr-${prNumber}-`) || !env.GITHUB_HEAD_REF) {
        throw new Error('Lookup not configured');
      }
      const base = `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/actions`;
      const lookupDeadline = AbortSignal.timeout(45_000);
      const get = async (path: string): Promise<unknown> => {
        const response = await fetch(`${base}/${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.any([lookupDeadline, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error('Lookup failed');
        return response.json();
      };
      const listing = (await get(
        `workflows/mobile-ota-preview.yml/runs?event=pull_request&status=success&branch=${encodeURIComponent(env.GITHUB_HEAD_REF)}&per_page=${MAX_RUNS}`,
      )) as { workflow_runs?: PreviewRun[] };
      const found = await selectStore(
        listing.workflow_runs ?? [],
        async (runId) => {
          const listing = (await get(`runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`)) as {
            artifacts?: PreviewArtifact[];
          };
          return listing.artifacts ?? [];
        },
        prNumber,
        Number(env.GITHUB_RUN_ID),
        name,
      );
      if (found) output(found, env);
      else summary('Preview Metro cache: miss; building cold.', env);
    } else if (mode === 'unpack' || mode === 'pack') {
      if (!first || !second) throw new Error('Missing paths');
      const archive = mode === 'unpack' ? first : second;
      const parent = mode === 'unpack' ? second : first;
      const entries = archiveStore(mode, archive, parent);
      output({ [mode === 'unpack' ? 'store_ready' : 'archive_ready']: 'true' }, env);
      summary(
        mode === 'unpack' && entries === 0
          ? 'Preview Metro cache: empty store; building cold.'
          : `Preview Metro cache: ${mode === 'unpack' ? 'restored' : 'packed'} ${entries} entries (${statSync(archive).size} archive bytes).`,
        env,
      );
    } else throw new Error('Unknown cache command');
  } catch {
    summary(`Preview Metro cache: ${mode ?? 'command'} unavailable; continuing without cache reuse.`, env);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
