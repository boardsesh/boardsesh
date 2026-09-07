import { describe, it, expect } from 'vitest';
import { getDisplayDescription, isNoMatchClimb, withNoMatch } from '../utils';

describe('isNoMatchClimb', () => {
  it('detects a leading "no match" marker, case-insensitively', () => {
    expect(isNoMatchClimb('No match\nbeta')).toBe(true);
    expect(isNoMatchClimb('no matching feet')).toBe(true);
    expect(isNoMatchClimb('Crimpy start')).toBe(false);
    expect(isNoMatchClimb('')).toBe(false);
    expect(isNoMatchClimb(null)).toBe(false);
    expect(isNoMatchClimb(undefined)).toBe(false);
  });

  // #5127: Aurora has no rules field, and setters commonly append the
  // declaration after their own prose. Every string here is a real catalog
  // description (or a minimal edit of one).
  it('detects a declaration appended after the setter prose', () => {
    for (const description of [
      'Kick board is off. No matching.',
      'Nerds gummy cluster FTW. No matching.',
      'Remedial training for my terrible open hip climbing\nNo matching',
      '1145 ascents on 12ft. Original by iansutherland. No matching.',
      '15 degrees. Approx V5. No matching',
      'Nice one (V5) No matching.',
      'Beta [hard] No matching',
      'Nice one - no matching',
      'beta\r\nNo matching',
      'Feet follow hands! NO MATCHES',
      'Big jugs. no-match',
    ]) {
      expect(isNoMatchClimb(description), description).toBe(true);
    }
  });

  // The precision contract: the declaration has to open a sentence. A wrong
  // glyph is worse than a missing one, so these stay false even though they end
  // with the phrase.
  it('leaves prose that merely mentions matching alone', () => {
    for (const description of [
      'You can match start hold but the rest is no matching',
      'Campus, no match',
      'Aidan climb (no matching)',
      '40 degrees, No matching.',
      'Feet: no matches.',
      'Big move to the jug, there is no match',
      'Matching is fine',
      'Match only the finish hold',
      'Start matched.\nNo feet after the crimp.',
    ]) {
      expect(isNoMatchClimb(description), description).toBe(false);
    }
  });

  // The two halves are OR'd, never swapped: 10,241 catalog rows match the
  // leading form and not the trailing one.
  it('keeps every leading-form verdict the trailing pattern would reject', () => {
    for (const description of [
      'No matching feet allowed',
      'No matching. Some extra notes',
      'No match\nbeta',
      'no matching allowed on this one',
    ]) {
      expect(isNoMatchClimb(description), description).toBe(true);
    }
  });
});

describe('withNoMatch', () => {
  it('prepends the marker when enabling', () => {
    expect(withNoMatch('Crimpy start', true)).toBe('No match\nCrimpy start');
    expect(isNoMatchClimb(withNoMatch('Crimpy start', true))).toBe(true);
  });

  it('is idempotent when already marked', () => {
    expect(withNoMatch('No match\nbeta', true)).toBe('No match\nbeta');
  });

  it('enabling on an empty description yields just the marker', () => {
    expect(isNoMatchClimb(withNoMatch('', true))).toBe(true);
    expect(isNoMatchClimb(withNoMatch(null, true))).toBe(true);
  });

  it('strips only the canonical marker line when disabling', () => {
    expect(withNoMatch('No match\nCrimpy start', false)).toBe('Crimpy start');
    expect(withNoMatch('No match', false)).toBe('');
  });

  it('never deletes real description prose that merely starts with "no match"', () => {
    // "no match" is not the whole first line here — leave the user's text alone.
    expect(withNoMatch('No matching feet allowed', false)).toBe('No matching feet allowed');
    expect(withNoMatch('No match feet, then jump\nbody', false)).toBe('No match feet, then jump\nbody');
  });

  it('never rewrites prose that carries the declaration at the end', () => {
    // Enabling no-ops (the description already declares it) rather than stacking
    // a second "No match" line; disabling leaves the setter's sentence intact.
    const prose = 'Kick board is off. No matching.';
    expect(withNoMatch(prose, true)).toBe(prose);
    expect(withNoMatch(prose, false)).toBe(prose);
  });

  it('leaves an unmarked description unchanged when disabling', () => {
    expect(withNoMatch('Crimpy start', false)).toBe('Crimpy start');
    expect(withNoMatch('', false)).toBe('');
  });

  it('round-trips enable then disable', () => {
    expect(withNoMatch(withNoMatch('Crimpy start', true), false)).toBe('Crimpy start');
  });
});

