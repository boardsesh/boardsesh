/**
 * Redaction helpers for free text that is about to land somewhere world-readable.
 *
 * Every path that copies user-typed text into the public GitHub tracker shares
 * this module, so a leak fixed here is fixed everywhere. Current consumers:
 * the TestFlight feedback sync (`scripts/testflight-feedback-to-issues.ts`), the
 * in-app bug-report resolver (`packages/backend/src/services/github-feedback.ts`),
 * and the Discord feedback scanner (`scripts/discord-feedback-scan.ts`).
 *
 * This is a best-effort net over the patterns people actually type, not a
 * guarantee. It cannot read pixels, so it does nothing for screenshots, and it
 * will not catch an identity spelled out in prose it has no pattern for. Treat
 * it as one layer: the callers are also responsible for never copying
 * structured identity fields (usernames, ids, emails) into a public payload in
 * the first place.
 */

/** Matches `<@123>`, `<@!123>` (nickname form), `<@&123>` (role) and `<#123>` (channel). */
const DISCORD_MENTION_PATTERN = /<(@[!&]?|#)(\d{15,25})>/g;

/**
 * Strip obvious PII from free text.
 *
 * Handles emails, macOS home paths, `name:`/`tester=`-style labelled fields, and
 * self-introductions ("my name is ...").
 */
export function redactSensitiveText(text: string): string {
  let redactedText = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]');
  redactedText = redactedText.replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]');
  redactedText = redactedText.replace(
    /\b((?:first|last|full)\s+name|name|tester|email)\s*[:=]\s*([^\n\r,;]+)/gi,
    (_match: string, label: string) => `${label}: [redacted]`,
  );
  redactedText = redactedText.replace(
    /\b(my name is|i am|i'm)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gi,
    (_match: string, prefix: string) => `${prefix} [redacted name]`,
  );
  return redactedText;
}

/**
 * Replace Discord mention markup with human-readable placeholders.
 *
 * Raw Discord content carries mentions as `<@123456789012345678>` — a snowflake
 * that resolves straight back to an account. `redactSensitiveText` has no
 * pattern for it, so anything copying Discord text into a public issue must run
 * this too or it publishes user ids.
 */
export function stripDiscordMentions(text: string): string {
  return text.replace(DISCORD_MENTION_PATTERN, (_match: string, prefix: string) => {
    if (prefix === '#') return '#channel';
    if (prefix === '@&') return '@role';
    return '@someone';
  });
}
