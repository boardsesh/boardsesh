import { describe, expect, it, vi } from 'vitest';
import { createLedPreviewSession } from '../preview';
import { createWledDriver } from '../wled';
import type { LedPixel } from '../types';

const json = (payload: unknown) => new Response(JSON.stringify(payload));
function fixture() {
  const fetchController = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return json({ success: true });
    return json(
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/info')
        ? { name: 'Wall', ver: '0.15', leds: { count: 1000 } }
        : { seg: [{ id: 0 }, { id: 3 }] },
    );
  });
  const driver = createWledDriver({ fetch: fetchController });
  const commands = () =>
    fetchController.mock.calls.flatMap(([, init]) =>
      typeof init?.body === 'string' ? [JSON.parse(init.body) as Record<string, unknown>] : [],
    );
  return { fetchController, driver, commands };
}

describe('WLED individual preview', () => {
  it('writes distinct RGB route colors and clears old colors before a later white selection', async () => {
    const { driver, commands } = fixture();
    const preview = driver.createPreview('route-colors.local');
    await preview.show(
      [7, 9, 10],
      [
        { index: 7, color: [255, 128, 0] },
        { index: 9, color: [0, 17, 255] },
      ],
    );
    expect(commands().at(-1)).toMatchObject({
      seg: [{ i: [0, 1000, '00000000', 7, 'FF800000', 9, '0011FF00', 10, 'FFFFFFFF'] }],
    });
    await preview.show([9]);
    expect(commands().at(-1)).toMatchObject({
      seg: [{ i: [7, '00000000', 9, '00000000', 10, '00000000', 9, 'FFFFFFFF'] }],
    });
  });

  it.each([
    [{ index: 2, color: [1, 2, 3] }],
    [{ index: 1, color: [-1, 2, 3] }],
    [{ index: 1, color: [256, 2, 3] }],
    [{ index: 1, color: [1.5, 2, 3] }],
    [{ index: 1, color: [NaN, 2, 3] }],
    [{ index: 1, color: [1, 2] }],
    [{ index: 1, color: [1, 2, 3, 4] }],
    [{ index: 1, color: 'red' }],
    [
      { index: 1, color: [1, 2, 3] },
      { index: 1, color: [4, 5, 6] },
    ],
  ])('rejects invalid or unrelated route colors before controller access: %j', async (...pixels) => {
    const { driver, fetchController } = fixture();
    await expect(
      driver.createPreview('invalid-colors.local').show([1], pixels as unknown as LedPixel[]),
    ).rejects.toMatchObject({ code: 'invalid-indices' });
    expect(fetchController).not.toHaveBeenCalled();
  });

  it('retains color pairs when a large route is split into sequential requests', async () => {
    const { driver, commands } = fixture();
    const indices = Array.from({ length: 400 }, (_, index) => index);
    await driver.createPreview('large-color.local').show(
      indices,
      indices.map((index) => ({ index, color: [0, index % 256, 255] })),
    );
    const chunks = commands()
      .slice(1)
      .map((command) => (command.seg as { i: (number | string)[] }[])[0].i);
    expect(chunks.flat()).toEqual([
      0,
      1000,
      '00000000',
      ...indices.flatMap((index) => [index, `00${(index % 256).toString(16).padStart(2, '0').toUpperCase()}FF00`]),
    ]);
    for (const chunk of chunks.slice(1)) expect(chunk.length % 2).toBe(0);
  });

  it('wakes separately, clears the full cable, then updates only old/new LEDs', async () => {
    const { driver, commands, fetchController } = fixture();
    const preview = driver.createPreview('wall.local');
    expect(fetchController).not.toHaveBeenCalled();
    await preview.show([10, 12, 12]);
    expect(commands()).toEqual([
      expect.objectContaining({
        on: true,
        bri: 64,
        seg: [
          expect.objectContaining({ id: 0, start: 0, stop: 1000, grp: 1, spc: 0, rev: false }),
          { id: 3, on: false },
        ],
      }),
      { tt: 0, udpn: { nn: true }, seg: [{ id: 0, i: [0, 1000, '00000000', 10, 'FFFFFFFF', 12, 'FFFFFFFF'] }] },
    ]);
    fetchController.mockClear();
    await preview.show([11]);
    // One state read to catch a controller switched off from outside, one write.
    expect(fetchController).toHaveBeenCalledTimes(2);
    expect(commands()[0]).toMatchObject({ seg: [{ id: 0, i: [10, '00000000', 12, '00000000', 11, 'FFFFFFFF'] }] });
  });

  it.each([-1, 1.5, NaN, 1000])('rejects invalid physical index %j before any write', async (index) => {
    const { driver, commands } = fixture();
    await expect(driver.createPreview('wall.local').show([index])).rejects.toMatchObject({ code: 'invalid-indices' });
    expect(commands()).toEqual([]);
  });

  it('splits a large selection on complete index/color pairs', async () => {
    const { driver, commands } = fixture();
    await driver.createPreview('wall.local').show(Array.from({ length: 400 }, (_, index) => index));
    const individual = commands()
      .slice(1)
      .map((command) => (command.seg as { i: (number | string)[] }[])[0].i);
    expect(individual).toHaveLength(4);
    expect(individual.flat()).toEqual([
      0,
      1000,
      '00000000',
      ...Array.from({ length: 400 }, (_, index) => [index, 'FFFFFFFF']).flat(),
    ]);
    for (const chunk of individual.slice(1)) expect(chunk.length % 2).toBe(0);
  });

  it('reinitializes after all-on and after off rather than leaving stale LEDs', async () => {
    const { driver, commands } = fixture();
    const preview = driver.createPreview('wall.local');
    await preview.show([10]);
    await preview.lightAll();
    await preview.show([11]);
    await preview.turnOff();
    await preview.show([12]);
    expect(commands().filter((command) => (command.seg as { i?: unknown }[] | undefined)?.[0]?.i)).toHaveLength(3);
    expect(commands().at(-1)).toMatchObject({ seg: [{ i: [0, 1000, '00000000', 12, 'FFFFFFFF'] }] });
  });

  it('wakes again after an off command whose acknowledgement was lost', async () => {
    const { driver, commands, fetchController } = fixture();
    const preview = driver.createPreview('lost-off.local');
    await preview.show([10]);
    fetchController.mockRejectedValueOnce(new TypeError('lost response'));
    await expect(preview.turnOff()).rejects.toMatchObject({ code: 'unavailable' });
    fetchController.mockClear();
    await preview.show([11]);
    expect(commands()).toEqual([
      expect.objectContaining({ on: true }),
      expect.objectContaining({ seg: [{ id: 0, i: [0, 1000, '00000000', 11, 'FFFFFFFF'] }] }),
    ]);
  });
});

