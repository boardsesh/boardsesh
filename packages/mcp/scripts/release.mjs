import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the post-merge workflow invokes this script, after all desktop checks.
if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('MCP releases are published only by a push to main.');
}
const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
if (repository !== 'boardsesh/boardsesh' || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Expected the Boardsesh repository and an exact release commit.');
}
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid MCP package version.');
const artifacts = path.resolve(process.env.MCP_RELEASE_ARTIFACT_DIR ?? path.join(packageRoot, 'artifacts'));
const tag = `mcp-v${version}`;
const archiveName = `boardsesh-mcp-${version}.tgz`;
const archivePath = path.join(artifacts, archiveName);
const checksumPath = `${archivePath}.sha256`;
const expectedChecksum = `${createHash('sha256')
  .update(await readFile(archivePath))
  .digest('hex')}  ${archiveName}`;
if ((await readFile(checksumPath, 'utf8')).trim() !== expectedChecksum) {
  throw new Error('MCP release archive does not match its checksum.');
}

function github(argumentsList) {
  return execFileSync('gh', argumentsList, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function getOptional(endpoint) {
  try {
    return JSON.parse(github(['api', endpoint]));
  } catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr ?? ''))) return undefined;
    throw error;
  }
}

const existing = getOptional(`repos/${repository}/releases/tags/${tag}`);
if (existing && !existing.draft) {
  // Shared API changes also exercise this workflow. Publishing another build
  // requires an explicit package version bump; never replace a released asset.
  console.log(`${tag} is already published. Bump packages/mcp/package.json to release a new build.`);
} else {
  if (existing && existing.target_commitish !== commit) {
    throw new Error('An unfinished release belongs to another commit; refusing to replace it.');
  }
  if (!existing && getOptional(`repos/${repository}/git/ref/tags/${tag}`)) {
    throw new Error('The release tag already exists without a release; refusing to reuse it.');
  }
  const notesPath = path.join(artifacts, 'release-notes.md');
  await writeFile(
    notesPath,
    `Local Boardsesh MCP for Claude Desktop and Codex. Requires Node.js 22.18 or newer.\n\n` +
      `Download ${archiveName} and INSTALL.md below. Verify the archive with the attached SHA-256 checksum, ` +
      `install it with your package manager, then run \`boardsesh-mcp login\`. ` +
      `Your Boardsesh account is sufficient; no client secret is needed.\n\n` +
      `This proof-of-concept build passed installed-package checks on Linux, macOS and Windows.\n\n` +
      `Source commit: ${commit}\n`,
  );
  if (!existing) {
    github([
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--target',
      commit,
      '--title',
      `Boardsesh MCP ${version}`,
      '--notes-file',
      notesPath,
      '--draft',
      '--prerelease',
      '--latest=false',
    ]);
  }
  // A failed upload leaves a draft. Only a rerun for this exact commit can
  // finish it, and the published release appears only after all assets exist.
  github([
    'release',
    'upload',
    tag,
    '--repo',
    repository,
    '--clobber',
    archivePath,
    checksumPath,
    path.join(artifacts, 'INSTALL.md'),
  ]);
  github(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease', '--latest=false']);
  const published = JSON.parse(github(['api', `repos/${repository}/releases/tags/${tag}`]));
  const assetNames = new Set(published.assets.map((asset) => asset.name));
  if (published.draft || ![archiveName, `${archiveName}.sha256`, 'INSTALL.md'].every((name) => assetNames.has(name))) {
    throw new Error('MCP release publication could not be verified.');
  }
  console.log(published.html_url);
}
