import { describe, expect, it } from 'vitest';
import { CRITICAL_OTA_RELEASE_CHECKBOX, hasCriticalOtaRelease } from '../ota-release';

const checkedSection = `## OTA release\n\n${CRITICAL_OTA_RELEASE_CHECKBOX}`;

describe('critical OTA release opt-in', () => {
  it('accepts the exact checked template item only in its section', () => {
    expect(hasCriticalOtaRelease(checkedSection)).toBe(true);
    expect(hasCriticalOtaRelease(checkedSection.replace('[x]', '[X]'))).toBe(true);
    expect(hasCriticalOtaRelease(checkedSection.replace('[x]', '[ ]'))).toBe(false);
    expect(hasCriticalOtaRelease(CRITICAL_OTA_RELEASE_CHECKBOX)).toBe(false);
    expect(hasCriticalOtaRelease(`## Summary\n${CRITICAL_OTA_RELEASE_CHECKBOX}`)).toBe(false);
    expect(hasCriticalOtaRelease(`## OTA release\n## Risk\n${CRITICAL_OTA_RELEASE_CHECKBOX}`)).toBe(false);
    expect(hasCriticalOtaRelease(`${checkedSection} please`)).toBe(false);
    expect(hasCriticalOtaRelease(null)).toBe(false);
  });

  it('ignores commented, fenced, quoted and indented examples', () => {
    for (const body of [
      `<!-- ${checkedSection} -->`,
      `<!-- ${checkedSection}`,
      `\`\`\`md\n${checkedSection}\n\`\`\``,
      `~~~md\n${checkedSection}\n~~~`,
      `## OTA release\n\`\`\`\n${CRITICAL_OTA_RELEASE_CHECKBOX}\n\`\`\``,
      `## OTA release\n> ${CRITICAL_OTA_RELEASE_CHECKBOX}`,
      `## OTA release\n    ${CRITICAL_OTA_RELEASE_CHECKBOX}`,
      `<pre>\n${checkedSection}\n</pre>`,
      `## OTA release\n<code>\n${CRITICAL_OTA_RELEASE_CHECKBOX}\n</code>`,
      `## OTA release\n<script>\n${CRITICAL_OTA_RELEASE_CHECKBOX}\n</script>`,
      `## OTA release\n<style>\n${CRITICAL_OTA_RELEASE_CHECKBOX}\n</style>`,
      `## OTA release\n<textarea>\n${CRITICAL_OTA_RELEASE_CHECKBOX}\n</textarea>`,
    ]) {
      expect(hasCriticalOtaRelease(body), body).toBe(false);
    }
  });

  it('accepts an explicit checked item in either repeated OTA release section', () => {
    const uncheckedSection = checkedSection.replace('[x]', '[ ]');
    expect(hasCriticalOtaRelease(`${uncheckedSection}\n\n${checkedSection}`)).toBe(true);
    expect(hasCriticalOtaRelease(`${checkedSection}\n\n${uncheckedSection}`)).toBe(true);
    expect(hasCriticalOtaRelease(`${uncheckedSection}\n\n${uncheckedSection}`)).toBe(false);
  });

  it('does not close a fence at a shorter or different delimiter', () => {
    expect(hasCriticalOtaRelease(`\`\`\`\`md\n\`\`\`\n${checkedSection}\n\`\`\`\``)).toBe(false);
    expect(hasCriticalOtaRelease(`~~~md\n\`\`\`\n${checkedSection}\n~~~`)).toBe(false);
    expect(hasCriticalOtaRelease(`\`\`\`md\nexample\n\`\`\`\n${checkedSection}`)).toBe(true);
  });
});
