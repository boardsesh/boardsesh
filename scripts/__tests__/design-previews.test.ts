import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDesignPreviewPublisher,
  DESIGN_ROOT,
  designPreviewFiles,
  designPreviewPath,
} from '../lib/design-previews';

const storage = vi.hoisted(() => ({
  files: new Map<string, string | Buffer>(),
  upload: vi.fn(async (key: string) => `https://dev.example/${key}`),
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

const manifestPath = join(DESIGN_ROOT, 'previews.json');
const indexPath = join(DESIGN_ROOT, 'previews.md');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const existing = {
  'removed-1440.png': { url: 'https://dev.example/old', sha256: 'old', bytes: 8 },
  'unrelated-390.png': { url: 'https://dev.example/other', sha256: 'other', bytes: 8 },
};

beforeEach(() => {
  storage.files.clear();
  storage.upload.mockClear();
  storage.files.set(manifestPath, JSON.stringify(existing));
  storage.files.set(indexPath, 'previous index');
  storage.files.set(join(DESIGN_ROOT, 'renamed-1440.png'), png);
  storage.files.set(join(DESIGN_ROOT, 'renamed-390.png'), png);
});

describe('design preview index updates', () => {
  it('derives both capture sizes from the current HTML inventory', () => {
    expect(designPreviewFiles([join(DESIGN_ROOT, 'nested/current.html')])).toEqual([
      join(DESIGN_ROOT, 'nested/current-1440.png'),
      join(DESIGN_ROOT, 'nested/current-390.png'),
    ]);
  });

  it('prunes obsolete links only after the full capture publishes successfully', async () => {
    const publisher = createDesignPreviewPublisher();
    const outputs = ['renamed-1440.png', 'renamed-390.png'].map((name) => join(DESIGN_ROOT, name));
    for (const output of outputs) await publisher.publish(output);
    expect(storage.files.get(manifestPath)).toBe(JSON.stringify(existing));

    publisher.finish(outputs);

    expect(Object.keys(JSON.parse(String(storage.files.get(manifestPath))))).toEqual([
      'renamed-1440.png',
      'renamed-390.png',
    ]);
    expect(storage.files.get(indexPath)).not.toContain('removed-1440.png');
    expect(storage.files.get(indexPath)).toContain('renamed-390.png');
  });

  it('preserves unrelated links when publishing a subset', async () => {
    const publisher = createDesignPreviewPublisher();
    await publisher.publish(join(DESIGN_ROOT, 'renamed-390.png'));
    publisher.finish();
    expect(JSON.parse(String(storage.files.get(manifestPath)))).toMatchObject(existing);
  });

  it('clears the index when a full capture has no HTML mockups left', () => {
    createDesignPreviewPublisher().finish([]);
    expect(storage.files.get(manifestPath)).toBe('{}\n');
    expect(storage.files.get(indexPath)).not.toContain('Open preview');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('leaves the previous index intact when an upload fails', async () => {
    storage.upload.mockRejectedValueOnce(new Error('Upload failed'));
    const publisher = createDesignPreviewPublisher();
    await expect(publisher.publish(join(DESIGN_ROOT, 'renamed-390.png'))).rejects.toThrow('Upload failed');
    expect(storage.files.get(manifestPath)).toBe(JSON.stringify(existing));
    expect(storage.files.get(indexPath)).toBe('previous index');
  });

  it('rejects paths outside the design directory', () => {
    expect(() => designPreviewPath(join(DESIGN_ROOT, '../outside.png'))).toThrow('Only PNG previews');
  });
});
