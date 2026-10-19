/** Exact opt-in carried by the PR template. A merge ships these bytes to everyone. */
export const CRITICAL_OTA_RELEASE_LABEL = 'Critical OTA release: roll out to 100% stable immediately';
export const CRITICAL_OTA_RELEASE_CHECKBOX = `- [x] ${CRITICAL_OTA_RELEASE_LABEL}`;

/**
 * Only an explicit checked item in the OTA release section authorizes the bypass.
 * Comments, quoted examples, indented code and fenced examples never authorize it.
 */
export function hasCriticalOtaRelease(body: string | null | undefined): boolean {
  if (!body) return false;
  const visibleBody = body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(pre|code|script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '\n');
  let insideReleaseSection = false;
  let fence: { marker: string; length: number } | undefined;
  for (const line of visibleBody.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        delimiter[2].trim() === ''
      ) {
        fence = undefined;
      }
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      continue;
    }
    if (/^ {0,3}#{1,6}[ \t]+/.test(line)) {
      insideReleaseSection = /^ {0,3}##[ \t]+OTA release(?:[ \t]+#+)?[ \t]*$/.test(line);
      continue;
    }
    if (
      insideReleaseSection &&
      /^ {0,3}- \[[xX]\] Critical OTA release: roll out to 100% stable immediately[ \t]*$/.test(line)
    ) {
      return true;
    }
  }
  return false;
}
