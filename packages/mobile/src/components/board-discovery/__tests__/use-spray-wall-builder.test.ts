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

  it('starts link-only and location-hidden', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    expect(result.current.isPublic).toBe(false);
    expect(result.current.isUnlisted).toBe(true);
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
      isUnlisted: true,
      hideLocation: true,
      locationName: undefined,
      latitude: undefined,
      longitude: undefined,
      gymUuid: undefined,
    });
  });

  it('sends the chosen visibility with the create, so the server holds it (#5513)', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    act(() => result.current.setIsPublic(true));
    act(() => result.current.setIsUnlisted(false));

    // `createSprayWall` keeps the board private until the first publish and
    // applies this then — which is what lets a wall resumed on a later launch,
    // with a fresh builder, still publish public. Forcing false here lost the
    // choice whenever the app closed mid-wizard.
    expect(result.current.buildCreateInput()).toMatchObject({ isPublic: true, isUnlisted: false });
    // The post-publish write stays, for a backend that predates that.
    expect(result.current.pendingVisibility()).toEqual({ isPublic: true, isUnlisted: false });
  });

  it('has no second write to make for a wall left private', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    act(() => result.current.setIsUnlisted(false));
    expect(result.current.pendingVisibility()).toBeNull();
  });

  it('sends link-only sharing by default through creation and publication', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.setName('Garage wall'));
    expect(result.current.buildCreateInput()).toMatchObject({ isPublic: false, isUnlisted: true });
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

describe('useSprayWallBuilder — the details step', () => {
  const SERVER_WALL = {
    name: 'Garage wall',
    angle: 35,
    isPublic: false,
    isUnlisted: false,
    hideLocation: true,
    locationName: '',
    coords: null,
    gym: null,
  };

  it('names the wall with the default until somebody types, even when the default arrives late', () => {
    const { result, rerender } = renderHook(({ defaultName }) => useSprayWallBuilder(null, { defaultName }), {
      initialProps: { defaultName: 'My spray wall' },
    });
    expect(result.current.name).toBe('My spray wall');
    expect(result.current.canCreate).toBe(true);
    expect(result.current.buildCreateInput()).toMatchObject({ name: 'My spray wall', angle: 40, isPublic: false });

    // The profile query lands: the default follows it.
    rerender({ defaultName: "Marco's Spray wall" });
    expect(result.current.name).toBe("Marco's Spray wall");

    // Typed, it is the climber's, whatever the default does next.
    act(() => result.current.setName('Cave'));
    rerender({ defaultName: 'Something else' });
    expect(result.current.name).toBe('Cave');
  });

  it('has nothing to send right after hydrating from the server', () => {
    const { result } = renderHook(() => useSprayWallBuilder(null, { defaultName: 'My spray wall' }));
    act(() => result.current.hydrate(SERVER_WALL));
    expect(result.current.name).toBe('Garage wall');
    expect(result.current.angle).toBe(35);
    expect(result.current.buildDetailsUpdate()).toBeNull();
  });

  it('sends only what changed', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.hydrate(SERVER_WALL));
    act(() => result.current.setName('  The Cave  '));
    expect(result.current.buildDetailsUpdate()).toEqual({ name: 'The Cave' });

    act(() => result.current.setAngle(45));
    expect(result.current.buildDetailsUpdate()).toEqual({ name: 'The Cave', angle: 45 });
  });

  it('sends the visibility as a pair, since it is one three-way choice', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.hydrate(SERVER_WALL));
    act(() => result.current.setIsUnlisted(true));
    expect(result.current.buildDetailsUpdate()).toEqual({ isPublic: false, isUnlisted: true });
  });

  it('sends the gym with the location it fills in, so the server can check the gym is nearby', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.hydrate(SERVER_WALL));
    act(() => result.current.setSelectedGym({ uuid: 'gym-1', name: 'The Castle', latitude: 51.5, longitude: -0.1 }));
    expect(result.current.buildDetailsUpdate()).toEqual({
      gymUuid: 'gym-1',
      locationName: 'The Castle',
      latitude: 51.5,
      longitude: -0.1,
    });
  });

  it('detaches a gym and clears a point with nulls', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() =>
      result.current.hydrate({
        ...SERVER_WALL,
        gym: { uuid: 'gym-1', name: 'The Castle' },
        coords: { latitude: 51.5, longitude: -0.1 },
        locationName: 'The Castle',
      }),
    );
    act(() => result.current.setSelectedGym(null));
    act(() => result.current.setCoords(null));
    expect(result.current.buildDetailsUpdate()).toEqual({ gymUuid: null, latitude: null, longitude: null });
  });

  it('keeps its own value, as the baseline, for a field the seed leaves out', () => {
    const { result } = renderHook(() => useSprayWallBuilder(null, { defaultName: 'My spray wall' }));
    // The create response carries no location fields; what was sent is what the server holds.
    act(() => result.current.hydrate({ name: 'My spray wall', angle: 40, isPublic: false, isUnlisted: false }));
    expect(result.current.hideLocation).toBe(true);
    expect(result.current.buildDetailsUpdate()).toBeNull();
  });

  // After a save the screen hydrates from the server's ANSWER, which a policy
  // can clamp: the builder then shows and diffs from what the server holds.
  it('follows a clamped answer rather than what was sent', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.hydrate(SERVER_WALL));
    act(() => result.current.setIsPublic(true));
    expect(result.current.buildDetailsUpdate()).toEqual({ isPublic: true, isUnlisted: false });
    act(() => result.current.hydrate({ ...SERVER_WALL, isPublic: false, isUnlisted: false }));
    expect(result.current.isPublic).toBe(false);
    expect(result.current.buildDetailsUpdate()).toBeNull();
    expect(result.current.pendingVisibility()).toBeNull();
  });

  it('keeps hydrate stable, so callbacks built on it are too', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    const { hydrate } = result.current;
    act(() => result.current.setName('The Cave'));
    expect(result.current.hydrate).toBe(hydrate);
  });

  it('shows a legal angle for one the server would refuse, and Save writes it', () => {
    const { result } = renderHook(() => useSprayWallBuilder());
    act(() => result.current.hydrate({ ...SERVER_WALL, angle: 37 }));
    expect(result.current.angle).toBe(DEFAULT_SPRAY_ANGLE);
    // 37 is what the wall holds, so the angle on screen is a change.
    expect(result.current.buildDetailsUpdate()).toEqual({ angle: DEFAULT_SPRAY_ANGLE });
  });
});
