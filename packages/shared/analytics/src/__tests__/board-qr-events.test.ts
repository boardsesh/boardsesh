import { describe, it, expect } from 'vitest';
import { BOARD_QR_MEDIUMS, boardQrScanned, parseBoardQrLanding } from '../board-qr-events';
import { SHARED_EVENTS } from '../events';
import { GYM_QR_MEDIUMS, parseGymQrLanding } from '../gym-funnel';

/**
 * Shape tests for `Board QR Scanned`. The rule that nothing identifies the board
 * is checked with the spray payloads in `spray-wall-events.test.ts`, which reads
 * this builder's output back field by field next to theirs.
 */
describe('boardQrScanned', () => {
  it('pairs the shared name with the medium, the surface and the board type', () => {
    expect(boardQrScanned({ medium: 'board', surface: 'web', boardType: 'spray' })).toEqual({
      name: SHARED_EVENTS.BoardQrScanned,
      properties: { medium: 'board', surface: 'web', boardType: 'spray' },
    });
    expect(SHARED_EVENTS.BoardQrScanned).toBe('Board QR Scanned');
  });

  it.each(BOARD_QR_MEDIUMS)('carries the %s medium through unchanged', (medium) => {
    expect(boardQrScanned({ medium, surface: 'app', boardType: 'kilter' }).properties.medium).toBe(medium);
  });

  it('tells the www landing from the app one', () => {
    expect(boardQrScanned({ medium: 'kiosk', surface: 'web', boardType: 'kilter' }).properties.surface).toBe('web');
    expect(boardQrScanned({ medium: 'kiosk', surface: 'app', boardType: 'kilter' }).properties.surface).toBe('app');
  });

  // A Spraywall's slug is made from its name, and its uuid opens an unlisted one.
  // Either passed as the board type by mistake must arrive as null, not as a value.
  it.each(['garage-wall', 'Garage Wall', 'ab12cd34ef56ab12cd34ef56ab12cd34', null, undefined])(
    'sends a null board type for %s',
    (notABoardType) => {
      expect(boardQrScanned({ medium: 'board', surface: 'web', boardType: notABoardType }).properties).toEqual({
        medium: 'board',
        surface: 'web',
        boardType: null,
      });
    },
  );

  it('carries exactly three properties, so nothing else can ride along', () => {
    const { properties } = boardQrScanned({ medium: 'board', surface: 'web', boardType: 'tension' });

    expect(Object.keys(properties).sort()).toEqual(['boardType', 'medium', 'surface']);
  });
});

describe('parseBoardQrLanding', () => {
  it.each(BOARD_QR_MEDIUMS)('accepts a %s scan, the two mediums a board code prints', (medium) => {
    expect(parseBoardQrLanding({ src: 'qr', medium })).toEqual({ medium });
  });

  it('refuses the gym poster medium, which no board code prints', () => {
    // The gym parser still accepts it: only the board landing narrows.
    expect(parseGymQrLanding({ src: 'qr', medium: 'poster' })).toEqual({ medium: 'poster' });
    expect(parseBoardQrLanding({ src: 'qr', medium: 'poster' })).toBeNull();
  });

  it("keeps the strict parser's refusals", () => {
    expect(parseBoardQrLanding({})).toBeNull();
    expect(parseBoardQrLanding({ src: 'QR', medium: 'board' })).toBeNull();
    expect(parseBoardQrLanding({ src: 'qr', medium: ['board', 'kiosk'] })).toBeNull();
    expect(parseBoardQrLanding({ src: 'qr', medium: 'flyer' })).toBeNull();
  });

  it('is a subset of the gym vocabulary, so a board code always parses with the shared parser', () => {
    for (const medium of BOARD_QR_MEDIUMS) expect(GYM_QR_MEDIUMS).toContain(medium);
  });
});
