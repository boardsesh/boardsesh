import { describe, it, expect } from 'vitest';
import {
  gymCreated,
  gymFinderAddMyGymTapped,
  gymFinderGymPicked,
  gymFinderLocateTapped,
  gymFinderSearchUsed,
} from '../gym-finder-events';
import * as analytics from '../index';

describe('gym finder events', () => {
  it('pairs a gym pick with its own name and the section it came from', () => {
    expect(gymFinderGymPicked({ surface: 'wizard_gym_step', section: 'map_pin' })).toEqual({
      name: 'Gym Finder Gym Picked',
      properties: { surface: 'wizard_gym_step', section: 'map_pin' },
    });
    expect(gymFinderGymPicked({ surface: 'gyms_map', section: 'list' }).properties).toEqual({
      surface: 'gyms_map',
      section: 'list',
    });
  });

  it('sends Add my gym and Locate with only the surface', () => {
    expect(gymFinderAddMyGymTapped('wizard_gym_step')).toEqual({
      name: 'Gym Finder Add My Gym Tapped',
      properties: { surface: 'wizard_gym_step' },
    });
    expect(gymFinderLocateTapped('gyms_map')).toEqual({
      name: 'Gym Finder Locate Tapped',
      properties: { surface: 'gyms_map' },
    });
  });

  it('says which kind of search ran, never what was typed', () => {
    const payload = gymFinderSearchUsed({ surface: 'gyms_map', kind: 'town' });
    expect(payload).toEqual({ name: 'Gym Finder Search Used', properties: { surface: 'gyms_map', kind: 'town' } });
    expect(Object.keys(payload.properties).sort()).toEqual(['kind', 'surface']);
  });

  it('is exported from the package index', () => {
    expect(analytics.gymFinderGymPicked).toBe(gymFinderGymPicked);
    expect(analytics.gymFinderAddMyGymTapped).toBe(gymFinderAddMyGymTapped);
    expect(analytics.gymFinderSearchUsed).toBe(gymFinderSearchUsed);
    expect(analytics.gymFinderLocateTapped).toBe(gymFinderLocateTapped);
    expect(analytics.SHARED_EVENTS.GymFinderLocateTapped).toBe('Gym Finder Locate Tapped');
    expect(analytics.gymCreated).toBe(gymCreated);
  });

  it('sends Gym Created with counts and flags only', () => {
    const payload = gymCreated({
      surface: 'wizard',
      similarShown: 2,
      confirmedSeparate: true,
      hasAddress: false,
      locationSource: 'map',
    });
    expect(payload.name).toBe('Gym Created');
    expect(Object.keys(payload.properties).sort()).toEqual([
      'confirmedSeparate',
      'hasAddress',
      'locationSource',
      'similarShown',
      'surface',
    ]);
  });
});
