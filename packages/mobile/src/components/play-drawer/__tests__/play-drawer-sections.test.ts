import { describe, expect, it, vi } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import {
  DEFAULT_PLAY_DRAWER_SECTION_ORDER,
  DEFAULT_PLAY_DRAWER_SECTIONS,
  type PlayDrawerSectionsVisibility,
} from '../../../lib/play-drawer-sections-preference';
import { visiblePlayDrawerSections } from '../play-drawer-sections';

// Eligibility is pure; preference I/O and telemetry do not participate.
vi.mock('../../../lib/preference-store', () => ({ getPreference: vi.fn(), setPreference: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));

const NO_SECTIONS: PlayDrawerSectionsVisibility = {
  activeHolds: false,
  logbook: false,
  climberLogs: false,
  setterNotes: false,
  betaVideos: false,
  boardseshGrade: false,
  community: false,
  similarClimbs: false,
};
const ELIGIBLE_INPUT = {
  sections: DEFAULT_PLAY_DRAWER_SECTIONS,
  order: DEFAULT_PLAY_DRAWER_SECTION_ORDER,
  isAuthenticated: true,
  boardseshGradeEnabled: true,
  description: 'Start with your left hand on the sidepull.',
  boardName: 'moonboard' as BoardName,
  screenshotMode: false,
};

describe('visiblePlayDrawerSections', () => {
  it('keeps the established section order when all sections are eligible', () => {
    expect(visiblePlayDrawerSections(ELIGIBLE_INPUT)).toEqual([
      'logbook',
      'climberLogs',
      'setterNotes',
      'betaVideos',
      'boardseshGrade',
      'community',
      'similarClimbs',
    ]);
  });

  it("walks the climber's order", () => {
    const order = [
      'similarClimbs',
      'community',
      'logbook',
      'climberLogs',
      'setterNotes',
      'betaVideos',
      'boardseshGrade',
    ] as const;
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, order })).toEqual(order);
  });

  it('keeps a hidden section in its place, so showing it again puts it back', () => {
    const order = [
      'community',
      'logbook',
      'similarClimbs',
      'climberLogs',
      'setterNotes',
      'betaVideos',
      'boardseshGrade',
    ] as const;
    const hidden = { ...DEFAULT_PLAY_DRAWER_SECTIONS, logbook: false };
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, order, sections: hidden }).slice(0, 2)).toEqual([
      'community',
      'similarClimbs',
    ]);
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, order }).slice(0, 3)).toEqual([
      'community',
      'logbook',
      'similarClimbs',
    ]);
  });

  it('applies eligibility in any order', () => {
    const order = [
      'setterNotes',
      'climberLogs',
      'boardseshGrade',
      'logbook',
      'betaVideos',
      'community',
      'similarClimbs',
    ] as const;
    expect(
      visiblePlayDrawerSections({
        ...ELIGIBLE_INPUT,
        order,
        isAuthenticated: false,
        description: 'No match',
        boardseshGradeEnabled: false,
      })[0],
    ).toBe('logbook');
  });

  it('moves the first preview to the first eligible section after Logbook is hidden', () => {
    const sections = { ...DEFAULT_PLAY_DRAWER_SECTIONS, logbook: false };
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, sections })).toEqual([
      'climberLogs',
      'setterNotes',
      'betaVideos',
      'boardseshGrade',
      'community',
      'similarClimbs',
    ]);
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, sections, isAuthenticated: false })[0]).toBe('setterNotes');
    expect(
      visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, sections, isAuthenticated: false, description: 'No match' })[0],
    ).toBe('betaVideos');
  });

  it.each([undefined, null, '', '  ', 'No match', 'NO MATCH!', 'No-match.', 'No matching', 'No match\n  '])(
    'omits notes with no displayable setter description: %s',
    (description) => {
      expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, description })).not.toContain('setterNotes');
    },
  );

  it.each(['No match\nStart left.', 'No matching feet allowed', 'No Houdini swap, spin around pls:). No matching.'])(
    'preserves notes containing useful setter prose: %s',
    (description) => {
      expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, description })).toContain('setterNotes');
    },
  );

  it.each([
    { isAuthenticated: false, screenshotMode: false },
    { isAuthenticated: true, screenshotMode: true },
    { isAuthenticated: false, screenshotMode: true },
  ])('omits Climber logs when auth/screenshot eligibility excludes it: %j', (eligibility) => {
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, ...eligibility })).not.toContain('climberLogs');
  });

  it('omits Boardsesh grade when its feature flag is disabled', () => {
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, boardseshGradeEnabled: false })).not.toContain(
      'boardseshGrade',
    );
  });

  it('returns no sections when enabled choices are all ineligible', () => {
    expect(
      visiblePlayDrawerSections({
        ...ELIGIBLE_INPUT,
        sections: { ...NO_SECTIONS, climberLogs: true, setterNotes: true, boardseshGrade: true },
        isAuthenticated: false,
        description: 'No match',
        boardseshGradeEnabled: false,
      }),
    ).toEqual([]);
  });

  it('returns no sections when the user hides everything, regardless of eligibility', () => {
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, sections: NO_SECTIONS })).toEqual([]);
  });

  it('treats Active holds as a section like the rest on a MoonBoard: on its own it is the peek', () => {
    expect(visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, sections: { ...NO_SECTIONS, activeHolds: true } })).toEqual([
      'activeHolds',
    ]);
    // Off by default, so the default drawer is unchanged.
    expect(visiblePlayDrawerSections(ELIGIBLE_INPUT)).not.toContain('activeHolds');
    // Switched on, it leads the default order.
    expect(
      visiblePlayDrawerSections({
        ...ELIGIBLE_INPUT,
        sections: { ...DEFAULT_PLAY_DRAWER_SECTIONS, activeHolds: true },
      })[0],
    ).toBe('activeHolds');
  });

  it.each<BoardName>(['kilter', 'tension', 'woods', 'spray'])(
    'never shows Active holds on a %s climb, switched on or not, so the next section is the peek',
    (boardName) => {
      const sections = { ...DEFAULT_PLAY_DRAWER_SECTIONS, activeHolds: true };
      const visible = visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, boardName, sections });
      expect(visible).not.toContain('activeHolds');
      expect(visible[0]).toBe('logbook');
      expect(
        visiblePlayDrawerSections({ ...ELIGIBLE_INPUT, boardName, sections: { ...NO_SECTIONS, activeHolds: true } }),
      ).toEqual([]);
    },
  );
});
