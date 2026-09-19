import { describe, expect, it } from 'vite-plus/test';
import { classifyMarketingBrowser } from '../marketing-platform';

describe('marketing browser selection', () => {
  it.each([
    ['iPhone; CPU iPhone OS 18_0 like Mac OS X', 'ios', false, 'other-web'],
    ['iPad; CPU OS 18_0 like Mac OS X', 'ios', false, 'other-web'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      'ios',
      false,
      'other-web',
    ],
    ['Macintosh; Intel Mac OS X 14_0', 'ios', true, 'desktop-web'],
    ['Linux; Android 15; Pixel 9 Mobile', 'android', false, 'android-web'],
    ['Windows NT 10.0; Win64; x64', 'android', true, 'desktop-web'],
    ['X11; Linux x86_64', 'android', true, 'desktop-web'],
    ['', 'android', true, 'desktop-web'],
  ])('selects the screenshot and store for %s', (userAgent, platform, desktop, installPlatform) => {
    expect(classifyMarketingBrowser(userAgent)).toEqual({ platform, desktop, installPlatform });
  });

  it('refines desktop-mode iPad without changing its server-selected image platform', () => {
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15';
    expect(classifyMarketingBrowser(userAgent)).toEqual({
      platform: 'ios',
      desktop: true,
      installPlatform: 'desktop-web',
    });
    expect(classifyMarketingBrowser(userAgent, 5)).toEqual({
      platform: 'ios',
      desktop: false,
      installPlatform: 'other-web',
    });
  });
});
