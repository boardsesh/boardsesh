import { describe, it, expect } from 'vite-plus/test';
import { cncErrorKey } from '../cnc-error';

/**
 * The whole point of `cncErrorKey` is that it never throws. It runs inside a
 * catch block, so anything it does not understand has to become `generic`
 * rather than a second error on top of the first — which is why most of these
 * cases are shapes it was never designed for.
 */
describe('cncErrorKey', () => {
  it('reads the code a resolver set on the first matching error', () => {
    const error = { response: { errors: [{ extensions: { code: 'CNC_INVALID_CONFIG' } }] } };

    expect(cncErrorKey(error)).toBe('CNC_INVALID_CONFIG');
  });

  it('keeps the three backend codes apart', () => {
    const withCode = (code: string) => ({ response: { errors: [{ extensions: { code } }] } });

    expect(cncErrorKey(withCode('CNC_WORKER_UNAVAILABLE'))).toBe('CNC_WORKER_UNAVAILABLE');
    expect(cncErrorKey(withCode('CNC_CHECKOUT_UNAVAILABLE'))).toBe('CNC_CHECKOUT_UNAVAILABLE');
  });

  it('skips entries with no usable code and takes the one that has it', () => {
    const error = {
      response: {
        errors: [
          null,
          'a string where an object was expected',
          { message: 'no extensions at all' },
          { extensions: null },
          { extensions: { code: 'SOMETHING_ELSE' } },
          { extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } },
        ],
      },
    };

    expect(cncErrorKey(error)).toBe('CNC_CHECKOUT_UNAVAILABLE');
  });

  it('falls back to generic for a code the UI has no message for', () => {
    expect(cncErrorKey({ response: { errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } })).toBe('generic');
  });

  it('falls back to generic for the transport failures that carry no GraphQL body', () => {
    // An aborted fetch, a dropped connection, a proxy's HTML error page, and a
    // thrown string all reach the same catch block as a real GraphQL error.
    expect(cncErrorKey(new TypeError('Failed to fetch'))).toBe('generic');
    expect(cncErrorKey('network down')).toBe('generic');
    expect(cncErrorKey(null)).toBe('generic');
    expect(cncErrorKey(undefined)).toBe('generic');
    expect(cncErrorKey({ response: '<html>502 Bad Gateway</html>' })).toBe('generic');
    expect(cncErrorKey({ response: { errors: 'not an array' } })).toBe('generic');
    expect(cncErrorKey({ response: { errors: [] } })).toBe('generic');
  });
});
