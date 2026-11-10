import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  ADMISSION_READ_LOG_WINDOW_MS,
  admissionReadErrorCode,
  createAdmissionReadDiagnostics,
  type AdmissionReadSample,
} from '../admission-read-diagnostics';

function sample(overrides: Partial<AdmissionReadSample> = {}): AdmissionReadSample {
  return { outcome: 'deadline_missed', waitMs: 1000, executeMs: 0, unsettledReads: 8, ...overrides };
}

describe('admission read log', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs the first read of a kind immediately, with only numbers and fixed labels', () => {
    const log = vi.fn();
    createAdmissionReadDiagnostics(log)(sample({ waitMs: 998, executeMs: 2 }));

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[auth-admission] read slow or unanswered', {
      outcome: 'deadline_missed',
      waitMs: 998,
      executeMs: 2,
      unsettledReads: 8,
    });
  });

  it('keeps a stall to one line, then one totals line for the rest of the window', () => {
    const log = vi.fn();
    const record = createAdmissionReadDiagnostics(log);

    for (let read = 0; read < 500; read += 1) record(sample({ waitMs: read, executeMs: read * 2 }));
    expect(log).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ADMISSION_READ_LOG_WINDOW_MS);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith('[auth-admission] more reads like the last one', {
      outcome: 'deadline_missed',
      suppressedReads: 499,
      maxWaitMs: 499,
      maxExecuteMs: 998,
      windowMs: ADMISSION_READ_LOG_WINDOW_MS,
    });
  });

  it('writes no totals line when a window saw a single read', () => {
    const log = vi.fn();
    createAdmissionReadDiagnostics(log)(sample());
    vi.advanceTimersByTime(ADMISSION_READ_LOG_WINDOW_MS);
    expect(log).toHaveBeenCalledOnce();
  });

  it('opens a fresh window after the last one closes', () => {
    const log = vi.fn();
    const record = createAdmissionReadDiagnostics(log);
    record(sample());
    vi.advanceTimersByTime(ADMISSION_READ_LOG_WINDOW_MS);
    record(sample({ waitMs: 7 }));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][1]).toMatchObject({ waitMs: 7 });
  });

  it('rate-limits each kind separately, so a burst of one cannot hide another', () => {
    const log = vi.fn();
    const record = createAdmissionReadDiagnostics(log);
    record(sample({ outcome: 'slow' }));
    record(sample({ outcome: 'slow' }));
    record(sample({ outcome: 'refused' }));
    record(sample({ outcome: 'failed', errorCode: '57014' }));
    record(sample({ outcome: 'failed', errorCode: 'CONNECT_TIMEOUT' }));
    expect(log.mock.calls.map(([, fields]) => [fields.outcome, fields.errorCode])).toEqual([
      ['slow', undefined],
      ['refused', undefined],
      ['failed', '57014'],
      ['failed', 'CONNECT_TIMEOUT'],
    ]);
  });
});

describe('admissionReadErrorCode', () => {
  it('passes a driver or SQLSTATE code through', () => {
    expect(admissionReadErrorCode({ code: '57014' })).toBe('57014');
    expect(admissionReadErrorCode({ code: 'CONNECT_TIMEOUT' })).toBe('CONNECT_TIMEOUT');
  });

  it('never lets anything but a code-shaped string through', () => {
    expect(admissionReadErrorCode({ code: 'climber@example.com' })).toBe('UNKNOWN');
    expect(admissionReadErrorCode({ code: '12345678901234567890123456789012X' })).toBe('UNKNOWN');
    expect(admissionReadErrorCode({ code: 57014 })).toBe('UNKNOWN');
    expect(admissionReadErrorCode(new Error('user 42 not found'))).toBe('UNKNOWN');
    expect(admissionReadErrorCode(null)).toBe('UNKNOWN');
  });
});
