import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsChange } from '../../settings/hooks';
import { canMoveSection, sanitiseSectionLayout, withSectionMoved } from '../section-layout';

const settings = vi.hoisted(() => ({
  listeners: new Set<(change: SettingsChange) => void>(),
  values: new Map<string, unknown>(),
  writes: [] as unknown[],
}));
vi.mock('../../settings/hooks', () => ({
  subscribeSettings: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => settings.listeners.delete(listener);
  },
  getSetting: (key: string) => settings.values.get(key) ?? null,
  setSetting: (key: string, value: unknown) => {
    settings.writes.push(value);
    settings.values.set(key, value);
    for (const listener of settings.listeners) listener({ kind: 'setting', key: key as never });
  },
}));

async function loadHomeSections() {
  vi.resetModules();
  return import('../home-sections');
}

beforeEach(() => {
  settings.listeners.clear();
  settings.values.clear();
  settings.writes = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Home sections', () => {
  it('defaults to This week, Session, Climbing now, Back to your projects, At your level, then the feed, with Your board and Fresh beta hidden', async () => {
    const { HOME_SECTIONS, homeSectionsStore, visibleTopHomeSections } = await loadHomeSections();
    expect(HOME_SECTIONS.defaults.order).toEqual([
      'week',
      'session',
      'climbingNow',
      'projects',
      'playlists',
      'board',
      'beta',
      'feed',
    ]);
    expect(HOME_SECTIONS.defaults.visible).toEqual({
      week: true,
      session: true,
      climbingNow: true,
      projects: true,
      playlists: true,
      board: false,
      beta: false,
      feed: true,
    });
    expect(homeSectionsStore.getLayout()).toEqual(HOME_SECTIONS.defaults);
    expect(visibleTopHomeSections(homeSectionsStore.getLayout())).toEqual([
      'week',
      'session',
      'climbingNow',
      'projects',
      'playlists',
    ]);
  });

  it('keeps the feed last: it never moves, and nothing moves below it', async () => {
    const { HOME_SECTIONS } = await loadHomeSections();
    const layout = HOME_SECTIONS.defaults;
    expect(canMoveSection(HOME_SECTIONS, layout, 'feed', -1)).toBe(false);
    expect(canMoveSection(HOME_SECTIONS, layout, 'beta', 1)).toBe(false);
    expect(withSectionMoved(HOME_SECTIONS, layout, 'beta', 1)).toBe(layout);
    // A stored order with the feed in the middle still reads it last.
    expect(sanitiseSectionLayout(HOME_SECTIONS, { order: ['feed', 'board'], visible: {} }).order).toEqual([
      'week',
      'session',
      'climbingNow',
      'projects',
      'playlists',
      'board',
      'beta',
      'feed',
    ]);
  });

  it('Focused shows your week, Session, Back to your projects, At your level and Your board, hides the feed and Climbing now, and keeps the order', async () => {
    const { HOME_SECTIONS, focusedHomeLayout, isFocusedHomeLayout, visibleTopHomeSections } = await loadHomeSections();
    const reordered = withSectionMoved(HOME_SECTIONS, HOME_SECTIONS.defaults, 'playlists', -1);
    const focused = focusedHomeLayout(reordered);
    expect(focused.order).toEqual(['week', 'session', 'climbingNow', 'playlists', 'projects', 'board', 'beta', 'feed']);
    expect(visibleTopHomeSections(focused)).toEqual(['week', 'session', 'playlists', 'projects', 'board']);
    expect(focused.visible.feed).toBe(false);
    expect(isFocusedHomeLayout(focused)).toBe(true);
    expect(isFocusedHomeLayout(HOME_SECTIONS.defaults)).toBe(false);
  });

  it('stores edits under homeSectionsV1, and Restore defaults stores nothing', async () => {
    const { homeSectionsStore, isDefaultHomeLayout, focusedHomeLayout } = await loadHomeSections();
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
    expect(settings.values.get('homeSectionsV1')).toEqual({
      version: 1,
      order: ['week', 'session', 'climbingNow', 'projects', 'playlists', 'board', 'beta', 'feed'],
      visible: {
        week: true,
        board: true,
        session: true,
        projects: true,
        playlists: true,
        climbingNow: false,
        beta: false,
        feed: false,
      },
    });
    homeSectionsStore.restoreDefaults();
    expect(settings.values.get('homeSectionsV1')).toBeNull();
    expect(isDefaultHomeLayout(homeSectionsStore.getLayout())).toBe(true);
  });

  it('slots Back to your projects in after Climbing now, switched on, for a layout stored without it', async () => {
    settings.values.set('homeSectionsV1', {
      version: 1,
      order: ['week', 'climbingNow', 'session', 'playlists', 'board', 'beta', 'feed'],
      visible: { projects: undefined, climbingNow: true },
    });
    const { homeSectionsStore } = await loadHomeSections();
    const { order, visible } = homeSectionsStore.getLayout();
    expect(order.indexOf('projects')).toBe(order.indexOf('climbingNow') + 1);
    expect(visible.projects).toBe(true);
  });

  it('slots Fresh beta in after Your board, the section it follows, for a layout stored without it', async () => {
    settings.values.set('homeSectionsV1', {
      version: 1,
      order: ['session', 'board', 'playlists', 'climbingNow', 'feed'],
      visible: { session: true, board: true },
    });
    const { homeSectionsStore } = await loadHomeSections();
    expect(homeSectionsStore.getLayout().order).toEqual([
      'week',
      'session',
      'board',
      'beta',
      'playlists',
      'climbingNow',
      'projects',
      'feed',
    ]);
    expect(homeSectionsStore.getLayout().visible.beta).toBe(false);
  });

  it('puts This week first, switched on, for a climber who customised Home before it existed', async () => {
    settings.values.set('homeSectionsV1', {
      version: 1,
      order: ['playlists', 'session', 'board', 'climbingNow', 'beta', 'feed'],
      visible: { playlists: true, session: true, board: false, climbingNow: false, beta: true, feed: true },
    });
    const { homeSectionsStore, visibleTopHomeSections } = await loadHomeSections();
    expect(visibleTopHomeSections(homeSectionsStore.getLayout())).toEqual([
      'week',
      'playlists',
      'session',
      'projects',
      'beta',
    ]);
  });

  it('reads a stored layout at launch, before the first frame', async () => {
    settings.values.set('homeSectionsV1', {
      version: 1,
      order: ['session', 'board', 'playlists', 'climbingNow', 'feed'],
      visible: { session: true, board: true, climbingNow: false },
    });
    const { homeSectionsStore, visibleTopHomeSections } = await loadHomeSections();
    expect(visibleTopHomeSections(homeSectionsStore.getLayout())).toEqual([
      'week',
      'session',
      'board',
      'playlists',
      'projects',
    ]);
    expect(homeSectionsStore.getLayout().visible.feed).toBe(true);
  });

  it('keeps saved Home preferences independent of retired capture flags', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    settings.values.set('homeSectionsV1', {
      version: 1,
      order: ['board', 'session', 'playlists', 'climbingNow', 'feed'],
      visible: { board: true, feed: false },
    });
    const { homeSectionsStore, focusedHomeLayout, isFocusedHomeLayout } = await loadHomeSections();
    expect(homeSectionsStore.getLayout().visible.feed).toBe(false);
    expect(homeSectionsStore.getLayout().order.slice(0, 2)).toEqual(['week', 'board']);
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
    expect(isFocusedHomeLayout(homeSectionsStore.getLayout())).toBe(true);
    expect(settings.writes).toHaveLength(1);
    expect(settings.values.get('homeSectionsV1')).toEqual({ version: 1, ...homeSectionsStore.getLayout() });
  });
});
