import { describe, expect, it, vi } from 'vite-plus/test';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';

vi.mock('@/app/lib/backend-url', () => ({ getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com' }));

import { buildOgContentVersion, buildOgFamilyImageUrl, buildOgFamilyVersion } from '../og-family';

describe('family card version token', () => {
  it('leads with the render version, so a new drawing moves every family card URL', () => {
    const contentVersion = buildOgContentVersion('2026-11-10', 117);

    expect(buildOgFamilyVersion(contentVersion)).toBe(`${BOARD_RENDER_VERSION}-${contentVersion}`);
    expect(buildOgFamilyImageUrl('playlist', { uuid: 'pl-1' }, contentVersion)).toBe(
      `https://ws.boardsesh.com/og/playlist?uuid=pl-1&v=${BOARD_RENDER_VERSION}-${contentVersion}`,
    );
  });

  it('is the same token for the same content on every request', () => {
    const first = buildOgFamilyImageUrl('profile', { user_id: 'user-1' }, buildOgContentVersion('a', 1));
    const second = buildOgFamilyImageUrl('profile', { user_id: 'user-1' }, buildOgContentVersion('a', 1));
    const changed = buildOgFamilyImageUrl('profile', { user_id: 'user-1' }, buildOgContentVersion('a', 2));

    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });
});
