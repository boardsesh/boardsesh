import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  publishAuraGeometryManifest,
  requireDeterministicAuraGeometry,
  verifyAuraGeometryPublic,
  type AuraGeometryPublicationIO,
} from '../lib/aura-geometry-publish';

const bytes = new Uint8Array([1, 2, 3, 4]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const asset = {
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 25,
  geometryId: '0'.repeat(64),
  formatRevision: 2,
  atlasFormatRevision: 2,
  outputWidth: 1080,
  outputHeight: 1504,
  sha256,
  bytes: bytes.byteLength,
  maxReach: 60,
  pulseReach: 1.35,
  objectKey: `static/v1/${sha256}.aura`,
};

function io(): AuraGeometryPublicationIO {
  return {
    readArtifact: vi.fn(async () => bytes),
    putImmutable: vi.fn(async () => {}),
    verifyStoredObject: vi.fn(async () => {}),
    verifyPublicObject: vi.fn(async () => {}),
    releaseManifest: vi.fn(async () => {}),
  };
}

function publicResponse(cacheStatus: string | null): Response {
  return new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
      'cf-ray': 'test-ray-LIS',
      ...(cacheStatus === null ? {} : { 'cf-cache-status': cacheStatus }),
    },
  });
}

describe('Aura CDN cache verification', () => {
  it('consumes a MISS and verifies a subsequent GET HIT before publication', async () => {
    const miss = publicResponse('MISS');
    const hit = publicResponse('HIT');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(miss).mockResolvedValueOnce(hit);
    const beforeRequest = vi.fn(async () => {});
    await verifyAuraGeometryPublic(asset, beforeRequest, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(miss.bodyUsed).toBe(true);
    expect(hit.bodyUsed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(`https://assets.boardsesh.com/static/v1/${sha256}.aura`, {
      headers: { Origin: 'https://www.boardsesh.com' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects uncached routes and bounds edge-fill attempts', async () => {
    for (const status of ['DYNAMIC', 'BYPASS', null]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(publicResponse(status));
      await expect(verifyAuraGeometryPublic(asset, async () => {}, fetchImpl)).rejects.toThrow('Aura CDN cache');
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => publicResponse('MISS'));
    await expect(verifyAuraGeometryPublic(asset, async () => {}, fetchImpl)).rejects.toThrow('did not reach HIT');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('Aura geometry release gate', () => {
  it('rejects nondeterministic regeneration', () => {
    expect(requireDeterministicAuraGeometry(bytes, new Uint8Array(bytes))).toBe(sha256);
    expect(() => requireDeterministicAuraGeometry(bytes, new Uint8Array([1, 2, 3, 5]))).toThrow('not deterministic');
  });

  it('releases only after storage and CDN verification', async () => {
    const publication = io();
    await publishAuraGeometryManifest({ version: 1, assets: [asset] }, publication);
    expect(publication.putImmutable).toHaveBeenCalledWith(asset, bytes);
    expect(publication.verifyStoredObject).toHaveBeenCalledWith(asset);
    expect(publication.verifyPublicObject).toHaveBeenCalledWith(asset);
    expect(publication.releaseManifest).toHaveBeenCalledOnce();
    const order = [
      publication.putImmutable,
      publication.verifyStoredObject,
      publication.verifyPublicObject,
      publication.releaseManifest,
    ].map((operation) => vi.mocked(operation).mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it('never releases a manifest when local, stored, or public bytes fail verification', async () => {
    for (const stage of ['readArtifact', 'verifyStoredObject', 'verifyPublicObject'] as const) {
      const publication = io();
      vi.mocked(publication[stage]).mockRejectedValue(new Error('corrupt'));
      await expect(publishAuraGeometryManifest({ version: 1, assets: [asset] }, publication)).rejects.toThrow(
        'corrupt',
      );
      expect(publication.releaseManifest).not.toHaveBeenCalled();
    }
    const publication = io();
    vi.mocked(publication.readArtifact).mockResolvedValue(new Uint8Array([5, 6, 7, 8]));
    await expect(publishAuraGeometryManifest({ version: 1, assets: [asset] }, publication)).rejects.toThrow(
      'changed before',
    );
    expect(publication.putImmutable).not.toHaveBeenCalled();
    expect(publication.releaseManifest).not.toHaveBeenCalled();
  });
});
