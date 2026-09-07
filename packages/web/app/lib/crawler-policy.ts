/** Automated AI training/search crawlers. Human-triggered unfurlers are separate. */
export const AI_CRAWLER_TOKENS = [
  'gptbot',
  'oai-searchbot',
  'claudebot',
  'claude-searchbot',
  'perplexitybot',
  'amzn-searchbot',
  'amazonbot',
  'bytespider',
  'ccbot',
  'meta-externalagent',
] as const;

export function isBlockedAiCrawler(userAgent: string | null): boolean {
  const normalizedUserAgent = userAgent?.toLowerCase() ?? '';
  return AI_CRAWLER_TOKENS.some((token) => normalizedUserAgent.includes(token));
}
