import { describe, expect, it } from 'vite-plus/test';
import { META_AD_NAME_MACRO, assertCampaignCode, buildPaidSocialUrl, paidSocialUrlTags } from '../lib/paid-social-urls';

describe('buildPaidSocialUrl', () => {
  it('builds the live Reddit ad URL exactly', () => {
    expect(buildPaidSocialUrl({ source: 'reddit', campaignCode: 'nov26-launch', adId: 'homewalls-ad-1' })).toBe(
      'https://www.boardsesh.com/?utm_source=reddit&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1',
    );
  });

  it('keeps the Meta ad-name macro unencoded for Instagram', () => {
    expect(buildPaidSocialUrl({ source: 'instagram', campaignCode: 'nov26-launch', adId: META_AD_NAME_MACRO })).toBe(
      'https://www.boardsesh.com/?utm_source=instagram&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content={{ad.name}}',
    );
  });

  it('refuses the macro on Reddit, where nothing substitutes it', () => {
    expect(() =>
      paidSocialUrlTags({ source: 'reddit', campaignCode: 'nov26-launch', adId: META_AD_NAME_MACRO }),
    ).toThrow(/only works on Meta/);
  });

  it('accepts an 18-character code and refuses 19, so instagram-<code> fits the 30-character ct', () => {
    const eighteen = 'a'.repeat(18);
    expect(assertCampaignCode(eighteen)).toBe(eighteen);
    expect(`instagram-${eighteen}`.length).toBe(28);
    expect(() => assertCampaignCode('a'.repeat(19))).toThrow(/1-18/);
  });

  it.each(['', 'Nov26', 'nov 26', 'nov_26', 'nov26-', '-nov26', 'nov26&x=1', 'nov26/launch'])(
    'refuses campaign code %j',
    (code) => {
      expect(() => assertCampaignCode(code)).toThrow();
    },
  );

  it.each(['', 'Ad-1', 'ad 1', 'ad&utm_source=x', 'a'.repeat(41)])('refuses ad id %j', (adId) => {
    expect(() => buildPaidSocialUrl({ source: 'reddit', campaignCode: 'nov26-launch', adId })).toThrow();
  });

  it('refuses an unknown source', () => {
    expect(() =>
      buildPaidSocialUrl({ source: 'tiktok' as unknown as 'reddit', campaignCode: 'nov26-launch', adId: 'ad-1' }),
    ).toThrow(/Unknown paid-social source/);
  });
});
