// @vitest-environment jsdom
//
// The old Settings URL. www's app handoff (the /settings page, the privacy
// policy's deletion link) has pointed at `/profile/more` for releases, so the
// URL has to keep answering after Settings moved to its own root stack — a
// bookmarked or emailed link must not land on +not-found.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const redirect = { hrefs: [] as string[] };

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    redirect.hrefs.push(href);
    return null;
  },
}));

import LegacySettingsRoute from '../more';

describe('LegacySettingsRoute', () => {
  it('forwards the old /profile/more URL to Settings', () => {
    redirect.hrefs = [];
    render(<LegacySettingsRoute />);
    expect(redirect.hrefs).toEqual(['/settings']);
  });
});
