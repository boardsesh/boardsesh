import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PLAY_DRAWER_SECTIONS,
  type PlayDrawerSectionsVisibility,
} from '../../../lib/play-drawer-sections-preference';
import { visiblePlayDrawerSections } from '../play-drawer-sections';

// Eligibility is pure; preference I/O and telemetry do not participate.
vi.mock('../../../lib/preference-store', () => ({ getPreference: vi.fn(), setPreference: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));

const NO_SECTIONS: PlayDrawerSectionsVisibility = {
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
  isAuthenticated: true,
  boardseshGradeEnabled: true,
  description: 'Start with your left hand on the sidepull.',
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
});
