import { describe, expect, it } from 'vite-plus/test';
import {
  compatibilityBoardSelected,
  importPathChosen,
  navLinkClicked,
  spraywallPathClicked,
  webAppOpened,
} from '../website-journey-events';

describe('website journey contract', () => {
  it('keeps journey events distinct from completed outcomes', () => {
    expect(webAppOpened('header')).toEqual({ name: 'Web App Opened', properties: { placement: 'header' } });
    expect(compatibilityBoardSelected('soill', 'home-chip')).toEqual({
      name: 'Compatibility Board Selected',
      properties: { board: 'soill', source: 'home-chip' },
    });
    expect(importPathChosen('account-link')).toEqual({
      name: 'Import Path Chosen',
      properties: { source: 'account-link' },
    });
    expect(importPathChosen('aurora-export')).toEqual({
      name: 'Import Path Chosen',
      properties: { source: 'aurora-export' },
    });
    expect(spraywallPathClicked('help')).toEqual({ name: 'Spraywall Path Clicked', properties: { placement: 'help' } });
  });

  it('names a static navigation target without an account, query or full URL', () => {
    expect(navLinkClicked('footer', '/bring-your-logbook')).toEqual({
      name: 'Nav Link Clicked',
      properties: { area: 'footer', target: '/bring-your-logbook' },
    });
  });
});
