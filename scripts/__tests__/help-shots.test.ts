import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHelpShotPublisher,
  DEFAULT_HELP_SHOT_DIR,
  HELP_SHOT_INDEX_PATH,
  HELP_SHOT_MANIFEST_PATH,
  HELP_SHOTS,
  helpCaptureName,
  helpShotAsset,
  parseHelpShotArgs,
  resolveHelpShotSet,
} from '../lib/help-shots';

const storage = vi.hoisted(() => ({
  files: new Map<string, string | Buffer>(),
  // Typed as the real publisher so `mock.calls[0]` keeps the (key, bytes, type) shape.
  upload: vi.fn<(key: string, bytes: Buffer, contentType: string) => Promise<string>>(
    async (key) => `https://dev.example/${key}`,
  ),
}));

vi.mock('node:fs', () => ({
  existsSync: (filename: string) => storage.files.has(filename),
  readFileSync: (filename: string) => {
    const content = storage.files.get(filename);
    if (content === undefined) throw new Error(`Missing test file: ${filename}`);
    return content;
  },
  writeFileSync: (filename: string, content: string) => storage.files.set(filename, content),
}));
vi.mock('../lib/dev-object-store', () => ({ createDevObjectPublisher: () => storage.upload }));

const captureDir = '/captures';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const existing = {
  '01-discover': { url: 'https://dev.example/old-discover', sha256: 'old', bytes: 8 },
  '99-retired': { url: 'https://dev.example/retired', sha256: 'retired', bytes: 8 },
};

function captureFile(name: string): string {
  return join(captureDir, `${name}.png`);
}

beforeEach(() => {
  storage.files.clear();
  storage.upload.mockClear();
  storage.files.set(HELP_SHOT_MANIFEST_PATH, JSON.stringify(existing));
  storage.files.set(HELP_SHOT_INDEX_PATH, 'previous index');
  for (const shot of HELP_SHOTS) storage.files.set(captureFile(shot.capture), png);
});

describe('help shot mapping', () => {
  it('maps every Maestro capture to the asset name the web app loads', () => {
    expect(HELP_SHOTS.map((shot) => shot.asset)).toEqual([
      'discover',
      'playlist-detail',
      'live-sessions',
      'session-detail',
      'setters',
      'logbook',
      'board-sheet',
      'board-view',
      'climb-actions',
    ]);
    expect(helpShotAsset('03-home-live')).toBe('live-sessions');
    expect(helpShotAsset('03-nope')).toBeUndefined();
  });

  it('names every absent capture at once instead of failing one at a time', () => {
    storage.files.delete(captureFile('07-setters'));
    storage.files.delete(captureFile('10-board-view'));
    expect(() => resolveHelpShotSet(captureDir)).toThrow(
      new RegExp(`Missing 2 of ${HELP_SHOTS.length}[\\s\\S]*07-setters[\\s\\S]*10-board-view`),
    );
  });

  it('resolves the complete set in capture order', () => {
    expect(resolveHelpShotSet(captureDir).map((capture) => capture.asset)).toEqual(
      HELP_SHOTS.map((shot) => shot.asset),
    );
  });

  it('rejects capture names that could widen the object key', () => {
    expect(() => helpCaptureName('/captures/Shot One.png')).toThrow('Not a publishable help capture name');
    expect(() => helpCaptureName('/captures/01-discover.webp')).toThrow('Not a publishable help capture name');
    expect(() => helpCaptureName('/captures/_hidden.png')).toThrow('Not a publishable help capture name');
    // A traversal segment never survives to the key: only the basename is used.
    expect(helpCaptureName('/captures/../01-discover.png')).toBe('01-discover');
  });
});

describe('help shot argument parsing', () => {
  it('defaults to the Maestro capture directory', () => {
    expect(parseHelpShotArgs([])).toEqual({ inputDir: DEFAULT_HELP_SHOT_DIR, dryRun: false, help: false });
  });

  it('accepts the directory as a flag or a bare positional, and flags a dry run', () => {
    expect(parseHelpShotArgs(['--input', '/elsewhere', '--dry-run'])).toMatchObject({
      inputDir: '/elsewhere',
      dryRun: true,
    });
    expect(parseHelpShotArgs(['/elsewhere'])).toMatchObject({ inputDir: '/elsewhere', dryRun: false });
    // `vp run <task> -- --flag` forwards the separator; it must not read as a flag.
    expect(parseHelpShotArgs(['--', '--dry-run', '/elsewhere'])).toMatchObject({
      inputDir: '/elsewhere',
      dryRun: true,
    });
    expect(parseHelpShotArgs(['--help'])).toMatchObject({ help: true });
  });

  it('refuses an unknown flag and a directory-less --input', () => {
    expect(() => parseHelpShotArgs(['--upload'])).toThrow('Unknown option: --upload');
    expect(() => parseHelpShotArgs(['--input'])).toThrow('--input needs a directory');
  });
});

describe('help shot index updates', () => {
  it('prunes retired links only after the whole batch publishes', async () => {
    const publisher = createHelpShotPublisher();
    const captures = HELP_SHOTS.map((shot) => captureFile(shot.capture));
    for (const capture of captures) await publisher.publish(capture);
    expect(storage.files.get(HELP_SHOT_MANIFEST_PATH)).toBe(JSON.stringify(existing));

    publisher.finish(captures);

    const manifest: unknown = JSON.parse(String(storage.files.get(HELP_SHOT_MANIFEST_PATH)));
    expect(Object.keys(manifest as Record<string, unknown>)).toEqual(HELP_SHOTS.map((shot) => shot.capture));
    const index = String(storage.files.get(HELP_SHOT_INDEX_PATH));
    expect(index).not.toContain('99-retired');
    expect(index).toContain('`live-sessions.webp`');
    expect(index).toContain('vp run help:publish-shots');
  });

  it('publishes to a content-hashed key so a pasted review link keeps resolving', async () => {
    const publisher = createHelpShotPublisher();
    const url = await publisher.publish(captureFile('01-discover'));
    const [key, bytes, contentType] = storage.upload.mock.calls[0] as [string, Buffer, string];
    expect(key).toMatch(/^help-shots\/01-discover\/[0-9a-f]{64}\.png$/);
    expect(contentType).toBe('image/png');
    expect(bytes).toEqual(png);
    expect(url).toBe(`https://dev.example/${key}`);
  });

  it('keeps unrelated links when only a subset is republished', async () => {
    const publisher = createHelpShotPublisher();
    await publisher.publish(captureFile('02-playlist-detail'));
    publisher.finish();
    expect(JSON.parse(String(storage.files.get(HELP_SHOT_MANIFEST_PATH)))).toMatchObject({
      '99-retired': existing['99-retired'],
    });
  });

  it('refuses anything that is not a PNG', async () => {
    storage.files.set(captureFile('01-discover'), Buffer.from('<svg />'));
    await expect(createHelpShotPublisher().publish(captureFile('01-discover'))).rejects.toThrow(
      'Not a PNG help capture',
    );
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('leaves the previous index intact when an upload fails', async () => {
    storage.upload.mockRejectedValueOnce(new Error('Upload failed'));
    const publisher = createHelpShotPublisher();
    await expect(publisher.publish(captureFile('01-discover'))).rejects.toThrow('Upload failed');
    expect(storage.files.get(HELP_SHOT_MANIFEST_PATH)).toBe(JSON.stringify(existing));
    expect(storage.files.get(HELP_SHOT_INDEX_PATH)).toBe('previous index');
  });
});
