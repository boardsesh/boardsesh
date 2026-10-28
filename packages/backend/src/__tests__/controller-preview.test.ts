import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vite-plus/test';
import sharp from 'sharp';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import { getMoonboardSerialPosition } from '@boardsesh/ble-protocol/moonboard';
import { getMoonBoardGeometryByLayoutId } from '@boardsesh/board-config';
import {
  controllerPreviewDescriptor,
  controllerPreviewGeometry,
  encodeControllerGeometry,
  getControllerPreview,
  normalizeControllerPreviewConfig,
} from '../services/controller-preview';
import { handleControllerPreview } from '../handlers/controller-preview';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => undefined) }));

const configs = [
  { boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: '26,27,28,29' },
  { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' },
  { boardName: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' },
];

function requestAsset(query: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | number>; body: Buffer }>((resolve, reject) => {
    const responseHeaders: Record<string, string | number> = {};
    let status = 200;
    const response = {
      setHeader: (name: string, content: string | number) => {
        responseHeaders[name] = content;
      },
      writeHead: (code: number, additional?: Record<string, string | number>) => {
        status = code;
        Object.assign(responseHeaders, additional);
      },
      end: (body?: Buffer | string) =>
        resolve({ status, headers: responseHeaders, body: body ? Buffer.from(body) : Buffer.alloc(0) }),
    } as unknown as ServerResponse;
    const request = { method, headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
    handleControllerPreview(
      request,
      response,
      new URL(`https://ws.boardsesh.com/render/controller-preview?${query}`),
    ).catch(reject);
  });
}

describe('controller catalog previews', () => {
  it.each(configs)('keeps $boardName photos and wire geometry in one bounded coordinate system', async (input) => {
    const config = normalizeControllerPreviewConfig(input);
    const preview = await getControllerPreview(config);
    const metadata = await sharp(preview.image).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: preview.width, height: preview.height });
    expect(Math.max(preview.width, preview.height)).toBe(330);
    expect(preview.image.length).toBeLessThanOrEqual(65536);
    expect(preview.geometry.subarray(0, 4).toString()).toBe('BSGM');
    expect(preview.geometry.readUInt16LE(4)).toBe(1);
    expect(preview.geometry.readUInt16LE(6)).toBe(preview.positionCount);
    expect(preview.geometry.readUInt16LE(8)).toBe(preview.width);
    expect(preview.geometry.readUInt16LE(10)).toBe(preview.height);
    expect(preview.geometry.length).toBe(12 + preview.positionCount * 8);
    expect(preview.imageSha256).toBe(createHash('sha256').update(preview.image).digest('hex'));
    expect(preview.geometrySha256).toBe(createHash('sha256').update(preview.geometry).digest('hex'));

    const { details, positions } = controllerPreviewGeometry(config);
    const byPosition = new Map(positions.map((position) => [position.wirePosition, position]));
    const ledPlacements =
      config.boardName === 'moonboard' ? null : getLedPlacements(config.boardName, config.layoutId, config.sizeId);
    for (const hold of details.holdsData) {
      const wirePosition =
        config.boardName === 'moonboard'
          ? getMoonboardSerialPosition(hold.id, getMoonBoardGeometryByLayoutId(config.layoutId).numRows)
          : ledPlacements?.[hold.id];
      if (wirePosition === undefined) continue;
      const actual = byPosition.get(wirePosition);
      expect(actual).toBeDefined();
      expect(Math.abs(actual!.x / preview.width - hold.cx / details.boardWidth)).toBeLessThanOrEqual(1 / preview.width);
      expect(Math.abs(actual!.y / preview.height - hold.cy / details.boardHeight)).toBeLessThanOrEqual(
        1 / preview.height,
      );
    }
    const descriptor = controllerPreviewDescriptor(config, preview);
    expect(new URL(descriptor.imageUrl).searchParams.get('v')).toBe(preview.imageSha256);
    expect(new URL(descriptor.geometryUrl).searchParams.get('v')).toBe(preview.geometrySha256);
  });

  it('uses Mini MoonBoard twelve-row serpentine positions', () => {
    const mini = controllerPreviewGeometry(
      normalizeControllerPreviewConfig({ boardName: 'moonboard', layoutId: 6, sizeId: 1, setIds: '24,25,26,27' }),
    );
    expect(mini.positions).toHaveLength(132);
    expect(Math.max(...mini.positions.map((position) => position.wirePosition))).toBe(131);
  });

  it('writes sorted little-endian records and refuses ambiguous or out-of-bounds geometry', () => {
    const geometry = encodeControllerGeometry(300, 330, [
      { wirePosition: 257, x: 250, y: 320, radius: 8 },
      { wirePosition: 0, x: 5, y: 6, radius: 7 },
    ]);
    expect([...geometry.subarray(12, 20)]).toEqual([0, 0, 5, 0, 6, 0, 7, 0]);
    expect([...geometry.subarray(20, 24)]).toEqual([1, 1, 250, 0]);
    expect(() => encodeControllerGeometry(300, 330, [{ wirePosition: 1, x: 300, y: 0, radius: 2 }])).toThrow();
    expect(() =>
      encodeControllerGeometry(300, 330, [
        { wirePosition: 1, x: 1, y: 1, radius: 2 },
        { wirePosition: 1, x: 2, y: 2, radius: 2 },
      ]),
    ).toThrow();
  });

  it('enforces the controller firmware limit of 1024 positions', () => {
    const positions = Array.from({ length: 1025 }, (_, wirePosition) => ({ wirePosition, x: 1, y: 1, radius: 2 }));
    expect(encodeControllerGeometry(330, 330, positions.slice(0, 1024)).readUInt16LE(6)).toBe(1024);
    expect(() => encodeControllerGeometry(330, 330, positions)).toThrow();
  });

  it.each([
    { ...configs[0], boardName: 'spray' },
    { ...configs[0], setIds: '999999' },
    { ...configs[2], sizeId: 2 },
    { ...configs[2], layoutId: 999 },
  ])('rejects noncatalog or unsupported configuration %#', (config) => {
    expect(() => normalizeControllerPreviewConfig(config)).toThrow();
  });

  it('serves HEAD and immutable bytes only for the matching content hash', async () => {
    const config = normalizeControllerPreviewConfig(configs[0]);
    const preview = await getControllerPreview(config);
    const query = new URL(controllerPreviewDescriptor(config, preview).imageUrl).search.slice(1);
    const response = await requestAsset(query);
    expect(response.status).toBe(200);
    expect(response.body.equals(preview.image)).toBe(true);
    expect(response.headers['Cache-Control']).toContain('immutable');
    const head = await requestAsset(query, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['Content-Length']).toBe(preview.image.length);
    expect((await requestAsset(query.replace(preview.imageSha256, '0'.repeat(64)))).status).toBe(409);
    expect((await requestAsset(query, 'GET', { 'if-none-match': `"${preview.imageSha256}"` })).status).toBe(304);
  });
});