describe('serialized LED preview ownership', () => {
  it('explicitly clears existing lights without a prior selection and wakes on the next selection', async () => {
    const { driver, commands, fetchController } = fixture();
    const session = createLedPreviewSession(driver, 'explicit-clear.local');
    expect(await session.clear()).toBe(true);
    expect(fetchController).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual([expect.objectContaining({ on: false })]);
    await session.show([1]);
    await session.clear();
    fetchController.mockClear();
    await session.show([2]);
    expect(commands()).toEqual([
      expect.objectContaining({ on: true }),
      expect.objectContaining({ seg: [{ id: 0, i: [0, 1000, '00000000', 2, 'FFFFFFFF'] }] }),
    ]);
    await session.close();
  });

  it('waits for an in-flight selection before an explicit clear takes ownership', async () => {
    const { driver, commands, fetchController } = fixture();
    let release!: () => void;
    fetchController.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ name: 'Wall', ver: '0.15', leds: { count: 1000 } }));
        }),
    );
    const selecting = createLedPreviewSession(driver, 'queued-clear.local');
    const clearing = createLedPreviewSession(driver, 'queued-clear.local');
    const selection = selecting.show([1]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cleared = clearing.clear();
    release();
    expect(await selection).toBe(false);
    expect(await cleared).toBe(true);
    expect(commands().at(-1)).toMatchObject({ on: false });
    expect(clearing.isOwner()).toBe(true);
    const count = commands().length;
    await selecting.close();
    expect(commands()).toHaveLength(count);
    await clearing.close();
    expect(commands()).toHaveLength(count);
  });

  it('snapshots route indices and nested RGB tuples while waiting for another write', async () => {
    const { driver, commands, fetchController } = fixture();
    let release!: () => void;
    fetchController.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ name: 'Wall', ver: '0.15', leds: { count: 1000 } }));
        }),
    );
    const session = createLedPreviewSession(driver, 'snapshot-colors.local');
    const first = session.show([1]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const indices = [2];
    const pixels = [{ index: 2, color: [1, 128, 255] as [number, number, number] }];
    const next = session.show(indices, pixels);
    indices[0] = 3;
    pixels[0].index = 3;
    pixels[0].color[0] = 255;
    release();
    expect(await first).toBe(false);
    expect(await next).toBe(true);
    expect(commands().at(-1)).toMatchObject({ seg: [{ i: [1, '00000000', 2, '0180FF00'] }] });
    await session.close();
  });

  it('rejects invalid colors before taking ownership or stopping the current lights', async () => {
    const { driver, commands } = fixture();
    const active = createLedPreviewSession(driver, 'preflight-colors.local');
    const other = createLedPreviewSession(driver, 'preflight-colors.local');
    await active.show([1]);
    const commandCount = commands().length;
    await expect(other.show([], [{ index: 1, color: [255, 0, 0] }])).rejects.toMatchObject({ code: 'invalid-indices' });
    expect(active.isOwner()).toBe(true);
    expect(other.isOwner()).toBe(false);
    expect(commands()).toHaveLength(commandCount);
    await other.close();
    await active.close();
  });

  it('does not turn off existing lights when a first selection fails preflight', async () => {
    const { driver, commands } = fixture();
    const session = createLedPreviewSession(driver, 'invalid-preview.local');
    await expect(session.show([1000])).rejects.toMatchObject({ code: 'invalid-indices' });
    await session.close();
    expect(commands()).toEqual([]);
  });

  it('retains the live transport after failed stop so a second stop can clear it', async () => {
    const { driver, commands, fetchController } = fixture();
    const session = createLedPreviewSession(driver, 'retry-preview.local');
    await session.show([1]);
    fetchController.mockRejectedValueOnce(new TypeError('connection lost'));
    await expect(session.stop()).rejects.toMatchObject({ code: 'unavailable' });
    expect(session.isOwner()).toBe(true);
    expect(await session.stop()).toBe(true);
    expect(commands().slice(-2)).toEqual([
      expect.objectContaining({ on: false }),
      expect.objectContaining({ on: false }),
    ]);
    await session.close();
  });

  it('clears the in-flight transport when ownership changes twice before closing', async () => {
    const { driver, commands, fetchController } = fixture();
    let release!: () => void;
    const normalFetch = fetchController.getMockImplementation()!;
    let paused = false;
    fetchController.mockImplementation((url, init) => {
      if (init?.method === 'POST' && !paused) {
        paused = true;
        return new Promise<Response>((resolve) => {
          release = () => resolve(json({ success: true }));
        });
      }
      return normalFetch(url, init);
    });
    const firstSession = createLedPreviewSession(driver, 'handoff-preview.local');
    const secondSession = createLedPreviewSession(driver, 'handoff-preview.local');
    const inFlight = firstSession.show([1]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = secondSession.show([2]);
    const returning = firstSession.show([3]);
    const closing = firstSession.close();
    release();
    await Promise.all([inFlight, second, returning, closing]);
    expect(commands().at(-1)).toMatchObject({ on: false });
    await secondSession.close();
  });

  it('coalesces waiting selections and stops after the in-flight command', async () => {
    const { driver, commands, fetchController } = fixture();
    const session = createLedPreviewSession(driver, 'wall.local');
    let release!: () => void;
    fetchController.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ name: 'Wall', ver: '0.15', leds: { count: 1000 } }));
        }),
    );
    const first = session.show([1]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const stale = session.show([2]);
    const latest = session.show([3]);
    release();
    expect(await first).toBe(false);
    expect(await stale).toBe(false);
    expect(await latest).toBe(true);
    const serialized = JSON.stringify(commands());
    expect(serialized).not.toContain('2,"FFFFFFFF"');
    expect(serialized).toContain('3,"FFFFFFFF"');
    await session.close();
    expect(commands().at(-1)).toMatchObject({ on: false });
  });

  it('mount/unmount without interaction never changes controller state', async () => {
    const { driver, fetchController } = fixture();
    await createLedPreviewSession(driver, 'unused.local').close();
    expect(fetchController).not.toHaveBeenCalled();
  });

  it('closing an old screen never extinguishes the newer owner', async () => {
    const { driver, commands } = fixture();
    const oldSession = createLedPreviewSession(driver, 'same.local/');
    const newSession = createLedPreviewSession(driver, 'http://same.local');
    await oldSession.show([1]);
    await newSession.show([2]);
    expect(oldSession.isOwner()).toBe(false);
    const count = commands().length;
    await oldSession.close();
    expect(commands()).toHaveLength(count);
    await newSession.close();
    expect(commands().at(-1)).toMatchObject({ on: false });
  });

  it('wakes a controller that something else switched off before the next route', async () => {
    const { fetchController, driver, commands } = fixture();
    const session = createLedPreviewSession(driver, 'woken.local');
    await session.show([1]);
    const count = commands().length;
    fetchController.mockImplementationOnce(async () => json({ on: false, bri: 128, seg: [{ id: 0 }] }));
    await session.show([2]);
    expect(commands()[count]).toMatchObject({ on: true });
    await session.close();
  });

  it('still writes the route, and leaves the wall lit, when the state read fails', async () => {
    const { fetchController, driver, commands } = fixture();
    const session = createLedPreviewSession(driver, 'readfail.local');
    await session.show([1]);
    const count = commands().length;
    fetchController.mockImplementationOnce(async () => {
      throw new Error('lost');
    });
    expect(await session.show([2])).toBe(true);
    expect(
      commands()
        .slice(count)
        .filter((command) => command.on === false),
    ).toHaveLength(0);
    expect(commands().at(-1)).toMatchObject({ seg: [{ id: 0, i: [1, '00000000', 2, 'FFFFFFFF'] }] });
    await session.close();
  });

  it('letting go leaves the lights on and the next session wakes the controller', async () => {
    const { driver, commands } = fixture();
    const first = createLedPreviewSession(driver, 'letgo.local');
    await first.show([1]);
    const count = commands().length;
    await first.detach();
    expect(commands()).toHaveLength(count);
    expect(first.isOwner()).toBe(false);
    expect(await first.show([2])).toBe(false);
    expect(commands()).toHaveLength(count);
    const next = createLedPreviewSession(driver, 'letgo.local');
    expect(await next.show([3])).toBe(true);
    expect(commands()[count]).toMatchObject({ on: true });
  });

  it('does not blank the wall when a write in flight fails after letting go', async () => {
    const { fetchController, driver, commands } = fixture();
    const session = createLedPreviewSession(driver, 'inflight.local');
    await session.show([1]);
    let failWrite: (() => void) | undefined;
    fetchController.mockImplementationOnce(async () => json({ on: true, bri: 64, seg: [{ id: 0 }] }));
    fetchController.mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          failWrite = () => reject(new Error('lost'));
        }),
    );
    const writing = session.show([2]);
    await vi.waitFor(() => expect(failWrite).toBeDefined());
    const letGo = session.detach();
    failWrite?.();
    await expect(writing).rejects.toThrow();
    await letGo;
    expect(commands().filter((command) => command.on === false)).toHaveLength(0);
  });

  it('a stop superseded immediately by a selection does not drop the selection', async () => {
    const { driver, commands } = fixture();
    const session = createLedPreviewSession(driver, 'superseded.local');
    await session.show([1]);
    const stop = session.stop();
    const next = session.show([2]);
    expect(await stop).toBe(false);
    expect(await next).toBe(true);
    expect(commands().at(-1)).toMatchObject({ seg: [{ i: [1, '00000000', 2, 'FFFFFFFF'] }] });
    await session.close();
  });
});
