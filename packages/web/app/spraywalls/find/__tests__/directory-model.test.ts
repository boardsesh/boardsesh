import { describe, expect, it } from 'vite-plus/test';
import {
  buildSprayDirectoryHref,
  parseSprayDirectoryQuery,
  sprayDirectoryInput,
  sprayDirectoryPins,
} from '../directory-model';

describe('public spray directory queries', () => {
  it('locks searches to spray and ignores catalogue-only filters', () => {
    const query = parseSprayDirectoryQuery({
      q: '  Garage ',
      boardType: 'kilter',
      layout: '1',
      size: '2',
      angle: ['40', '30', '40', '99', '', 'oops'],
      page: '2',
    });
    expect(sprayDirectoryInput(query)).toEqual({
      boardType: 'spray',
      query: 'Garage',
      angles: [30, 40],
      limit: 24,
      offset: 24,
    });
    expect(buildSprayDirectoryHref(query, 2)).toBe('/spraywalls/find?q=Garage&angle=30&angle=40&page=2');
  });

  it('preserves a selected town, rounds coordinates and applies the default radius', () => {
    const query = parseSprayDirectoryQuery({ place: 'Amsterdam', lat: '52.36764', lng: '4.90414' });
    expect(sprayDirectoryInput(query)).toEqual({
      boardType: 'spray',
      latitude: 52.368,
      longitude: 4.904,
      radiusKm: 25,
      limit: 24,
      offset: 0,
    });
    expect(buildSprayDirectoryHref(query)).toContain('place=Amsterdam&lat=52.368&lng=4.904&radius=25');
  });

  it('drops invalid origins and preserves an excessive page for the route to reject', () => {
    const query = parseSprayDirectoryQuery({ lat: '91', lng: '4', place: 'Hidden', page: '999' });
    expect(query).toMatchObject({ latitude: null, longitude: null, place: undefined, page: 999 });
    expect(sprayDirectoryInput(query)).not.toHaveProperty('latitude');
  });

  it('makes pins only from returned public coordinates and links to the wall', () => {
    const wall = {
      uuid: 'wall',
      slug: 'crew-wall',
      name: 'Crew wall',
      angle: 40,
      locationName: null,
      gymName: null,
      latitude: null,
      longitude: null,
      distanceMeters: null,
    };
    expect(sprayDirectoryPins([wall])).toEqual([]);
    expect(sprayDirectoryPins([{ ...wall, latitude: 52, longitude: 4 }])[0]).toMatchObject({
      href: '/b/crew-wall',
      latitude: 52,
      longitude: 4,
    });
  });
});
