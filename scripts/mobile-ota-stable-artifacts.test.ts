/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadStableArtifact, extractArtifactZip, parseArtifactArgs } from './mobile-ota-stable-artifacts';
import type { StableGithubClient } from './lib/ota-stable-github';

const scratchDirs: string[] = [];
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'stable-artifact-test-'));
  scratchDirs.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeZip(directory: string, members: { name: string; content: string; symlink?: boolean }[]): string {
  const zipPath = join(directory, 'input.zip');
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import json, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    for member in json.loads(sys.argv[2]):
        entry = zipfile.ZipInfo(member['name'])
        if member.get('symlink'):
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(entry, member['content'])
`,
      zipPath,
      JSON.stringify(members),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return zipPath;
}

describe('artifact ZIP preflight', () => {
  it('extracts legitimate nested exports with shell characters in local paths', () => {
    const directory = scratch();
    const zip = makeZip(directory, [
      { name: 'ios/bundle.hbc', content: 'bundle' },
      { name: 'receipt.json', content: '{}' },
    ]);
    const output = join(directory, "output '; $() spaces");
    extractArtifactZip(zip, output);
    expect(readFileSync(join(output, 'ios/bundle.hbc'), 'utf8')).toBe('bundle');
  });

  it.each(['../escaped', '/absolute', 'ios/../../escaped', 'ios\\escaped', 'C:/escaped', 'ios//bundle'])(
    'rejects unsafe entry %s before extracting any file',
    (name) => {
      const directory = scratch();
      const zip = makeZip(directory, [
        { name: 'safe', content: 'safe' },
        { name, content: 'bad' },
      ]);
      const output = join(directory, 'out');
      expect(() => extractArtifactZip(zip, output)).toThrow('Unsafe artifact ZIP path');
      expect(existsSync(join(output, 'safe'))).toBe(false);
      expect(existsSync(join(directory, 'escaped'))).toBe(false);
    },
  );

  it('rejects ZIP symlinks, duplicate entries, and existing output contents', () => {
    const directory = scratch();
    const output = join(directory, 'out');
    const symlink = makeZip(directory, [{ name: 'link', content: '../outside', symlink: true }]);
    expect(() => extractArtifactZip(symlink, output)).toThrow('special file');
    const duplicate = makeZip(directory, [
      { name: 'same', content: 'one' },
      { name: 'same', content: 'two' },
    ]);
    expect(() => extractArtifactZip(duplicate, output)).toThrow('duplicate paths');
    writeFileSync(join(output, 'existing'), 'keep');
    expect(() => extractArtifactZip(duplicate, output)).toThrow('new or empty directory');
    expect(readFileSync(join(output, 'existing'), 'utf8')).toBe('keep');
  });
});

describe('artifact commands', () => {
  it('requires a current run exclusion for state and a numeric preparation run for candidates', () => {
    expect(parseArtifactArgs(['state', '--out', 'out'], '14')).toMatchObject({ command: 'state', excludeRunId: 14 });
    expect(parseArtifactArgs(['candidate', '--run-id', '13', '--out', 'out'])).toMatchObject({
      command: 'candidate',
      runId: 13,
    });
    expect(() => parseArtifactArgs(['state', '--out', 'out'])).toThrow('requires --exclude-run-id');
    expect(() => parseArtifactArgs(['candidate', '--out', 'out'])).toThrow('--run-id');
    expect(() => parseArtifactArgs(['candidate', '--run-id', '1; injected', '--out', 'out'])).toThrow(
      'positive safe integer',
    );
    expect(() => parseArtifactArgs(['source', '--run-id', '13', '--out', 'out'])).toThrow('--run-id');
  });

  it('refuses a stage receipt naming a different commit than its trusted deployment', async () => {
    const directory = scratch();
    const zip = makeZip(directory, [{ name: 'receipt.json', content: JSON.stringify({ commitHash: 'b'.repeat(40) }) }]);
    const client: StableGithubClient = {
      latestSource: vi.fn(async () => ({ runId: 12, headSha: 'a'.repeat(40), artifactId: 120 })),
      latestCheckpoint: vi.fn(async () => null),
      candidate: vi.fn(),
      downloadArtifact: vi.fn(async () => new Uint8Array(readFileSync(zip))),
    };
    await expect(
      downloadStableArtifact(parseArtifactArgs(['source', '--out', join(directory, 'out')]), client),
    ).rejects.toThrow('receipt commit does not match');
  });

  it('reports a true first-run bootstrap without downloading or creating output', async () => {
    const directory = scratch();
    const downloadArtifact = vi.fn();
    const client: StableGithubClient = {
      latestSource: vi.fn(),
      latestCheckpoint: vi.fn(async () => null),
      candidate: vi.fn(),
      downloadArtifact,
    };
    const output = join(directory, 'out');
    await expect(downloadStableArtifact(parseArtifactArgs(['state', '--out', output], '14'), client)).resolves.toEqual({
      found: false,
      runId: null,
      headSha: null,
      artifactId: null,
      path: null,
    });
    expect(downloadArtifact).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });
});
