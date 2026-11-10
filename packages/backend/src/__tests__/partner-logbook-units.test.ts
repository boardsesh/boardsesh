import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { TickSchema } from '@boardsesh/public-api';
import { PARTNER_SECRET_MAX_VERSION, parsePartnerSecrets } from '../auth/partner/configuration';
import { createLogbookSnapshotAdmission } from '../auth/partner/logbook-access';
import {
  TEST_EXPIRED_CURSOR,
  decodeLogbookCursor,
  encodeLogbookCursor,
  type LogbookCursor,
} from '../handlers/public-api/logbook-cursor';
import type { LogbookFeedTick } from '../services/logbook-feed';
import {
  WITHHELD_LAYOUT_NAME,
  logbookGrade,
  serializeLogbookTick,
  utcTimestamp,
  type LogbookClimbMetadata,
} from '../services/logbook-tick-serializer';

/**
 * The pure parts of the logbook routes: the cursor, the tick serializer and the
 * snapshot pool's admission gate. Each protection here has a test that fails
 * without it:
 * - drop the GCM tag check (`setAuthTag`): the tampered-cursor test fails.
 * - sign with the key alone, without the version as associated data: the
 *   version-swap test fails.
 * - let a build wait for a permit: the build-never-queues test fails.
 * - drop the spray rule from the serializer: the withheld-names tests fail.
 */

const SECRETS = [{ version: 2, value: 'partner-oauth-test-secret-version-two-0123456789' }];
const OLDER_SECRETS = [
  { version: 2, value: 'partner-oauth-test-secret-version-two-0123456789' },
  { version: 1, value: 'partner-oauth-test-secret-version-one-0123456789' },
];

const CHANGES_CURSOR: LogbookCursor = {
  kind: 'changes',
  connectionId: randomUUID(),
  connectionGeneration: 3,
  feedGeneration: '7249eeb7-7da2-4e96-93d2-71b0531c5fec',
  txid: '18446744073709551000',
  seq: '42',
};
const SNAPSHOT_CURSOR: LogbookCursor = {
  kind: 'snapshot',
  connectionId: randomUUID(),
  connectionGeneration: 0,
  snapshotId: randomUUID(),
  position: 400,
};

describe('the logbook cursor', () => {
  it.each([CHANGES_CURSOR, SNAPSHOT_CURSOR])('round-trips a $kind cursor', (cursor) => {
    const encoded = encodeLogbookCursor(cursor, SECRETS);
    expect(encoded).toMatch(/^c3\.2\.[A-Za-z0-9_-]+$/);
    expect(decodeLogbookCursor(encoded, SECRETS)).toEqual({ status: 'ok', cursor });
  });

  it('says nothing readable: no connection id, snapshot id or position in the clear', () => {
    const encoded = encodeLogbookCursor(SNAPSHOT_CURSOR, SECRETS);
    const opened = Buffer.from(encoded.split('.')[2], 'base64url').toString('latin1');
    for (const secret of [
      SNAPSHOT_CURSOR.connectionId,
      (SNAPSHOT_CURSOR as { snapshotId: string }).snapshotId,
      '"p":400',
    ]) {
      expect(encoded).not.toContain(secret);
      expect(opened).not.toContain(secret);
    }
  });

  it('refuses a cursor with any byte changed', () => {
    const encoded = encodeLogbookCursor(CHANGES_CURSOR, SECRETS);
    const sealed = Buffer.from(encoded.split('.')[2], 'base64url');
    for (const index of [0, 12, Math.floor(sealed.length / 2), sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] ^= 0x01;
      expect(decodeLogbookCursor(`c3.2.${tampered.toString('base64url')}`, SECRETS)).toEqual({ status: 'invalid' });
    }
  });

  it('refuses a cursor sealed under one version and relabelled as another', () => {
    const underOne = encodeLogbookCursor(CHANGES_CURSOR, [OLDER_SECRETS[1]]);
    expect(decodeLogbookCursor(underOne, OLDER_SECRETS)).toEqual({ status: 'ok', cursor: CHANGES_CURSOR });
    const relabelled = underOne.replace(/^c3\.1\./, 'c3.2.');
    expect(decodeLogbookCursor(relabelled, OLDER_SECRETS)).toEqual({ status: 'invalid' });
    // Even when two versions carry the same value, the version is sealed in.
    const sameValue = [
      { version: 2, value: OLDER_SECRETS[1].value },
      { version: 1, value: OLDER_SECRETS[1].value },
    ];
    const sealedUnderOne = encodeLogbookCursor(CHANGES_CURSOR, [sameValue[1]]);
    expect(decodeLogbookCursor(sealedUnderOne, sameValue)).toEqual({ status: 'ok', cursor: CHANGES_CURSOR });
    expect(decodeLogbookCursor(sealedUnderOne.replace(/^c3\.1\./, 'c3.2.'), sameValue)).toEqual({
      status: 'invalid',
    });
  });

  it('reads a cursor under every secret version the configuration accepts, and the first refused one would not fit', () => {
    const value = 'partner-oauth-test-secret-largest-version-0123456789';
    const [largest] = parsePartnerSecrets(`${PARTNER_SECRET_MAX_VERSION}:${value}`);
    const sealed = encodeLogbookCursor(CHANGES_CURSOR, [largest]);
    expect(sealed.startsWith(`c3.${PARTNER_SECRET_MAX_VERSION}.`)).toBe(true);
    expect(decodeLogbookCursor(sealed, [largest])).toEqual({ status: 'ok', cursor: CHANGES_CURSOR });

    expect(() => parsePartnerSecrets(`${PARTNER_SECRET_MAX_VERSION + 1}:${value}`)).toThrow(/above 999999999/);
    // Had it been accepted, its cursors would read as junk: that is why it is refused at startup.
    const tooLarge = { version: PARTNER_SECRET_MAX_VERSION + 1, value };
    expect(decodeLogbookCursor(encodeLogbookCursor(CHANGES_CURSOR, [tooLarge]), [tooLarge])).toEqual({
      status: 'invalid',
    });
  });

  it('expires a cursor whose secret was retired, and the documented test cursor', () => {
    const underOne = encodeLogbookCursor(CHANGES_CURSOR, [OLDER_SECRETS[1]]);
    expect(decodeLogbookCursor(underOne, SECRETS)).toEqual({ status: 'expired' });
    expect(decodeLogbookCursor(TEST_EXPIRED_CURSOR, SECRETS)).toEqual({ status: 'expired' });
  });

  it.each([
    ['empty', ''],
    ['another prefix', 'c2.2.AAAA'],
    ['no version', 'c3.AAAA'],
    ['not base64url', 'c3.2.a+b/c='],
    ['too short to hold a tag', 'c3.2.AAAA'],
    ['far too long', `c3.2.${'A'.repeat(2000)}`],
    ['the docs example', 'c3.eyJraW5kIjo'],
  ])('refuses %s as invalid', (_label, raw) => {
    expect(decodeLogbookCursor(raw, SECRETS)).toEqual({ status: 'invalid' });
  });
});

