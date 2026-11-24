import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { fetchGymMcpImage } from '../media';
import { versionedGymImageKey } from '../../../services/gym-image-storage';
import { GymLogoUrlSchema, GymPhotoUrlSchema } from '../../../validation/schemas/gyms';

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
});

describe('gym MCP media ingestion', () => {
  it.each([
    'http://images.example/photo.png',
    'https://user:password@images.example/photo.png',
    'https://images.example:8443/photo.png',
    'https://images.example/photo.png#fragment',
  ])('refuses unsafe URL %s before fetching', async (url) => {
    const fetchResource = vi.fn();
    await expect(fetchGymMcpImage(url, 'photo', fetchResource)).rejects.toThrow('public HTTPS');
    expect(fetchResource).not.toHaveBeenCalled();
  });

  it.each(['https://127.0.0.1/image.png', 'https://169.254.169.254/image.png', 'https://[::1]/image.png'])(
    'blocks private destinations using the real DNS-pinned transport: %s',
    async (url) => {
      await expect(fetchGymMcpImage(url, 'photo')).rejects.toThrow('could not be fetched');
    },
  );

  it('does not follow an image redirect', async () => {
    const fetchResource = vi.fn(
      async () => new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/private' } }),
    );
    await expect(fetchGymMcpImage('https://images.example/photo.png', 'photo', fetchResource)).rejects.toThrow(
      'without a redirect',
    );
    expect(fetchResource).toHaveBeenCalledOnce();
  });

  it('bounds declared and actual image bytes', async () => {
    const declared = async () =>
      new Response('', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(2 * 1024 * 1024 + 1) } });
    await expect(fetchGymMcpImage('https://images.example/logo.png', 'logo', declared)).rejects.toThrow(
      'smaller than 2 MB',
    );
    const streamed = async () =>
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } });
    await expect(fetchGymMcpImage('https://images.example/logo.png', 'logo', streamed)).rejects.toThrow('size limit');
  });

  it('checks MIME signatures and strips appended bytes by reencoding', async () => {
    const spoofed = async () => new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/jpeg' } });
    await expect(fetchGymMcpImage('https://images.example/photo.jpg', 'photo', spoofed)).rejects.toThrow(
      'contents do not match',
    );
    const withPayload = Buffer.concat([png, Buffer.from('not-image-content-private-marker')]);
    const valid = async () => new Response(new Uint8Array(withPayload), { headers: { 'Content-Type': 'image/png' } });
    const stored = await fetchGymMcpImage('https://images.example/photo.png', 'photo', valid);
    expect(stored.mimeType).toBe('image/png');
    expect(stored.bytes.includes(Buffer.from('not-image-content-private-marker'))).toBe(false);
    expect((await sharp(stored.bytes).metadata()).width).toBe(2);
  });

  it('times out even when DNS or response headers never finish', async () => {
    vi.useFakeTimers();
    let finishFetch: ((response: Response) => void) | undefined;
    try {
      let signal: AbortSignal | null | undefined;
      const blocked = vi.fn((_input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<Response> => {
        signal = options?.signal;
        return new Promise((resolve) => {
          finishFetch = resolve;
        });
      });
      const refusal = expect(fetchGymMcpImage('https://images.example/photo.png', 'photo', blocked)).rejects.toThrow(
        'could not be fetched',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await refusal;
      expect(signal?.aborted).toBe(true);
    } finally {
      finishFetch?.(new Response());
      vi.useRealTimers();
    }
  });

  it('bounds abandoned DNS jobs across repeated fetch deadlines', async () => {
    vi.useFakeTimers();
    const releaseFetches: Array<(response: Response) => void> = [];
    const blocked = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetches.push(resolve);
        }),
    );
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const refusal = expect(fetchGymMcpImage('https://images.example/photo.png', 'photo', blocked)).rejects.toThrow(
          'could not be fetched',
        );
        await vi.advanceTimersByTimeAsync(10_000);
        await refusal;
      }
      await expect(fetchGymMcpImage('https://images.example/photo.png', 'photo', blocked)).rejects.toThrow(
        'fetching is busy',
      );
      expect(blocked).toHaveBeenCalledTimes(4);
    } finally {
      for (const release of releaseFetches) release(new Response());
      vi.useRealTimers();
    }
  });
});

describe('versioned gym image ownership', () => {
  const gymUuid = '11111111-1111-4111-8111-111111111111';
  const uploadUuid = '22222222-2222-4222-8222-222222222222';
  const photo = `/static/gym-photos/${gymUuid}.${uploadUuid}.jpg`;

  it('supports existing and versioned first-party paths in the shared validators', () => {
    expect(GymPhotoUrlSchema.safeParse(photo).success).toBe(true);
    expect(GymPhotoUrlSchema.safeParse(`/static/gym-photos/${gymUuid}.jpg?v=version`).success).toBe(true);
    expect(GymLogoUrlSchema.safeParse(`/static/gym-logos/${gymUuid}.${uploadUuid}.png`).success).toBe(true);
    expect(GymPhotoUrlSchema.safeParse('https://external.example/image.jpg').success).toBe(false);
  });

  it('cleans only the selected gym, media kind, and immutable upload', () => {
    expect(versionedGymImageKey(gymUuid, 'photo', photo)).toBe(`gym-photos/${gymUuid}.${uploadUuid}.jpg`);
    expect(versionedGymImageKey(uploadUuid, 'photo', photo)).toBeNull();
    expect(versionedGymImageKey(gymUuid, 'logo', photo)).toBeNull();
    expect(versionedGymImageKey(gymUuid, 'photo', `/static/gym-photos/${gymUuid}.jpg`)).toBeNull();
    expect(versionedGymImageKey(gymUuid, 'photo', `${photo}/../../other.jpg`)).toBeNull();
  });
});
