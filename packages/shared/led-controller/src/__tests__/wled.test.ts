import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWledDriver } from '../wled';

const deviceInfo = { name: 'Garage wall', ver: '0.15.0', brand: 'WLED', leds: { count: 180 } };
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.useRealTimers());

describe('WLED driver', () => {
  it('probes the info endpoint without sending commands or browser credentials', async () => {
    const fetchController = vi.fn<typeof fetch>().mockResolvedValue(json(deviceInfo));
    const info = await createWledDriver({ fetch: fetchController }).probe('http://wled.local/proxy/');
    expect(info).toEqual({ name: 'Garage wall', version: '0.15.0', ledCount: 180 });
    expect(fetchController).toHaveBeenCalledTimes(1);
    expect(fetchController).toHaveBeenCalledWith(
      'http://wled.local/proxy/json/info',
      expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' }),
    );
    expect(fetchController.mock.calls[0][1]?.body).toBeUndefined();
  });

  it.each(['WLED', 'www.athom.tech', 'Custom manufacturer', undefined])(
    'accepts WLED firmware with manufacturer brand %s over local HTTP',
    async (brand) => {
      const fetchController = vi.fn<typeof fetch>().mockResolvedValue(json({ ...deviceInfo, brand }));
      const info = await createWledDriver({ fetch: fetchController }).probe('http://192.168.1.50');
      expect(info).toEqual({ name: 'Garage wall', version: '0.15.0', ledCount: 180 });
      expect(fetchController).toHaveBeenCalledTimes(1);
      expect(fetchController).toHaveBeenCalledWith(
        'http://192.168.1.50/json/info',
        expect.objectContaining({ method: 'GET' }),
      );
    },
  );

  it.each([
    {},
    { ...deviceInfo, brand: 123 },
    { ...deviceInfo, name: ' ' },
    { ...deviceInfo, ver: '' },
    { ...deviceInfo, leds: { count: 0 } },
    { ...deviceInfo, leds: { count: -1 } },
    { ...deviceInfo, leds: { count: 1.5 } },
    { ...deviceInfo, leds: { count: '180' } },
  ])('does not report a non-WLED response as connected: %j', async (payload) => {
    const driver = createWledDriver({ fetch: vi.fn<typeof fetch>().mockResolvedValue(json(payload)) });
    await expect(driver.probe('wled.local')).rejects.toMatchObject({ code: 'not-wled' });
  });

  it('distinguishes HTTP failures, malformed JSON, and connection failures', async () => {
    const fetchController = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(new Response('<html>login</html>'))
      .mockRejectedValueOnce(new TypeError('Network request failed'));
    const driver = createWledDriver({ fetch: fetchController });
    await expect(driver.probe('wled.local')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(driver.probe('wled.local')).rejects.toMatchObject({ code: 'not-wled' });
    await expect(driver.probe('wled.local')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('bounds even a transport that ignores cancellation', async () => {
    vi.useFakeTimers();
    const fetchController = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = createWledDriver({ fetch: fetchController, timeoutMs: 100 }).probe('wled.local');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetchController.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds reading the response body as well as connecting', async () => {
    vi.useFakeTimers();
    const response = json(deviceInfo);
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const driver = createWledDriver({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response), timeoutMs: 100 });
    const rejected = expect(driver.probe('wled.local')).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it('aborts a stale request and does not turn cancellation into a network error', async () => {
    const abort = new AbortController();
    const fetchController = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = createWledDriver({ fetch: fetchController }).probe('wled.local', abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchController.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(createWledDriver({ fetch: fetchController }).probe('wled.local', abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(fetchController).toHaveBeenCalledTimes(1);
  });

  it('lights the full strip, including gaps, with overlapping and frozen segments reset', async () => {
    const fetchController = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(deviceInfo))
      .mockResolvedValueOnce(
        json({
          on: false,
          seg: [
            { id: 0, start: 30, stop: 60, spc: 2 },
            { id: 3, start: 70, stop: 90, frz: true },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ success: true }));
    await createWledDriver({ fetch: fetchController }).lightAll('wled.local');
    expect(fetchController).toHaveBeenCalledTimes(3);
    const call = fetchController.mock.calls[2];
    expect(call[0]).toBe('http://wled.local/json/state');
    expect(call[1]?.method).toBe('POST');
    const body = call[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request body');
    const command: unknown = JSON.parse(body);
    expect(command).toMatchObject({
      on: true,
      bri: 64,
      nl: { on: false },
      udpn: { nn: true },
      seg: [
        { id: 0, start: 0, stop: 180, on: true, spc: 0, fx: 0, frz: false, col: [[255, 255, 255, 255]] },
        { id: 3, on: true, spc: 0, fx: 0, frz: false, col: [[255, 255, 255, 255]] },
      ],
    });
    // Test lighting must not persist a preset or erase existing segment bounds.
    expect(command).not.toHaveProperty('psave');
    expect(command).not.toHaveProperty('pdel');
    expect(command).not.toHaveProperty('seg.1.stop');
  });

  it('sends no lighting command if a fresh device or segment read fails', async () => {
    const fetchController = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(deviceInfo))
      .mockResolvedValueOnce(json({ seg: [{ id: -1 }] }));
    await expect(createWledDriver({ fetch: fetchController }).lightAll('wled.local')).rejects.toMatchObject({
      code: 'not-wled',
    });
    expect(fetchController.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });

  it.each([{ success: false }, {}, { error: 9 }])('rejects an unacknowledged write: %j', async (payload) => {
    const driver = createWledDriver({ fetch: vi.fn<typeof fetch>().mockResolvedValue(json(payload)) });
    await expect(driver.turnOff('wled.local')).rejects.toMatchObject({ code: 'command-failed' });
  });

  it('can switch off without a prior successful probe and does not broadcast', async () => {
    const fetchController = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true }));
    await createWledDriver({ fetch: fetchController }).turnOff('wled.local');
    expect(fetchController).toHaveBeenCalledTimes(1);
    const body = fetchController.mock.calls[0][1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(body)).toEqual({
      on: false,
      tt: 0,
      live: false,
      udpn: { nn: true },
    });
  });
});
