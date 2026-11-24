import { describe, expect, it } from 'vitest';
import { buildBoardEmbedSnippet, buildLeaderboardEmbedSnippet, escapeHtmlAttribute } from '../embed-snippets';
import {
  buildBoardEmbedSnippet as buildSharedBoardEmbedSnippet,
  buildLeaderboardEmbedSnippet as buildSharedLeaderboardEmbedSnippet,
} from '@boardsesh/kiosk';

const boardUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const gymUuid = '99999999-8888-4777-8666-555555555555';

describe('shared and web snippet parity', () => {
  it.each(['Main Kilter', `La Peña 岩馆 & "<Crew>"`, "Marco's Wall"])(
    'keeps identical UUID paths and titles for %s',
    (name) => {
      expect(buildBoardEmbedSnippet({ boardUuid, boardName: name })).toBe(
        buildSharedBoardEmbedSnippet({ siteOrigin: 'https://www.boardsesh.com', boardUuid, boardName: name }),
      );
      expect(buildLeaderboardEmbedSnippet({ gymUuid, gymName: name })).toBe(
        buildSharedLeaderboardEmbedSnippet({ siteOrigin: 'https://www.boardsesh.com', gymUuid, gymName: name }),
      );
    },
  );
});

describe('buildBoardEmbedSnippet', () => {
  it('builds the uuid-keyed live board iframe', () => {
    expect(buildBoardEmbedSnippet({ boardUuid, boardName: 'Main Kilter' })).toBe(
      `<iframe src="https://www.boardsesh.com/embed/board/${boardUuid}" width="100%" height="640" style="border:0" loading="lazy" title="Main Kilter — live"></iframe>`,
    );
  });

  it('escapes the board name inside the title attribute', () => {
    const snippet = buildBoardEmbedSnippet({ boardUuid, boardName: '12" <Steep> & Co' });
    expect(snippet).toContain('title="12&quot; &lt;Steep&gt; &amp; Co — live"');
    // The raw name must never appear unescaped in the markup.
    expect(snippet).not.toContain('12" <Steep>');
  });

  it('keeps the trusted canonical origin even when extra runtime fields name another origin or locale', () => {
    const extraFields = { siteOrigin: 'https://untrusted.example', locale: 'es' };
    expect(buildBoardEmbedSnippet({ boardUuid, boardName: 'Board', ...extraFields })).toContain(
      `src="https://www.boardsesh.com/embed/board/${boardUuid}"`,
    );
    expect(buildLeaderboardEmbedSnippet({ gymUuid, gymName: 'Gym', ...extraFields })).toContain(
      `src="https://www.boardsesh.com/embed/gym/${gymUuid}/leaderboard?period=week"`,
    );
  });
});

describe('buildLeaderboardEmbedSnippet', () => {
  it('builds the weekly-default leaderboard iframe', () => {
    expect(buildLeaderboardEmbedSnippet({ gymUuid, gymName: 'Crux House' })).toBe(
      `<iframe src="https://www.boardsesh.com/embed/gym/${gymUuid}/leaderboard?period=week" width="100%" height="520" style="border:0" loading="lazy" title="Crux House — leaderboard"></iframe>`,
    );
  });
});

describe('escapeHtmlAttribute', () => {
  it('escapes ampersands first so entities are not double-escaped', () => {
    expect(escapeHtmlAttribute('&quot;')).toBe('&amp;quot;');
    expect(escapeHtmlAttribute('a & b "c" <d>')).toBe('a &amp; b &quot;c&quot; &lt;d&gt;');
  });

  it("escapes single quotes so single-quoted attribute contexts can't break out", () => {
    expect(escapeHtmlAttribute("Marco's Wall")).toBe('Marco&#39;s Wall');
    expect(escapeHtmlAttribute(`'"&<>'`)).toBe('&#39;&quot;&amp;&lt;&gt;&#39;');
  });
});
