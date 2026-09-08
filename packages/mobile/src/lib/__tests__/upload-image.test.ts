import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeFormData, convertFormDataAsync } from '../../../test/native-upload-runtime';

const readBytes = vi.hoisted(() => vi.fn());
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return existsSync(new URL(this.uri));
    }
    get size() {
      return statSync(new URL(this.uri)).size;
    }
    bytes() {
      return readBytes(this.uri);
    }
  },
}));

import { appendUploadImage } from '../upload-image';

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x0d, 0x0a, 0xff, 0xd9]);
let fixtureDirectory: string;
let imageUri: string;

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-upload-'));
  imageUri = pathToFileURL(join(fixtureDirectory, 'picked image.jpg')).href;
  await writeFile(new URL(imageUri), JPEG_BYTES);
  readBytes.mockReset().mockImplementation((uri: string) => readFile(new URL(uri)));
  vi.stubGlobal('FormData', NativeFormData);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('native image multipart encoding', () => {
  it.each(['avatar', 'screenshot'])(
    'gives RN a readable %s file without sending functions to native',
    async (fieldName) => {
      const form = new NativeFormData();
      await appendUploadImage(form, fieldName, { uri: imageUri, name: 'picked.jpg', type: 'image/jpeg' });
      const [part] = form.getParts();
      expect(part).toEqual({
        uri: imageUri,
        name: 'picked.jpg',
        type: 'image/jpeg',
        fieldName,
        headers: {
          'content-disposition': `form-data; name="${fieldName}"; filename="picked.jpg"`,
          'content-type': 'image/jpeg',
        },
      });
      // The native bridge reads the URI, rather than invoking a JS bytes callback.
      expect(readBytes).not.toHaveBeenCalled();
      expect(new Uint8Array(await readFile(new URL(part.uri!)))).toEqual(JPEG_BYTES);
    },
  );

  it('encodes complete bytes and metadata with the Expo multipart encoder, including replay', async () => {
    const form = new NativeFormData();
    await appendUploadImage(form, 'avatar', { uri: imageUri, name: 'avatar.jpg', type: 'image/jpeg' });
    form.append('userId', 'climber-id');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { body, boundary } = await convertFormDataAsync(form);
      const encodedRequest = new Request('https://example.com/upload', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: new Uint8Array(body).buffer,
      });
      const decoded = await encodedRequest.formData();
      const image = decoded.getAll('avatar')[0] as unknown as File;
      expect(image.name).toBe('avatar.jpg');
      expect(image.type).toBe('image/jpeg');
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(JPEG_BYTES);
      expect(decoded.getAll('userId')[0]).toBe('climber-id');
    }
  });

  it.each(['missing', 'empty'])('rejects a %s file before appending a part', async (kind) => {
    if (kind === 'missing') await rm(new URL(imageUri));
    else await writeFile(new URL(imageUri), new Uint8Array());
    const form = new NativeFormData();
    await expect(
      appendUploadImage(form, 'screenshot', { uri: imageUri, name: 'shot.jpg', type: 'image/jpeg' }),
    ).rejects.toThrow(kind === 'missing' ? 'Selected image is unavailable' : 'Selected image is empty');
    expect(form.getParts()).toEqual([]);
  });
});