const BASE_TICK: LogbookFeedTick = {
  uuid: '0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77',
  boardType: 'kilter',
  climbUuid: 'climb-alias',
  canonicalClimbUuid: 'climb-canonical',
  angle: 40,
  isMirror: false,
  status: 'send',
  attemptCount: 3,
  quality: 4,
  difficulty: 19,
  isBenchmark: true,
  comment: 'Finally stuck the cross-through',
  climbedAt: '2026-10-20 18:42:11.123456',
  createdAt: '2026-10-20 18:42:15',
  updatedAt: '2026-10-20 18:42:15',
};

function metadataFor(
  tick: LogbookFeedTick,
  climb: Partial<{ name: string | null; layoutName: string | null; namesVisible: boolean }> | null,
  communityDifficulty: number | null = null,
): LogbookClimbMetadata {
  const metadata: LogbookClimbMetadata = { climbs: new Map(), communityDifficulty: new Map() };
  if (climb) {
    metadata.climbs.set(`${tick.boardType}\u0000${tick.canonicalClimbUuid}`, {
      name: 'Slopey Business',
      layoutName: 'Kilter Board Original',
      namesVisible: true,
      ...climb,
    });
  }
  metadata.communityDifficulty.set(
    `${tick.boardType}\u0000${tick.canonicalClimbUuid}\u0000${tick.angle}`,
    communityDifficulty,
  );
  return metadata;
}

