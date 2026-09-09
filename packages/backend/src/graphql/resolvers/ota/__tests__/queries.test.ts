import { describe, it, expect } from 'vite-plus/test';
import { otaQueries } from '../queries';
import { resolvers } from '../../index';

// `otaPreviewChannels` is a compatibility stub: the per-PR channel switcher it
// fed was replaced by xprem Branch Surfing in #4792, which deleted the field and
// left every pre-#4792 store binary sending a document the schema no longer had.
// Those binaries sit behind a native fingerprint change and can never be handed
// an OTA that stops asking, so the field has to answer — and an empty list is
// exactly what the old switcher renders as "no previews right now" (#5370).
describe('otaPreviewChannels', () => {
  it('answers with an empty list', () => {
    expect(otaQueries.otaPreviewChannels()).toEqual([]);
  });

  it('does no I/O — it is synchronous, so there is no source left to fail', () => {
    expect(otaQueries.otaPreviewChannels()).not.toBeInstanceOf(Promise);
  });

  // Restoring the schema field without wiring the resolver would still 400 for
  // those builds (graphql-js resolves the field to null, and the non-null list
  // type turns that into an error), so pin the wiring, not just the function.
  it('is wired into the Query resolver map', () => {
    expect(resolvers.Query).toHaveProperty('otaPreviewChannels');
  });
});
