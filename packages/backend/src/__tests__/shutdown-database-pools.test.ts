import { describe, expect, it, vi } from 'vite-plus/test';
import { closeDatabasePools } from '../shutdown-database-pools';

describe('database pool shutdown ownership', () => {
  it.each(['credential', 'read', 'primary', 'admission'] as const)(
    'attempts every pool when %s close fails',
    async (failedOwner) => {
      const attempted: string[] = [];
      const close = (owner: string) => async () => {
        attempted.push(owner);
        if (owner === failedOwner) throw new Error('Owned close failure');
      };
      expect(
        await closeDatabasePools({
          credential: close('credential'),
          read: close('read'),
          primary: close('primary'),
          admission: close('admission'),
        }),
      ).toBe(false);
      expect(attempted).toEqual(['credential', 'read', 'primary', 'admission']);
    },
  );

  it('waits for content and credential owners before closing admission', async () => {
    let releaseCredential: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseCredential = resolve;
    });
    const admission = vi.fn(async () => {});
    const pending = closeDatabasePools({
      credential: () => held,
      read: async () => {},
      primary: async () => {},
      admission,
    });
    await Promise.resolve();
    expect(admission).not.toHaveBeenCalled();
    releaseCredential();
    expect(await pending).toBe(true);
    expect(admission).toHaveBeenCalledOnce();
  });
});
