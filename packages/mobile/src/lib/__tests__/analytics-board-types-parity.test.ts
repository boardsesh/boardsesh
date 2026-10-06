import { describe, expect, it } from 'vitest';
import { ANALYTICS_BOARD_TYPES } from '@boardsesh/analytics';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';

// `@boardsesh/analytics` has no dependencies, so it keeps its own copy of the
// board list for the `boardType` event prop. This is what stops the copy going
// stale: a tenth board added to the schema and not here would send
// `boardType: null` on every tick logged on it.
describe('analytics board types', () => {
  it('are exactly the supported boards', () => {
    expect([...ANALYTICS_BOARD_TYPES].sort()).toEqual([...SUPPORTED_BOARDS].sort());
  });
});
