import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
vi.mock('@boardsesh/graphql-client', () => ({ execute: (...args: unknown[]) => execute(...args) }));
vi.mock('../../graphql/ws-client', () => ({ getWsClient: () => ({}) }));

import {
  moonboardLinkDetectionToReport,
  reportMoonboardLinkDetection,
  resetMoonboardLinkDetectionForTests,
} from '../moonboard-link-detection';

const base = { enabled: true, boardType: 'moonboard', boardId: 42, characteristicProperties: 8 };

describe('moonboardLinkDetectionToReport', () => {
  it.each([
    ['original box (write only)', { ...base, characteristicProperties: 8 }, 'relay'],
    ['original box (write + read)', { ...base, characteristicProperties: 10 }, 'relay'],
    ['V3 onwards', { ...base, characteristicProperties: 12 }, 'multi'],
    ['DIY firmware', { ...base, characteristicProperties: 4 }, 'multi'],
    ['Android, no properties', { ...base, characteristicProperties: undefined }, null],
    ['flag off', { ...base, enabled: false }, null],
    ['Kilter', { ...base, boardType: 'kilter' }, null],
    ['no presence board id', { ...base, boardId: null }, null],
  ] as const)('%s', (_label, input, expected) => {
    expect(moonboardLinkDetectionToReport(input)).toBe(expected);
  });
});

describe('reportMoonboardLinkDetection', () => {
  beforeEach(() => {
    execute.mockReset();
    resetMoonboardLinkDetectionForTests();
  });

  it('reports once per board and mode per launch', async () => {
    execute.mockResolvedValue({ reportMoonboardLinkDetected: true });
    reportMoonboardLinkDetection(base);
    reportMoonboardLinkDetection(base);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0][1].variables).toEqual({ boardId: 42, detected: 'relay' });
  });

  it('retries on a later connect when the report failed', async () => {
    execute.mockRejectedValueOnce(new Error('offline'));
    reportMoonboardLinkDetection(base);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    execute.mockResolvedValue({ reportMoonboardLinkDetected: true });
    reportMoonboardLinkDetection(base);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });

  it('sends nothing for an Android connect', async () => {
    reportMoonboardLinkDetection({ ...base, characteristicProperties: undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();
  });
});
