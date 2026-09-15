// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DEFAULT_SPRAY_ANGLE,
  isValidSprayAngle,
  parseSprayAngle,
  useSprayWallBuilder,
} from '../use-spray-wall-builder';

describe('parseSprayAngle', () => {
  it('reads a plain angle', () => {
    expect(parseSprayAngle('40')).toBe(40);
    expect(parseSprayAngle(' 25 ')).toBe(25);
    expect(parseSprayAngle('0')).toBe(0);
  });

  it('refuses anything that is not an angle a wall can be built at', () => {
    // No clamping: the angle is frozen at the first publish, so a wall created
    // at an angle nobody chose is permanent.
    expect(parseSprayAngle('')).toBeNull();
    expect(parseSprayAngle('-10')).toBeNull();
    expect(parseSprayAngle('71')).toBeNull();
    expect(parseSprayAngle('45.5')).toBeNull();
    expect(parseSprayAngle('steep')).toBeNull();
  });

  it('agrees with isValidSprayAngle', () => {
    expect(isValidSprayAngle(70)).toBe(true);
    expect(isValidSprayAngle(71)).toBe(false);
    expect(isValidSprayAngle(12.5)).toBe(false);
  });
});

describe('useSprayWallBuilder', () => {
  it('starts private, unlisted-off and location-hidden — a wall is somebody home', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    expect(result.current.isPublic).toBe(false);
    expect(result.current.isUnlisted).toBe(false);
    expect(result.current.hideLocation).toBe(true);
    expect(result.current.angle).toBe(DEFAULT_SPRAY_ANGLE);
  });

  it('cannot create without a name', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    expect(result.current.canCreate).toBe(false);
    expect(result.current.buildCreateInput()).toBeNull();

    act(() => result.current.setName('   '));
    expect(result.current.canCreate).toBe(false);
  });

  it('cannot create with an angle it could not read', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    act(() => result.current.setAngleText('99'));
    expect(result.current.canCreate).toBe(false);
    expect(result.current.buildCreateInput()).toBeNull();
  });

  it('builds the create input, trimming the name and dropping an empty location', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('  Garage wall  '));
    act(() => result.current.setAngleText('25'));

    expect(result.current.buildCreateInput()).toEqual({
      name: 'Garage wall',
      angle: 25,
      isPublic: false,
      isUnlisted: false,
      hideLocation: true,
      locationName: undefined,
      latitude: undefined,
      longitude: undefined,
      gymUuid: undefined,
    });
  });

  it('never offers the two fields the resolver owns', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    const input = result.current.buildCreateInput();
    // `has_leds` and `is_angle_adjustable` are written false by the server and
    // are not in the input schema at all: a wall has no controller to talk to.
    expect(input).not.toHaveProperty('hasLeds');
    expect(input).not.toHaveProperty('isAngleAdjustable');
  });

  it('stamps the gym coordinates and back-fills the location name', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setSelectedGym({ uuid: 'gym-1', name: 'The Castle', latitude: 51.5, longitude: -0.1 }));
    expect(result.current.coords).toEqual({ latitude: 51.5, longitude: -0.1 });
    expect(result.current.locationName).toBe('The Castle');
  });

  it('leaves a hand-typed location alone when the gym changes', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setLocationName('My garage'));
    act(() => result.current.setSelectedGym({ uuid: 'gym-1', name: 'The Castle' }));
    expect(result.current.locationName).toBe('My garage');
  });

  it('drops stale coordinates when the new gym has none', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setSelectedGym({ uuid: 'gym-1', name: 'The Castle', latitude: 51.5, longitude: -0.1 }));
    act(() => result.current.setSelectedGym({ uuid: 'gym-2', name: 'The Arch' }));
    // A gym with no coordinates cannot vouch for the previous one's, and a stale
    // pair would aim the server's proximity check at the wrong place.
    expect(result.current.coords).toBeNull();
  });
});
