import { describe, expect, it } from 'vitest';
import { buildBoardEmbedSnippet, buildLeaderboardEmbedSnippet, escapeHtmlAttribute } from '../embed-snippets';

const siteOrigin = 'https://www.boardsesh.com';
const boardUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const gymUuid = '99999999-8888-4777-8666-555555555555';

describe('shared gym embed snippets', () => {
  it('keeps the board UUID path, dimensions, loading behavior, and title markup', () => {
    expect(buildBoardEmbedSnippet({ siteOrigin, boardUuid, boardName: 'Main Kilter' })).toBe(
      `<iframe src="${siteOrigin}/embed/board/${boardUuid}" width="100%" height="640" style="border:0" loading="lazy" title="Main Kilter — live"></iframe>`,
    );
  });

  it('keeps the weekly query and canonical leaderboard path for localized gym names', () => {
    expect(buildLeaderboardEmbedSnippet({ siteOrigin, gymUuid, gymName: 'La Peña 岩馆' })).toBe(
      `<iframe src="${siteOrigin}/embed/gym/${gymUuid}/leaderboard?period=week" width="100%" height="520" style="border:0" loading="lazy" title="La Peña 岩馆 — leaderboard"></iframe>`,
    );
  });

  it('escapes names without creating attributes or double-escaping generated entities', () => {
    const boardName = `" onload="alert(1) <&>'`;
    expect(buildBoardEmbedSnippet({ siteOrigin, boardUuid, boardName })).toContain(
      'title="&quot; onload=&quot;alert(1) &lt;&amp;&gt;&#39; — live"',
    );
    expect(buildLeaderboardEmbedSnippet({ siteOrigin, gymUuid, gymName: boardName })).toContain(
      'title="&quot; onload=&quot;alert(1) &lt;&amp;&gt;&#39; — leaderboard"',
    );
    expect(escapeHtmlAttribute('&quot;')).toBe('&amp;quot;');
  });

  it('uses the explicit application origin without reading platform configuration', () => {
    expect(
      buildBoardEmbedSnippet({ siteOrigin: 'https://preview.boardsesh.example', boardUuid, boardName: 'Preview' }),
    ).toContain(`src="https://preview.boardsesh.example/embed/board/${boardUuid}"`);
  });

  it.each([
    'http://www.boardsesh.com',
    'javascript:alert(1)',
    'https://user:password@www.boardsesh.com',
    'https://www.boardsesh.com/es',
    'https://www.boardsesh.com?period=month',
    'https://www.boardsesh.com#fragment',
    'https://www.boardsesh.com" onload="alert(1)',
  ])('refuses unsafe schemes and non-origin URL components: %s', (untrustedOrigin) => {
    expect(() => buildBoardEmbedSnippet({ siteOrigin: untrustedOrigin, boardUuid, boardName: 'Board' })).toThrow();
    expect(() => buildLeaderboardEmbedSnippet({ siteOrigin: untrustedOrigin, gymUuid, gymName: 'Gym' })).toThrow();
  });
});
