// @vitest-environment jsdom
//
// The Accessibility screen was absorbed into "Board look" (issue #2202) — this
// route must keep redirecting bookmarked links and stale native tabs to the new
// screen, rather than 404ing or rendering nothing. It answers the original
// `/profile/accessibility` URL, which is the only one those links carry, and
// forwards to Board look's home under `/settings`.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

const redirect = { hrefs: [] as string[] };

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    redirect.hrefs.push(href);
    return null;
  },
}));

import AccessibilityRoute from '../accessibility';

describe('AccessibilityRoute', () => {
  it('redirects to the Board look screen', () => {
    redirect.hrefs = [];
    render(<AccessibilityRoute />);
    expect(redirect.hrefs).toEqual(['/settings/board-look']);
  });
});
