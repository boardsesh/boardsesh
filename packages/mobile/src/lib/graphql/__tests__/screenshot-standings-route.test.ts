import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = fileURLToPath(new URL('../../../../', import.meta.url));
function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? yamlFiles(path) : path.endsWith('.yaml') ? [path] : [];
  });
}

describe('standings query capture reachability', () => {
  it('keeps the new consent query on the Privacy page, outside recorded screenshot flows', () => {
    const flows = yamlFiles(join(mobileRoot, '.maestro'));
    expect(flows.length).toBeGreaterThan(10);
    for (const flow of flows) {
      expect(readFileSync(flow, 'utf8'), flow).not.toMatch(/settings\/privacy|standings-privacy|standingsPrivacy/);
    }
    const screen = readFileSync(join(mobileRoot, 'src/components/privacy/PrivacySettingsScreen.tsx'), 'utf8');
    expect(screen).toContain('useStandingsPrivacy(isAuthenticated ? viewerId : undefined)');
    const settings = readFileSync(join(mobileRoot, 'src/components/settings/root/settings-pages.ts'), 'utf8');
    expect(settings).toContain("privacy: '/settings/privacy'");
    expect(settings).not.toContain('/settings/standings-privacy');
  });
});