describe('no-match toggle cannot be derived from the description', () => {
  // The "stuck toggle" edge case: isNoMatchClimb fuzzily matches any description
  // that *starts with* "no match" (e.g. real prose like "No matching feet
  // allowed"), but withNoMatch(..., false) only strips our own canonical marker
  // line — by design, so toggling off never deletes a real description. That
  // means a UI deriving the toggle's checked state from isNoMatchClimb(description)
  // would be stuck ON: turning it off can't make isNoMatchClimb return false.
  // The create controller therefore tracks `noMatch` as independent state and
  // only encodes the marker at save time.
  it('isNoMatchClimb stays true even though withNoMatch(..., false) is a no-op', () => {
    const prose = 'No matching feet allowed';
    expect(isNoMatchClimb(prose)).toBe(true);
    // Disabling does not (and must not) rewrite the prose...
    expect(withNoMatch(prose, false)).toBe(prose);
    // ...so a description-derived toggle would never clear — hence the decouple.
    expect(isNoMatchClimb(withNoMatch(prose, false))).toBe(true);
  });
});

describe('getDisplayDescription', () => {
  it("strips the canonical marker line and keeps the setter's prose", () => {
    expect(getDisplayDescription('No match\nCrimpy start, big move off the gaston')).toBe(
      'Crimpy start, big move off the gaston',
    );
  });

  it('preserves interior newlines and trims the edges', () => {
    expect(getDisplayDescription('  Start matched.\nNo feet after the crimp.  ')).toBe(
      'Start matched.\nNo feet after the crimp.',
    );
  });

  it('returns an empty string when there is nothing to show', () => {
    expect(getDisplayDescription('')).toBe('');
    expect(getDisplayDescription('   ')).toBe('');
    expect(getDisplayDescription(null)).toBe('');
    expect(getDisplayDescription(undefined)).toBe('');
    expect(getDisplayDescription('No match')).toBe('');
    expect(getDisplayDescription('No match\n')).toBe('');
  });

  it('suppresses a description that is only a restatement of "no match"', () => {
    // Roughly half the Aurora catalog's non-empty descriptions are literally
    // this, and the climb header's no-match glyph already says it.
    for (const restatement of [
      'No matching',
      'No matching.',
      'no matching',
      'NO MATCH.',
      'No-match',
      'nomatch',
      'No matching!!',
      'No matching?',
      'No match;',
      'No matching. ',
    ]) {
      expect(getDisplayDescription(restatement)).toBe('');
    }
  });

  it('never eats real setter beta that merely mentions matching (whole-string match only)', () => {
    // The regression the anchored regex exists to prevent: a prefix — or
    // anywhere — match would delete every one of these.
    expect(getDisplayDescription('No matching feet allowed')).toBe('No matching feet allowed');
    expect(getDisplayDescription('No Houdini swap, spin around pls:). No matching.')).toBe(
      'No Houdini swap, spin around pls:). No matching.',
    );
    expect(getDisplayDescription('No matching.\nFeet follow hands.')).toBe('No matching.\nFeet follow hands.');
    expect(getDisplayDescription('Matching is fine')).toBe('Matching is fine');
    // #5127 deliberately did NOT teach the stripper the trailing form: the
    // surviving sentence is usually load-bearing (attribution, beta), and
    // updateClimb writes the description straight back to the row.
    expect(getDisplayDescription('1145 ascents on 12ft. Original by iansutherland. No matching.')).toBe(
      '1145 ascents on 12ft. Original by iansutherland. No matching.',
    );
  });

  it('handles the marker and a restatement stacked together', () => {
    expect(getDisplayDescription('No match\nNo matching.')).toBe('');
    expect(getDisplayDescription('No match\nNo matching feet allowed')).toBe('No matching feet allowed');
  });
});
