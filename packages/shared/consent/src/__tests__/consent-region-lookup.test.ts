import { describe, expect, it, vi } from 'vitest';
import { createConsentRegionLookup } from '../consent-region-lookup';

function deferred<Answer>() {
  let resolve!: (answer: Answer) => void;
  const promise = new Promise<Answer>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('createConsentRegionLookup', () => {
  it('caches a completed answer until resume', async () => {
    const request = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const lookup = createConsentRegionLookup(request);
    expect(lookup.expire()).toBe(false);
    await expect(lookup.lookUp()).resolves.toBe(false);
    await expect(lookup.lookUp()).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(lookup.expire()).toBe(true);
    await expect(lookup.lookUp()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('coalesces pending resumes and never publishes the old location', async () => {
    const oldLocation = deferred<boolean>();
    const freshLocation = deferred<boolean>();
    const request = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(oldLocation.promise)
      .mockReturnValueOnce(freshLocation.promise);
    const lookup = createConsentRegionLookup(request);
    const pending = lookup.lookUp();
    const published = vi.fn();
    void pending.then(published);
    expect(lookup.expire()).toBe(true);
    expect(lookup.expire()).toBe(true);
    expect(lookup.lookUp()).toBe(pending);
    expect(request).toHaveBeenCalledOnce();

    oldLocation.resolve(false);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(published).not.toHaveBeenCalled();
    freshLocation.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(published).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('retires a settled promise before an awaiting UI callback can confirm capture', async () => {
    const oldLocation = deferred<boolean>();
    const request = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(oldLocation.promise)
      .mockResolvedValueOnce(true);
    const lookup = createConsentRegionLookup(request);
    const pending = lookup.lookUp();
    const published = vi.fn();
    // A resume callback runs after settlement, before the registered consumer.
    void pending.then(() => {
      lookup.expire();
    });
    void pending.then((answer) => {
      if (lookup.isCurrent(pending)) published(answer);
    });
    oldLocation.resolve(false);
    await pending;
    expect(lookup.isCurrent(pending)).toBe(false);
    expect(published).not.toHaveBeenCalled();
    await expect(lookup.lookUp()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('queues another fresh answer when a second resume occurs during the refresh', async () => {
    const oldLocation = deferred<boolean>();
    const firstResume = deferred<boolean>();
    const secondResume = deferred<boolean>();
    const request = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(oldLocation.promise)
      .mockReturnValueOnce(firstResume.promise)
      .mockReturnValueOnce(secondResume.promise);
    const lookup = createConsentRegionLookup(request);
    const pending = lookup.lookUp();
    lookup.expire();
    oldLocation.resolve(false);
    await Promise.resolve();
    lookup.expire();
    firstResume.resolve(false);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(3);
    secondResume.resolve(true);
    await expect(pending).resolves.toBe(true);
  });
});