describe('the tick serializer', () => {
  it('serves the documented shape, and only that', () => {
    const tick = serializeLogbookTick(BASE_TICK, metadataFor(BASE_TICK, {}, 18.6));
    expect(TickSchema.parse(tick)).toEqual(tick);
    expect(tick).toEqual({
      id: BASE_TICK.uuid,
      climbedAt: '2026-10-20T18:42:11.123Z',
      status: 'send',
      attempts: 3,
      angle: 40,
      mirrored: false,
      stars: 4,
      grade: { v: 4, font: '6B+', label: '6b+/V4' },
      benchmark: true,
      comment: 'Finally stuck the cross-through',
      climb: {
        id: 'climb-canonical',
        name: 'Slopey Business',
        board: { type: 'kilter', layout: 'Kilter Board Original' },
        grade: { v: 4, font: '6B+', label: '6b+/V4' },
        // No documented conversion to the V scale yet, so none is sent.
        boardseshGrade: null,
      },
      createdAt: '2026-10-20T18:42:15.000Z',
      updatedAt: '2026-10-20T18:42:15.000Z',
    });
  });

  it('sends null for a missing grade, star rating and note, and the board name when the climb row is missing', () => {
    const bare = { ...BASE_TICK, quality: null, difficulty: null, comment: '', isMirror: null, isBenchmark: null };
    const tick = serializeLogbookTick(bare, metadataFor(bare, null));
    expect(tick).toMatchObject({
      stars: null,
      grade: null,
      comment: null,
      mirrored: false,
      benchmark: false,
      climb: { name: null, board: { type: 'kilter', layout: 'Kilter' }, grade: null, boardseshGrade: null },
    });
  });

  it('never sends a star rating outside 1 to 5', () => {
    for (const quality of [0, 6, -1]) {
      const tick = { ...BASE_TICK, quality };
      expect(serializeLogbookTick(tick, metadataFor(tick, {})).stars).toBeNull();
    }
  });

  it("withholds the names of a climb on someone else's wall that is not public", () => {
    const spray = { ...BASE_TICK, boardType: 'spray' };
    const tick = serializeLogbookTick(
      spray,
      metadataFor(spray, { name: 'Couch traverse', layoutName: "Sam's garage", namesVisible: false }),
    );
    expect(tick.climb).toMatchObject({ name: null, board: { type: 'spray', layout: WITHHELD_LAYOUT_NAME } });
    expect(JSON.stringify(tick)).not.toContain('Couch traverse');
    expect(JSON.stringify(tick)).not.toContain('garage');
  });

  it('withholds both names for a spray tick whose climb row is gone, since no wall is left to check', () => {
    const spray = { ...BASE_TICK, boardType: 'spray' };
    expect(serializeLogbookTick(spray, metadataFor(spray, null)).climb).toMatchObject({
      name: null,
      board: { layout: WITHHELD_LAYOUT_NAME },
    });
  });

  it('shows the names of a wall the climber may share', () => {
    const spray = { ...BASE_TICK, boardType: 'spray' };
    const tick = serializeLogbookTick(spray, metadataFor(spray, { name: 'Couch traverse', layoutName: 'Home wall' }));
    expect(tick.climb).toMatchObject({ name: 'Couch traverse', board: { type: 'spray', layout: 'Home wall' } });
  });

  it('refuses to serve a tick the contract cannot describe rather than send something else', () => {
    const unknownBoard = { ...BASE_TICK, boardType: 'unreleased-board' };
    expect(() => serializeLogbookTick(unknownBoard, metadataFor(unknownBoard, {}))).toThrow();
  });
});

describe('grades', () => {
  it.each([
    ['kilter', 19, { v: 4, font: '6B+', label: '6b+/V4' }],
    ['kilter', 16, { v: 3, font: '6A', label: '6a/V3' }],
    // MoonBoard's own conversion: its 6A is V2.
    ['moonboard', 16, { v: 2, font: '6A', label: '6a/V2' }],
    ['tension', 18.6, { v: 4, font: '6B+', label: '6b+/V4' }],
    ['kilter', 9, null],
    ['kilter', 34, null],
    ['kilter', null, null],
  ])('reads %s difficulty %s', (boardType, difficulty, expected) => {
    expect(logbookGrade(boardType, difficulty)).toEqual(expected);
  });

  it('reads stored timestamps as UTC', () => {
    expect(utcTimestamp('2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05.000Z');
    expect(() => utcTimestamp('yesterday')).toThrow(RangeError);
  });
});

describe('the snapshot admission gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const limits = { permits: 2, buildPermits: 1, queueLimit: 2, queueDeadlineMs: 1000 };

  it('lets one build run at a time and never queues one', () => {
    const gate = createLogbookSnapshotAdmission(limits);
    const build = gate.tryBuild();
    expect(build).not.toBeNull();
    expect(gate.tryBuild()).toBeNull();
    build?.release();
    expect(gate.tryBuild()).not.toBeNull();
  });

  it('keeps a permit for reads while a build runs, and none for a build while reads fill the pool', async () => {
    const gate = createLogbookSnapshotAdmission(limits);
    gate.tryBuild();
    expect(await gate.acquireRead()).not.toBeNull();

    const reads = createLogbookSnapshotAdmission(limits);
    await reads.acquireRead();
    await reads.acquireRead();
    expect(reads.tryBuild()).toBeNull();
  });

  it('queues reads up to the limit, hands a released permit to the oldest, and gives up at the deadline', async () => {
    vi.useFakeTimers();
    const gate = createLogbookSnapshotAdmission(limits);
    const first = await gate.acquireRead();
    await gate.acquireRead();
    const waitingFirst = gate.acquireRead();
    const waitingSecond = gate.acquireRead();
    expect(await gate.acquireRead()).toBeNull();

    first?.release();
    expect(await waitingFirst).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(await waitingSecond).toBeNull();
  });
});
