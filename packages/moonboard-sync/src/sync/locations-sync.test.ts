import { describe, expect, it } from 'vitest';
import { buildMoonBoardLocationRecords } from './locations-sync';

describe('buildMoonBoardLocationRecords', () => {
  it('creates all supported MoonBoard layout and angle boards per marker', () => {
    const records = buildMoonBoardLocationRecords([
      {
        Name: 'Board House',
        Description: '<p>Ask staff for the key.</p>',
        Image: null,
        Latitude: -33.86,
        Longitude: 151.2,
        IsCommercial: true,
        IsLed: true,
        LatLng: [-33.86, 151.2],
      },
    ]);

    expect(records).toHaveLength(14);
    expect(records.map((record) => `${record.layoutId}:${record.angle}`)).toContain('2:25');
    expect(records.map((record) => `${record.layoutId}:${record.angle}`)).toContain('2:40');
    expect(records.map((record) => `${record.layoutId}:${record.angle}`)).toContain('7:40');
    expect(records.find((record) => record.layoutId === 2 && record.angle === 40)?.sourceKey).toBe(
      'moonboard:Board House:-33.86:151.2',
    );
    expect(records.find((record) => record.layoutId === 2 && record.angle === 25)?.sourceKey).toBe(
      'moonboard:Board House:-33.86:151.2:2:25',
    );
    expect(records.every((record) => record.gymAddress === null)).toBe(true);
  });

  it('falls back to LatLng when scalar coordinates are missing', () => {
    const records = buildMoonBoardLocationRecords([
      {
        Name: 'LatLng Board',
        Description: null,
        Latitude: null,
        Longitude: null,
        LatLng: [10.5, 20.25],
      },
    ]);

    expect(records.find((record) => record.layoutId === 2 && record.angle === 40)).toMatchObject({
      sourceKey: 'moonboard:LatLng Board:10.5:20.25',
      latitude: 10.5,
      longitude: 20.25,
    });
  });
});
