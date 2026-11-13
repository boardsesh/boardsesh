import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { recordings, recordedSource } from './recordings';
import { createReleasedClient, callRecorded } from './released-client';

describe('released native source provenance', () => {
  it('retains all supported platform tags and every recorded source digest', () => {
    expect(recordings.releases.filter((release) => release.platform === 'android').length).toBe(11);
    expect(recordings.releases.filter((release) => release.platform === 'ios').length).toBe(9);
    for (const release of [...recordings.releases, ...recordings.garmin]) {
      for (const path of Object.keys(release.modules)) expect(recordedSource(release, path).length > 0).toBe(true);
    }
  });
  it('rejects a valid SHA-addressed source whose Git blob provenance was substituted', () => {
    const release = recordings.releases[0];
    const sourcePath = 'packages/mobile/src/lib/auth.ts';
    const recordedPointer = release.modules[sourcePath];
    const substitutedGitBlob = '0'.repeat(40);
    expect(recordedPointer.gitBlob).not.toBe(substitutedGitBlob);
    // Keep the existing SHA-addressed bytes intact; only the valid-width Git
    // blob identity is wrong, so rejection must come from provenance equality.
    const substitutedRecording = {
      modules: { ...release.modules, [sourcePath]: { ...recordedPointer, gitBlob: substitutedGitBlob } },
    };
    expect(() => recordedSource(substitutedRecording, sourcePath)).toThrowError(
      new Error('Released source integrity check failed'),
    );
  });
  it('retains every original blob, including older and superseded G2 recordings', () => {
    const files = readdirSync(new URL('./fixtures/sources/', import.meta.url));
    const referenced = new Set(
      [...recordings.releases, ...recordings.garmin].flatMap((recording) =>
        Object.values(recording.modules).map((pointer) => pointer.sha256),
      ),
    );
    expect(referenced.size).toBe(88);
    expect(files).toHaveLength(113);
    expect(files.filter((file) => !referenced.has(file.replace(/\.txt$/, '')))).toHaveLength(25);
    for (const file of files) {
      expect(file).toMatch(/^[a-f0-9]{64}\.txt$/);
      const source = readFileSync(new URL(`./fixtures/sources/${file}`, import.meta.url));
      expect(createHash('sha256').update(source).digest('hex')).toBe(file.replace(/\.txt$/, ''));
    }
  });
  it('refuses an unknown module instead of adapting away client behavior', async () => {
    const client = await createReleasedClient(recordings.releases[0], {
      fetch: async () => {
        throw new Error('Network refused');
      },
    });
    await expect(client.load('unrecorded-credential-authority')).rejects.toThrow('Unrecorded client module refused');
  });
  for (const release of recordings.releases) {
    it(`executes the frozen auth/store module graph: ${release.tag}`, async () => {
      const client = await createReleasedClient(release, {
        fetch: async () => {
          throw new Error('Network refused by load-only control');
        },
      });
      await callRecorded(client.store, 'storeTokens', 'fixture-access', 'fixture-refresh', '2099-01-01T00:00:00.000Z');
      expect((await callRecorded(client.store, 'getAuthToken')) === 'fixture-access').toBe(true);
      expect((await callRecorded(client.store, 'getRefreshToken')) === 'fixture-refresh').toBe(true);
    });
  }
});
