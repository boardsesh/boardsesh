import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// The publisher runs only on Ubuntu. Exercise the actual script with a fake
// gh executable: these tests cannot talk to GitHub or publish a release.
describe.skipIf(process.platform === 'win32')('post-merge release publication', () => {
  async function fixture(
    options: { existing?: Record<string, unknown>; tagExists?: boolean; failUpload?: boolean } = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-release-'));
    directories.push(directory);
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'artifacts'));
    await mkdir(join(directory, 'bin'));
    await copyFile(new URL('../../scripts/release.mjs', import.meta.url), join(directory, 'scripts/release.mjs'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    const archive = Buffer.from('tested archive bytes');
    const filename = 'boardsesh-mcp-0.1.0.tgz';
    await writeFile(join(directory, 'artifacts', filename), archive);
    await writeFile(
      join(directory, 'artifacts', `${filename}.sha256`),
      `${createHash('sha256').update(archive).digest('hex')}  ${filename}\n`,
    );
    await writeFile(join(directory, 'artifacts/INSTALL.md'), 'Install the tested archive.');
    await writeFile(join(directory, 'state.json'), JSON.stringify({ ...options, calls: [] }));
    await writeFile(
      join(directory, 'bin/gh'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.MCP_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const missing = () => { save(); process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); };
if (args[0] === 'api') {
  if (args[1].includes('/git/ref/')) {
    if (!state.tagExists) missing();
    process.stdout.write(JSON.stringify({object:{sha:'other'}}));
  } else {
    if (!state.existing) missing();
    process.stdout.write(JSON.stringify(state.existing));
  }
} else if (args[1] === 'create') {
  state.existing = {draft:true, target_commitish:process.env.GITHUB_SHA, assets:[], html_url:'https://example.test/release'};
} else if (args[1] === 'upload') {
  if (state.failUpload) { save(); process.stderr.write('Upload failed'); process.exit(1); }
  state.existing.assets = ['boardsesh-mcp-0.1.0.tgz','boardsesh-mcp-0.1.0.tgz.sha256','INSTALL.md'].map(name => ({name}));
} else if (args[1] === 'edit') {
  state.existing.draft = false;
} else { save(); process.exit(2); }
save();
`,
    );
    await chmod(join(directory, 'bin/gh'), 0o755);
    const environment = {
      ...process.env,
      PATH: `${join(directory, 'bin')}${delimiter}${process.env.PATH}`,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'boardsesh/boardsesh',
      GITHUB_SHA: 'a'.repeat(40),
      MCP_TEST_STATE: join(directory, 'state.json'),
      MCP_RELEASE_ARTIFACT_DIR: join(directory, 'artifacts'),
      GH_TOKEN: 'never-used-by-fake-gh',
    };
    return {
      directory,
      run(overrides: Record<string, string> = {}) {
        return execFileSync(process.execPath, [join(directory, 'scripts/release.mjs')], {
          env: { ...environment, ...overrides },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
      async state() {
        return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as {
          calls: string[][];
          existing?: { draft: boolean; assets: { name: string }[] };
        };
      },
    };
  }

  it('refuses pull requests and corrupt archives before invoking GitHub', async () => {
    const release = await fixture();
    expect(() => release.run({ GITHUB_EVENT_NAME: 'pull_request' })).toThrow();
    expect((await release.state()).calls).toEqual([]);
    await writeFile(join(release.directory, 'artifacts/boardsesh-mcp-0.1.0.tgz'), 'changed');
    expect(() => release.run()).toThrow();
    expect((await release.state()).calls).toEqual([]);
  });

  it('publishes only after the tested archive, checksum and guide are attached', async () => {
    const release = await fixture();
    expect(release.run()).toContain('https://example.test/release');
    const state = await release.state();
    expect(state.calls.filter((call) => call[0] === 'release').map((call) => call[1])).toEqual([
      'create',
      'upload',
      'edit',
    ]);
    expect(state.calls.find((call) => call[1] === 'create')).toContain('--draft');
    expect(state.existing?.draft).toBe(false);
    expect(state.existing?.assets).toHaveLength(3);
  });

  it('never changes a published version or reuses an existing unrelated tag', async () => {
    const published = await fixture({ existing: { draft: false } });
    published.run();
    expect((await published.state()).calls.filter((call) => call[0] === 'release')).toEqual([]);
    const collision = await fixture({ tagExists: true });
    expect(() => collision.run()).toThrow();
    expect((await collision.state()).calls.filter((call) => call[0] === 'release')).toEqual([]);
  });

  it('keeps failed uploads private and lets only the same commit complete a draft', async () => {
    const failed = await fixture({ failUpload: true });
    expect(() => failed.run()).toThrow();
    expect((await failed.state()).existing?.draft).toBe(true);
    expect((await failed.state()).calls.some((call) => call[1] === 'edit')).toBe(false);
    const retry = await fixture({ existing: { draft: true, target_commitish: 'a'.repeat(40), assets: [] } });
    retry.run();
    expect((await retry.state()).calls.filter((call) => call[0] === 'release').map((call) => call[1])).toEqual([
      'upload',
      'edit',
    ]);
    const otherCommit = await fixture({ existing: { draft: true, target_commitish: 'b'.repeat(40) } });
    expect(() => otherCommit.run()).toThrow();
    expect((await otherCommit.state()).calls.filter((call) => call[0] === 'release')).toEqual([]);
  });
});
