// UUID-keyed embed paths survive gym and board renames. Origins come from
// application-owned configuration, never from a gym name, slug, or request.

export type BoardEmbedSnippetOptions = {
  siteOrigin: string;
  boardUuid: string;
  boardName: string;
};

export type LeaderboardEmbedSnippetOptions = {
  siteOrigin: string;
  gymUuid: string;
  gymName: string;
};

/** Escape a string for use inside an HTML attribute (either quote style). */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assertSiteOrigin(siteOrigin: string): void {
  const parsed = new URL(siteOrigin);
  if (parsed.protocol !== 'https:' || parsed.origin !== siteOrigin) {
    throw new Error('Embed URLs require a trusted HTTPS origin without credentials, paths, or query parameters');
  }
}

/** Iframe snippet for the live board view at /embed/board/{boardUuid}. */
export function buildBoardEmbedSnippet({ siteOrigin, boardUuid, boardName }: BoardEmbedSnippetOptions): string {
  assertSiteOrigin(siteOrigin);
  const title = escapeHtmlAttribute(`${boardName} — live`);
  return `<iframe src="${siteOrigin}/embed/board/${boardUuid}" width="100%" height="640" style="border:0" loading="lazy" title="${title}"></iframe>`;
}

/** Weekly leaderboard snippet, with the same canonical path in every locale. */
export function buildLeaderboardEmbedSnippet({ siteOrigin, gymUuid, gymName }: LeaderboardEmbedSnippetOptions): string {
  assertSiteOrigin(siteOrigin);
  const title = escapeHtmlAttribute(`${gymName} — leaderboard`);
  return `<iframe src="${siteOrigin}/embed/gym/${gymUuid}/leaderboard?period=week" width="100%" height="520" style="border:0" loading="lazy" title="${title}"></iframe>`;
}
