import { describe, expect, it } from 'vite-plus/test';
import { databaseErrorCode } from '../database-error-code';

// #7596 B7: a private command that answers `unavailable` logs why, as a code only.
describe('databaseErrorCode', () => {
  it('finds the SQLSTATE on the driver error or on a wrapper cause', () => {
    const driver = Object.assign(new Error('permission denied for table user_profiles'), { code: '42501' });
    expect(databaseErrorCode(driver)).toBe('42501');
    expect(databaseErrorCode(new Error('Failed query: select ...', { cause: driver }))).toBe('42501');
    expect(databaseErrorCode(new Error('outer', { cause: new Error('middle', { cause: driver }) }))).toBe('42501');
  });

  it('gives nothing for an error without a code, a driver code that is not a SQLSTATE, or a non-error', () => {
    expect(databaseErrorCode(new Error('Web session authority unavailable'))).toBeUndefined();
    expect(databaseErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(databaseErrorCode(Object.assign(new Error('x'), { code: '42501; DROP' }))).toBeUndefined();
    expect(databaseErrorCode(undefined)).toBeUndefined();
    expect(databaseErrorCode('42501')).toBeUndefined();
  });

  it('stops on a cause cycle', () => {
    const looped: { code?: string; cause?: unknown } = {};
    looped.cause = looped;
    expect(databaseErrorCode(looped)).toBeUndefined();
  });
});
