/// <reference types="node" />

/** Download a trusted source, checkpoint, or frozen candidate for the stable workflow. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStableGithubClient, githubId, SOURCE_WORKFLOW } from './lib/ota-stable-github.ts';
import type { StableGithubClient, TrustedArtifact } from './lib/ota-stable-github.ts';

const EXTRACT_ZIP = `
import pathlib, stat, sys, zipfile
archive_path, output_path = sys.argv[1:]
destination = pathlib.Path(output_path)
with zipfile.ZipFile(archive_path) as archive:
    members = archive.infolist()
    seen = set()
    total_size = 0
    for member in members:
        name = member.filename
        parts = name.rstrip('/').split('/')
        mode = member.external_attr >> 16
        if not name or name.startswith('/') or '\\\\' in name or ':' in parts[0] or any(part in ('', '.', '..') for part in parts):
            raise ValueError('Unsafe artifact ZIP path: ' + repr(name))
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))):
            raise ValueError('Artifact ZIP contains a special file: ' + repr(name))
        normalized = '/'.join(parts)
        if normalized in seen:
            raise ValueError('Artifact ZIP contains duplicate paths: ' + repr(name))
        seen.add(normalized)
        total_size += member.file_size
        if member.file_size > 1073741824 or total_size > 4294967296:
            raise ValueError('Artifact ZIP exceeds extraction size limits')
    archive.extractall(destination)
`;

export function extractArtifactZip(archivePath: string, outputPath: string): void {
  const outputDir = resolve(outputPath);
  if (existsSync(outputDir)) {
    if (
      lstatSync(outputDir).isSymbolicLink() ||
      !lstatSync(outputDir).isDirectory() ||
      readdirSync(outputDir).length !== 0
    ) {
      throw new Error('Artifact output must be a new or empty directory.');
    }
  } else mkdirSync(outputDir, { recursive: true });
  const result = spawnSync('python3', ['-c', EXTRACT_ZIP, resolve(archivePath), outputDir], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(`Artifact ZIP extraction failed: ${result.error?.message ?? result.stderr.trim()}`);
}

export interface ArtifactOptions {
  command: 'source' | 'state' | 'candidate';
  out: string;
  runId: number | null;
  excludeRunId: number | null;
  productionLocked?: boolean;
}

export function assertProductionLockContext(environment: Record<string, string | undefined>): void {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    environment.GITHUB_JOB !== 'promote-mobile-ota' ||
    environment.GITHUB_WORKFLOW_REF !== `${environment.GITHUB_REPOSITORY}/${SOURCE_WORKFLOW}@refs/heads/main` ||
    !['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME ?? '')
  )
    throw new Error('--production-locked is restricted to the trusted main production promotion job.');
}

export function parseArtifactArgs(argv: readonly string[], currentRunId?: string): ArtifactOptions {
  const [command, ...inputFlags] = argv;
  const productionLocked = inputFlags.includes('--production-locked');
  if (inputFlags.filter((flag) => flag === '--production-locked').length > 1)
    throw new Error('Duplicate --production-locked.');
  const flags = inputFlags.filter((flag) => flag !== '--production-locked');
  if (command !== 'source' && command !== 'state' && command !== 'candidate')
    throw new Error('Expected source, state, or candidate.');
  const options = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const argument = flags[index + 1];
    if (
      !['--out', '--run-id', '--exclude-run-id'].includes(flag) ||
      argument === undefined ||
      argument.startsWith('--') ||
      options.has(flag)
    ) {
      throw new Error(`Invalid or duplicate artifact argument: ${flag}.`);
    }
    options.set(flag, argument);
  }
  const out = options.get('--out');
  if (!out) throw new Error('--out is required.');
  const runId = options.get('--run-id');
  const excludeRunId = options.get('--exclude-run-id') ?? (command === 'state' ? currentRunId : undefined);
  if (command === 'candidate' && runId === undefined) throw new Error('--run-id is required for candidate.');
  if (command === 'state' && runId !== undefined) throw new Error('--run-id applies only to source or candidate.');
  if (command === 'state' && excludeRunId === undefined)
    throw new Error('state requires --exclude-run-id or GITHUB_RUN_ID.');
  if (command !== 'state' && options.has('--exclude-run-id'))
    throw new Error('--exclude-run-id applies only to state.');
  if (productionLocked && command !== 'state') throw new Error('--production-locked applies only to state.');
  return {
    command,
    out: resolve(out),
    runId: runId === undefined ? null : githubId(runId, '--run-id'),
    excludeRunId: excludeRunId === undefined ? null : githubId(excludeRunId, '--exclude-run-id'),
    ...(productionLocked ? { productionLocked } : {}),
  };
}

export interface ArtifactResult {
  found: boolean;
  runId: number | null;
  headSha: string | null;
  artifactId: number | null;
  path: string | null;
}

export async function downloadStableArtifact(
  options: ArtifactOptions,
  client: StableGithubClient,
): Promise<ArtifactResult> {
  let artifact: TrustedArtifact | null;
  if (options.command === 'source')
    artifact = options.runId === null ? await client.latestSource() : await client.source(options.runId);
  else if (options.command === 'state')
    artifact = options.productionLocked
      ? await client.latestCheckpoint(githubId(options.excludeRunId, 'Excluded run id'), true)
      : await client.latestCheckpoint(githubId(options.excludeRunId, 'Excluded run id'));
  else artifact = await client.candidate(githubId(options.runId, 'Candidate run id'));
  if (artifact === null) return { found: false, runId: null, headSha: null, artifactId: null, path: null };
  const scratchDir = mkdtempSync(join(tmpdir(), 'ota-stable-artifact-'));
  try {
    const archivePath = join(scratchDir, 'artifact.zip');
    writeFileSync(archivePath, await client.downloadArtifact(artifact.artifactId));
    extractArtifactZip(archivePath, options.out);
    if (options.command === 'source') {
      const receipt = JSON.parse(readFileSync(join(options.out, 'receipt.json'), 'utf8')) as unknown;
      if (
        typeof receipt !== 'object' ||
        receipt === null ||
        !('commitHash' in receipt) ||
        receipt.commitHash !== artifact.headSha
      ) {
        throw new Error('Staged receipt commit does not match its trusted source run head SHA.');
      }
    }
    return { found: true, ...artifact, path: options.out };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArtifactArgs(process.argv.slice(2), process.env.GITHUB_RUN_ID);
  if (args.productionLocked) assertProductionLockContext(process.env);
  const client = createStableGithubClient({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '',
  });
  downloadStableArtifact(args, client).then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
