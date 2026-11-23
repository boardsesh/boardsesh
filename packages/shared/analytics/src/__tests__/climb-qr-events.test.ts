import { describe, it, expect } from 'vitest';
import {
  CLIMB_QR_MEDIUMS,
  climbQrScanned,
  listQrScanned,
  parseClimbQrLanding,
  playlistQrScanned,
  homeQrScanned,
  setterQrScanned,
} from '../climb-qr-events';
import { BOARD_QR_MEDIUMS, parseBoardQrLanding } from '../board-qr-events';
import { SHARED_EVENTS } from '../events';
import { GYM_QR_MEDIUMS, buildGymQrHref, parseGymQrLanding } from '../gym-funnel';

describe('climbQrScanned', () => {
  it('pairs the shared name with the medium, the surface and the board type', () => {
    expect(climbQrScanned({ medium: 'desktop', surface: 'web', boardType: 'kilter' })).toEqual({
      name: SHARED_EVENTS.ClimbQrScanned,
      properties: { medium: 'desktop', surface: 'web', boardType: 'kilter' },
    });
    expect(SHARED_EVENTS.ClimbQrScanned).toBe('Climb QR Scanned');
  });

  it('sends a null board type for anything outside the nine', () => {
    expect(climbQrScanned({ medium: 'desktop', surface: 'web', boardType: 'my-garage-board' }).properties).toEqual({
      medium: 'desktop',
      surface: 'web',
      boardType: null,
    });
  });

  it('carries exactly three properties, so nothing naming the climb can ride along', () => {
    const { properties } = climbQrScanned({ medium: 'desktop', surface: 'app', boardType: 'tension' });

    expect(Object.keys(properties).sort()).toEqual(['boardType', 'medium', 'surface']);
  });
});

describe('listQrScanned', () => {
  it('names the board list scan apart from the climb page scan, with the same three properties', () => {
    expect(listQrScanned({ medium: 'desktop', surface: 'web', boardType: 'kilter' })).toEqual({
      name: SHARED_EVENTS.ListQrScanned,
      properties: { medium: 'desktop', surface: 'web', boardType: 'kilter' },
    });
    expect(SHARED_EVENTS.ListQrScanned).toBe('List QR Scanned');
    expect(SHARED_EVENTS.ListQrScanned).not.toBe(SHARED_EVENTS.ClimbQrScanned);
  });

  it('carries nothing that names the board', () => {
    const { properties } = listQrScanned({ medium: 'desktop', surface: 'web', boardType: 'my-garage-board' });

    expect(properties).toEqual({ medium: 'desktop', surface: 'web', boardType: null });
  });

  it('parses what the board list encodes', () => {
    const href = buildGymQrHref('/kilter/original/12x12-square/screw_bolt/40/list', 'desktop');
    const params = Object.fromEntries(new URL(href, 'https://www.boardsesh.com').searchParams);

    expect(parseClimbQrLanding(params)).toEqual({ medium: 'desktop' });
  });
});

describe.each([
  ['setterQrScanned', setterQrScanned, SHARED_EVENTS.SetterQrScanned, 'Setter QR Scanned', '/setter/jimmy%20webb'],
  ['playlistQrScanned', playlistQrScanned, SHARED_EVENTS.PlaylistQrScanned, 'Playlist QR Scanned', '/playlists/abc'],
  ['homeQrScanned', homeQrScanned, SHARED_EVENTS.HomeQrScanned, 'Home QR Scanned', '/'],
] as const)('%s', (_builderName, build, eventName, expectedName, pagePath) => {
  it('names its own page apart from every other desktop code, with the same three properties', () => {
    expect(build({ medium: 'desktop', surface: 'web', boardType: 'kilter' })).toEqual({
      name: eventName,
      properties: { medium: 'desktop', surface: 'web', boardType: 'kilter' },
    });
    expect(eventName).toBe(expectedName);
    expect([SHARED_EVENTS.ClimbQrScanned, SHARED_EVENTS.ListQrScanned]).not.toContain(eventName);
  });

  it('carries nothing that names the page', () => {
    const { properties } = build({ medium: 'desktop', surface: 'web', boardType: 'my-garage-board' });

    expect(properties).toEqual({ medium: 'desktop', surface: 'web', boardType: null });
  });

  it('parses what the page encodes', () => {
    const href = buildGymQrHref(pagePath, 'desktop');
    const params = Object.fromEntries(new URL(href, 'https://www.boardsesh.com').searchParams);

    expect(parseClimbQrLanding(params)).toEqual({ medium: 'desktop' });
  });
});

describe('parseClimbQrLanding', () => {
  it('accepts the desktop code a climb page shows', () => {
    expect(parseClimbQrLanding({ src: 'qr', medium: 'desktop' })).toEqual({ medium: 'desktop' });
  });

  it.each(['poster', 'kiosk', 'board'])('refuses the %s medium, which no climb page prints', (medium) => {
    expect(parseGymQrLanding({ src: 'qr', medium })).not.toBeNull();
    expect(parseClimbQrLanding({ src: 'qr', medium })).toBeNull();
  });

  it("keeps the strict parser's refusals", () => {
    expect(parseClimbQrLanding({})).toBeNull();
    expect(parseClimbQrLanding({ src: 'QR', medium: 'desktop' })).toBeNull();
    expect(parseClimbQrLanding({ src: 'qr', medium: ['desktop', 'desktop'] })).toBeNull();
    expect(parseClimbQrLanding({ src: 'qr', medium: 'Desktop' })).toBeNull();
  });

  it('is a subset of the gym vocabulary, and a board landing refuses it', () => {
    for (const medium of CLIMB_QR_MEDIUMS) {
      expect(GYM_QR_MEDIUMS).toContain(medium);
      expect(BOARD_QR_MEDIUMS as readonly string[]).not.toContain(medium);
      expect(parseBoardQrLanding({ src: 'qr', medium })).toBeNull();
    }
  });

  it('parses what the climb page encodes', () => {
    const href = buildGymQrHref('/b/my-board/40/view/abc-the-climb', 'desktop');
    const params = Object.fromEntries(new URL(href, 'https://www.boardsesh.com').searchParams);

    expect(parseClimbQrLanding(params)).toEqual({ medium: 'desktop' });
  });
});
