// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { SPRAY_ANGLES } from '@boardsesh/board-config';
import {
  DEFAULT_SPRAY_ANGLE,
  SPRAY_ANGLE_OPTIONS,
  isValidSprayAngle,
  useSprayWallBuilder,
} from '../use-spray-wall-builder';

describe('the angles a wall may be built at', () => {
  it('offers the shared list, not a range of its own', () => {
    // The server validates against SPRAY_ANGLES. A client that accepted every
    // integer in between would let a climber type 37, walk the whole photo and
    // corner flow, and only meet the refusal at the upload — with the wall
    // already created.
    expect(SPRAY_ANGLE_OPTIONS).toEqual([...SPRAY_ANGLES]);
  });

  it('accepts every angle on that list', () => {
    for (const angle of SPRAY_ANGLE_OPTIONS) expect(isValidSprayAngle(angle)).toBe(true);
  });

  it('refuses a plausible angle that is not on it', () => {
    expect(isValidSprayAngle(37)).toBe(false);
    expect(isValidSprayAngle(42)).toBe(false);
    expect(isValidSprayAngle(71)).toBe(false);
    expect(isValidSprayAngle(-5)).toBe(false);
    expect(isValidSprayAngle(12.5)).toBe(false);
  });

  it('opens on an angle the server accepts', () => {
    expect(isValidSprayAngle(DEFAULT_SPRAY_ANGLE)).toBe(true);
  });
});

describe('useSprayWallBuilder', () => {
  it('hands back a stable object across renders', () => {
    // The screen puts `builder` in `useCallback` dep arrays, so a fresh literal
    // per render would rebuild those callbacks on every commit — including every
    // upload-progress tick. CLAUDE.md's mobile performance checklist asks for
    // this of any hook whose return value lands in a dep array.
    const { result, rerender } = renderHook(() => useSprayWallBuilder());
    const first = result.current;
    rerender({});
    expect(result.current).toBe(first);
  });

  it('hands back a NEW object when something it holds changes', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    const first = result.current;
    act(() => result.current.setName('Garage wall'));
    expect(result.current).not.toBe(first);
    expect(result.current.name).toBe('Garage wall');
  });

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

  it('cannot create at an angle the server would refuse', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    act(() => result.current.setAngle(37));
    expect(result.current.canCreate).toBe(false);
    expect(result.current.buildCreateInput()).toBeNull();
  });

  it('ignores a seeded angle that is not on the list', () => {
    const { result } = renderHook(() => useSprayWallBuilder({ angle: 37 }));
    expect(result.current.angle).toBe(DEFAULT_SPRAY_ANGLE);
  });

  it('builds the create input, trimming the name and dropping an empty location', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('  Garage wall  '));
    act(() => result.current.setAngle(25));

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

  it('creates the wall PRIVATE even when the climber chose public', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    act(() => result.current.setIsPublic(true));

    // The row exists before any version, photo or hold, and `searchBoards`
    // filters on is_public / is_unlisted alone — so a wall created public is a
    // listed, unusable board for as long as the flow takes, and forever if it is
    // abandoned.
    expect(result.current.buildCreateInput()).toMatchObject({ isPublic: false, isUnlisted: false });
    // …and the choice is remembered, to be applied once there is something to see.
    expect(result.current.pendingVisibility()).toEqual({ isPublic: true, isUnlisted: false });
  });

  it('has no second write to make for a wall left private', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    expect(result.current.pendingVisibility()).toBeNull();
  });

  it('remembers an unlisted choice too', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setIsUnlisted(true));
    expect(result.current.pendingVisibility()).toEqual({ isPublic: false, isUnlisted: true });
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
