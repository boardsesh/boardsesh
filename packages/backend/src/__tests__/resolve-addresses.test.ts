import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveAddresses } from '../lib/resolve-addresses';

const { resolve4, resolve6, cancel } = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn(), cancel: vi.fn() }));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolve4 = resolve4;
    resolve6 = resolve6;
    cancel = cancel;
  },
}));

describe('bounded DNS resolution', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });
  it('keeps IPv6 answers for a host without A records', async () => {
    resolve4.mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
    resolve6.mockResolvedValue(['2606:4700:4700::1111']);
    await expect(resolveAddresses('receiver.example')).resolves.toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });
  it('rejects a partial answer when the other family fails', async () => {
    resolve4.mockResolvedValue(['1.1.1.1']);
    resolve6.mockRejectedValue(new Error('unavailable'));
    await expect(resolveAddresses('receiver.example')).rejects.toThrow('unavailable');
    expect(cancel).toHaveBeenCalled();
  });
  it('cancels the outstanding resolver after five seconds', async () => {
    vi.useFakeTimers();
    resolve4.mockResolvedValue(['1.1.1.1']);
    resolve6.mockImplementation(
      () => new Promise((_, reject) => cancel.mockImplementationOnce(() => reject(new Error('cancelled')))),
    );
    const checked = expect(resolveAddresses('receiver.example')).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(5000);
    await checked;
  });
});
