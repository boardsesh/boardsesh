import { describe, it, expect } from 'vitest';
import { newlyAddedEntries, renderDiscordSummary, buildDiscordSummary } from '../lib/changelog-discord-summary';
import type { ChangelogEntry } from '../lib/changelog-transform';

function entry(prNumber: number, category: ChangelogEntry['category'], title: string): ChangelogEntry {
  return { prNumber, category, title, mergedAt: '2026-06-24T00:00:00.000Z', prUrl: `https://x/${prNumber}` };
}

describe('newlyAddedEntries', () => {
  it('returns entries whose PR number is not in the previous set', () => {
    const prev = [entry(1, 'new', 'A'), entry(2, 'fixed', 'B')];
    const next = [entry(3, 'new', 'C'), entry(2, 'fixed', 'B'), entry(1, 'new', 'A')];
    expect(newlyAddedEntries(prev, next).map((item) => item.prNumber)).toEqual([3]);
  });

  it('treats an empty previous list as everything-new', () => {
    const next = [entry(3, 'new', 'C'), entry(1, 'new', 'A')];
    expect(newlyAddedEntries([], next).map((item) => item.prNumber)).toEqual([3, 1]);
  });

  it('returns nothing when next is a subset of prev', () => {
    const prev = [entry(1, 'new', 'A'), entry(2, 'fixed', 'B')];
    expect(newlyAddedEntries(prev, [entry(1, 'new', 'A')])).toEqual([]);
  });
});

describe('renderDiscordSummary', () => {
  it('returns an empty string when there is nothing new', () => {
    expect(renderDiscordSummary([])).toBe('');
  });

  it('groups entries by category in fixed order with emoji labels', () => {
    const summary = renderDiscordSummary([
      entry(1, 'fixed', 'Crash on resume'),
      entry(2, 'new', 'Playlists'),
      entry(3, 'improved', 'Faster sync'),
      entry(4, 'new', 'Dark mode'),
    ]);
    expect(summary).toBe(
      ['✨ New', '• Playlists', '• Dark mode', '🔧 Improved', '• Faster sync', '🐛 Fixed', '• Crash on resume'].join(
        '\n',
      ),
    );
  });

  it('omits categories with no entries', () => {
    const summary = renderDiscordSummary([entry(1, 'new', 'Playlists')]);
    expect(summary).toBe('✨ New\n• Playlists');
    expect(summary).not.toContain('Improved');
    expect(summary).not.toContain('Fixed');
  });

  it('drops entries whose category is not rendered and keeps the overflow count honest', () => {
    // A category outside CATEGORY_DISPLAY (cast past the closed union) must be
    // filtered out before the cap, so it neither renders nor inflates "…and N more".
    const bogus = { prNumber: 99, category: 'internal' as ChangelogEntry['category'], title: 'Hidden' };
    const summary = renderDiscordSummary([entry(1, 'new', 'Playlists'), bogus]);
    expect(summary).toBe('✨ New\n• Playlists');
    expect(summary).not.toContain('Hidden');
    expect(summary).not.toContain('more');
  });

  it('caps the list and summarises the overflow', () => {
    const many = Array.from({ length: 20 }, (_, index) => entry(index + 1, 'new', `Feature ${index + 1}`));
    const summary = renderDiscordSummary(many);
    expect(summary).toContain('• Feature 15');
    expect(summary).not.toContain('• Feature 16');
    expect(summary).toContain('…and 5 more');
  });
});

describe('buildDiscordSummary', () => {
  it('diffs prev→next and renders only the new entries', () => {
    const prev = [entry(1, 'new', 'Old feature')];
    const next = [entry(2, 'fixed', 'New fix'), entry(1, 'new', 'Old feature')];
    expect(buildDiscordSummary(prev, next)).toBe('🐛 Fixed\n• New fix');
  });

  it('returns empty when nothing changed', () => {
    const same = [entry(1, 'new', 'A')];
    expect(buildDiscordSummary(same, same)).toBe('');
  });
});
