import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendUploadImage } from '../upload-image.web';

vi.mock('../upload-image', () => import('../upload-image.web'));
vi.mock('../env', () => ({ BACKEND_URL: 'https://ws.example.com' }));
const authenticatedFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../auth-interceptor', () => ({ authenticatedFetch: authenticatedFetchMock }));

import { uploadAvatar } from '../avatar-upload';
import { clearScreenshotUploadCache, uploadFeedbackScreenshots } from '../feedback/screenshot-upload';

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const objectUrls: string[] = [];
const browserFetch = globalThis.fetch;

beforeEach(() => {
  authenticatedFetchMock.mockReset();
  clearScreenshotUploadCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const uri of objectUrls.splice(0)) URL.revokeObjectURL(uri);
});

function imageUri(kind: string): string {
  if (kind === 'data') return `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString('base64')}`;
  const uri = URL.createObjectURL(new Blob([JPEG_BYTES], { type: 'image/jpeg' }));
  objectUrls.push(uri);
  return uri;
}

describe('browser uploads', () => {
  it.each(['blob', 'data'])('serializes a %s image as a real file with unchanged bytes', async (kind) => {
    const uri = imageUri(kind);
    const sourceFetch = vi.fn(browserFetch);
    vi.stubGlobal('fetch', sourceFetch);
    const form = new FormData();
    await appendUploadImage(form, 'screenshot', { uri, name: 'screenshot.jpg', type: 'image/jpeg' });
    const request = new Request('https://example.com/upload', { method: 'POST', body: form });
    expect(request.headers.get('content-type')).toContain('multipart/form-data; boundary=');
    const decoded = await request.formData();
    const image = decoded.getAll('screenshot')[0] as unknown as File;
    expect(image.name).toBe('screenshot.jpg');
    expect(image.type).toBe('image/jpeg');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(JPEG_BYTES);
    expect(sourceFetch).toHaveBeenCalledExactlyOnceWith(uri);
  });

  it.each(['avatar', 'screenshots'])('sends complete %s through the shared uploader', async (flow) => {
    authenticatedFetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const decoded = await new Request(url, options).formData();
      const fieldName = flow === 'avatar' ? 'avatar' : 'screenshot';
      const image = decoded.getAll(fieldName)[0] as unknown as File;
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(JPEG_BYTES);
      if (flow === 'avatar') expect(decoded.getAll('userId')[0]).toBe('climber-id');
      return Response.json(
        flow === 'avatar' ? { avatarUrl: '/static/avatars/climber-id.jpg' } : { key: 'feedback-screenshots/shot.jpg' },
      );
    });
    const uri = imageUri('blob');
    if (flow === 'avatar') await expect(uploadAvatar({ uri }, 'climber-id')).resolves.toContain('/static/avatars/');
    else await expect(uploadFeedbackScreenshots([uri])).resolves.toEqual(['feedback-screenshots/shot.jpg']);
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty image without contacting the backend', async () => {
    await expect(uploadAvatar({ uri: 'data:image/jpeg;base64,' }, 'climber-id')).rejects.toThrow(
      'Selected image is empty',
    );
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unavailable image without contacting the backend', async () => {
    const uri = imageUri('blob');
    URL.revokeObjectURL(uri);
    await expect(uploadFeedbackScreenshots([uri])).rejects.toThrow();
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unsuccessful source response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(uploadAvatar({ uri: 'blob:missing' }, 'climber-id')).rejects.toThrow('Selected image is unavailable');
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
  });
});
