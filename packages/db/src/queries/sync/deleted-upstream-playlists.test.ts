import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deletedUpstreamPlaylistKeys } from './deleted-upstream-playlists';

void describe('deletedUpstreamPlaylistKeys (#7240)', () => {
  void it('records nothing for a playlist built in Boardsesh', () => {
    assert.deepEqual(deletedUpstreamPlaylistKeys({ boardType: 'kilter', kilterId: null, auroraId: null }), []);
  });

  void it('records the kilter_id of a Grips circuit', () => {
    assert.deepEqual(deletedUpstreamPlaylistKeys({ boardType: 'kilter', kilterId: 'grips-1', auroraId: null }), [
      { upstreamSource: 'kilter', upstreamId: 'grips-1' },
    ]);
  });

  void it('records only the aurora_id of an Aurora-board circuit', () => {
    assert.deepEqual(deletedUpstreamPlaylistKeys({ boardType: 'tension', kilterId: null, auroraId: 'circuit-1' }), [
      { upstreamSource: 'aurora', upstreamId: 'circuit-1' },
    ]);
  });

  void it('also records an unadopted pre-split Kilter aurora_id as a kilter id, the uuid Grips kept', () => {
    assert.deepEqual(deletedUpstreamPlaylistKeys({ boardType: 'kilter', kilterId: null, auroraId: 'legacy-1' }), [
      { upstreamSource: 'aurora', upstreamId: 'legacy-1' },
      { upstreamSource: 'kilter', upstreamId: 'legacy-1' },
    ]);
  });

  void it('writes each pair once when tier-1 adoption made kilter_id equal aurora_id', () => {
    assert.deepEqual(deletedUpstreamPlaylistKeys({ boardType: 'kilter', kilterId: 'same-1', auroraId: 'same-1' }), [
      { upstreamSource: 'kilter', upstreamId: 'same-1' },
      { upstreamSource: 'aurora', upstreamId: 'same-1' },
    ]);
  });

  void it('records all three pairs for a tier-2 adopted Kilter playlist', () => {
    assert.deepEqual(
      deletedUpstreamPlaylistKeys({ boardType: 'kilter', kilterId: 'grips-2', auroraId: 'json-import-2' }),
      [
        { upstreamSource: 'kilter', upstreamId: 'grips-2' },
        { upstreamSource: 'aurora', upstreamId: 'json-import-2' },
        { upstreamSource: 'kilter', upstreamId: 'json-import-2' },
      ],
    );
  });
});
