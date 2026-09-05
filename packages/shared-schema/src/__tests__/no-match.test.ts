// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
  });

  it('handles the marker and a restatement stacked together', () => {
    expect(getDisplayDescription('No match\nNo matching.')).toBe('');
    expect(getDisplayDescription('No match\nNo matching feet allowed')).toBe('No matching feet allowed');
  });
});
