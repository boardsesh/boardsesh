import { describe, it, expect } from 'vitest';
import { GYM_RUN_BY_STAFF_CODE, isGymRunByStaffError } from '../errors';

describe('isGymRunByStaffError', () => {
  it('reads the code off a graphql-request error', () => {
    const error = { response: { errors: [{ message: 'run by staff', extensions: { code: GYM_RUN_BY_STAFF_CODE } }] } };
    expect(isGymRunByStaffError(error)).toBe(true);
  });

  it('reads the code off an error that carries its own extensions', () => {
    expect(isGymRunByStaffError({ extensions: { code: 'GYM_RUN_BY_STAFF' } })).toBe(true);
  });

  it('is false for any other refusal, a message match, or no error at all', () => {
    expect(isGymRunByStaffError({ response: { errors: [{ extensions: { code: 'GYM_CLAIM_LIMIT_REACHED' } }] } })).toBe(
      false,
    );
    expect(isGymRunByStaffError(new Error('GYM_RUN_BY_STAFF'))).toBe(false);
    expect(isGymRunByStaffError(null)).toBe(false);
    expect(isGymRunByStaffError({ response: { errors: [null] } })).toBe(false);
  });
});
