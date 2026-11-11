import { describe, expect, it, vi } from 'vitest';
import { discoverLedControllers, wledScanHosts } from '../discovery';
import { LedControllerError } from '../types';

describe('wledScanHosts', () => {
  it('lists the /24 around the phone without the phone, the network or broadcast address', () => {
    const hosts = wledScanHosts('192.168.1.132', '255.255.255.0');
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts.at(-1)).toBe('192.168.1.254');
    expect(hosts).not.toContain('192.168.1.132');
  });

  it('narrows a large home subnet to the /24 around the phone', () => {
    const hosts = wledScanHosts('10.0.5.20', '255.255.0.0');
    expect(hosts[0]).toBe('10.0.5.1');
    expect(hosts).toHaveLength(253);
  });

  it('honours a smaller subnet and works without a mask', () => {
    expect(wledScanHosts('192.168.0.10', '255.255.255.252')).toEqual(['192.168.0.9']);
    expect(wledScanHosts('172.16.3.4')).toHaveLength(253);
  });

  it('never scans a public, cellular-style or malformed address', () => {
    expect(wledScanHosts('8.8.8.8', '255.255.255.0')).toEqual([]);
    expect(wledScanHosts('100.64.1.2')).toEqual([]);
    expect(wledScanHosts('192.168.1')).toEqual([]);
    expect(wledScanHosts('192.168.1.300')).toEqual([]);
  });
});

describe('discoverLedControllers', () => {
  it('returns every answering controller in address order and reports progress', async () => {
    const probe = vi.fn(async (url: string) => {
      if (url === 'http://192.168.1.40' || url === 'http://192.168.1.7') {
        return { name: url.endsWith('40') ? 'Wall' : 'Desk', version: '0.15', ledCount: 100 };
      }
      throw new LedControllerError('unavailable');
    });
    const progress = vi.fn();
    const found = await discoverLedControllers(wledScanHosts('192.168.1.132'), {
      probe,
      concurrency: 8,
      onProgress: progress,
    });
    expect(found.map((controller) => controller.url)).toEqual(['http://192.168.1.7', 'http://192.168.1.40']);
    expect(probe).toHaveBeenCalledTimes(253);
    expect(progress).toHaveBeenLastCalledWith(253, 253);
  });

  it('stops probing and rejects as cancelled when aborted', async () => {
    const abort = new AbortController();
    const probe = vi.fn(async () => {
      abort.abort();
      throw new LedControllerError('cancelled');
    });
    await expect(
      discoverLedControllers(['192.168.1.2', '192.168.1.3', '192.168.1.4'], {
        probe,
        concurrency: 1,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
