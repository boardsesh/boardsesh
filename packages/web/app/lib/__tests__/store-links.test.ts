import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { GYM_QR_MEDIUMS } from '@boardsesh/analytics';
import { APP_INSTALL_PLACEMENTS } from '../app-install-event';
import {
  APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH,
  appStoreCampaignToken,
  appStoreProviderId,
  buildAppStoreUrl,
  buildPlayStoreUrl,
  buildStoreUrl,
  gymInstallCampaign,
  playStoreLinkId,
  resolveStoreLinkAttribution,
  storeLinkId,
} from '../store-links';

const PLAY_BASE = 'https://play.google.com/store/apps/details?id=com.boardsesh.app';
const APP_STORE_BASE = 'https://apps.apple.com/app/boardsesh/id6761350784';
const PROVIDER_ENV = 'NEXT_PUBLIC_APP_STORE_PROVIDER_ID';

/** What the app reads back: Play hands it the `referrer` param, and it splits that as a query string. */
function installReferrer(playUrl: string): URLSearchParams {
  const referrer = new URL(playUrl).searchParams.get('referrer');
  expect(referrer).not.toBeNull();
  return new URLSearchParams(referrer ?? '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveStoreLinkAttribution', () => {
  it('describes an untagged click on a page', () => {
    expect(resolveStoreLinkAttribution({ placement: 'hero' })).toEqual({
      source: 'boardsesh',
      medium: 'web',
      campaign: 'www',
      content: 'hero',
      inboundTagged: false,
      inboundNamed: false,
    });
  });

  it('names the campaign after the gym, and calls a plain gym-page click web', () => {
    expect(resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'boulderwelt-munich' })).toEqual({
      source: 'boardsesh',
      medium: 'web',
      campaign: 'gym-boulderwelt-munich',
      content: 'gym-page',
      inboundTagged: false,
      inboundNamed: false,
    });
  });

  it('calls a click after a poster scan qr, and names the poster in the link id', () => {
    expect(
      resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'boulderwelt-munich', qrMedium: 'poster' }),
    ).toEqual({
      source: 'boardsesh',
      medium: 'qr',
      campaign: 'gym-boulderwelt-munich',
      content: 'gym-page.poster',
      inboundTagged: false,
      inboundNamed: false,
    });
  });

  it('tells a scan from a page click on the same gym', () => {
    // The bug #6027 names: every gym-page link used to say `qr`, so a poster
    // could not be measured against the page it points at.
    const pageClick = resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'bloclab' });
    const posterScan = resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'bloclab', qrMedium: 'poster' });

    expect(pageClick.medium).not.toBe(posterScan.medium);
    expect(pageClick.content).not.toBe(posterScan.content);
    expect(pageClick.campaign).toBe(posterScan.campaign);
  });

  it.each(GYM_QR_MEDIUMS)('gives the %s code its own link id', (qrMedium) => {
    expect(resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'bloclab', qrMedium })).toMatchObject({
      medium: 'qr',
      content: `gym-page.${qrMedium}`,
    });
  });

  it('treats a null qrMedium as no scan', () => {
    expect(resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'bloclab', qrMedium: null })).toMatchObject({
      medium: 'web',
      content: 'gym-page',
    });
  });

  it("lets the caller's own campaign win over the gym's", () => {
    expect(
      resolveStoreLinkAttribution({ placement: 'join-page', campaign: 'join-abc123', gymSlug: 'bloclab' }).campaign,
    ).toBe('join-abc123');
  });

  it('falls back to the default campaign for an empty slug or campaign', () => {
    // An empty slug must not name the campaign `gym-`, which would pool every
    // such gym's installs in one bucket.
    expect(resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: '' }).campaign).toBe('www');
    expect(resolveStoreLinkAttribution({ placement: 'hero', campaign: '' }).campaign).toBe('www');
  });

  it("carries a tagged visitor's source, medium and campaign through", () => {
    expect(
      resolveStoreLinkAttribution({
        placement: 'hero',
        inbound: { utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'spray-launch' },
      }),
    ).toEqual({
      source: 'instagram',
      medium: 'social',
      campaign: 'spray-launch',
      content: 'hero',
      inboundTagged: true,
      inboundNamed: true,
    });
  });

  it('overrides field by field, so a tag with no campaign keeps the gym', () => {
    // A gym linking its page from its Instagram bio: the source is theirs, the
    // campaign is still the gym.
    expect(
      resolveStoreLinkAttribution({
        placement: 'gym-page',
        gymSlug: 'bloclab',
        inbound: { utm_source: 'instagram', utm_medium: 'social' },
      }),
    ).toEqual({
      source: 'instagram',
      medium: 'social',
      campaign: 'gym-bloclab',
      content: 'gym-page',
      inboundTagged: true,
      inboundNamed: true,
    });
  });

  it('keeps our medium when the visitor tagged only a source', () => {
    expect(resolveStoreLinkAttribution({ placement: 'hero', inbound: { utm_source: 'chatgpt.com' } })).toMatchObject({
      source: 'chatgpt.com',
      medium: 'web',
      campaign: 'www',
      inboundTagged: true,
      inboundNamed: true,
    });
  });

  it.each(['organic', 'Organic', 'ORGANIC', '(not set)', '(Not Set)'])(
    "keeps our medium when the visitor's is %s, which the app reads as a Play organic install",
    (reservedMedium) => {
      // A gym tagging its Google Business Profile link. Source and campaign are
      // theirs; the medium is the one value that would hide the install.
      const inbound = { utm_source: 'google', utm_medium: reservedMedium, utm_campaign: 'gbp' };

      expect(resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'bloclab', inbound })).toEqual({
        source: 'google',
        medium: 'web',
        campaign: 'gbp',
        content: 'gym-page',
        inboundTagged: true,
        inboundNamed: true,
      });
      expect(
        resolveStoreLinkAttribution({ placement: 'gym-page', gymSlug: 'bloclab', qrMedium: 'poster', inbound }).medium,
      ).toBe('qr');
    },
  );

  it('is not tagged by a reserved medium on its own', () => {
    expect(resolveStoreLinkAttribution({ placement: 'hero', inbound: { utm_medium: 'organic' } })).toEqual(
      resolveStoreLinkAttribution({ placement: 'hero' }),
    );
  });

  it('still reads a bare Google Ads click as cpc when the link also said organic', () => {
    expect(
      resolveStoreLinkAttribution({ placement: 'hero', inbound: { gclid: 'EAIaIQobChMI', utm_medium: 'organic' } }),
    ).toMatchObject({ source: 'google', medium: 'cpc' });
  });

  it('is tagged but not named by a visitor who brought only a medium', () => {
    expect(resolveStoreLinkAttribution({ placement: 'hero', inbound: { utm_medium: 'social' } })).toEqual({
      source: 'boardsesh',
      medium: 'social',
      campaign: 'www',
      content: 'hero',
      inboundTagged: true,
      inboundNamed: false,
    });
  });

  it("never lets the visitor's utm_content replace the link id", () => {
    // The link id says which button was pressed. An ad's creative id is on the
    // PostHog events; it does not get to erase the placement.
    expect(
      resolveStoreLinkAttribution({
        placement: 'climb-view',
        inbound: { utm_source: 'reddit', utm_content: 'creative-7', utm_term: 'kilter' },
      }).content,
    ).toBe('climb-view');
  });

  it('reads a bare Google Ads click id as google / cpc', () => {
    expect(resolveStoreLinkAttribution({ placement: 'hero', inbound: { gclid: 'EAIaIQobChMI' } })).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'www',
      content: 'hero',
      inboundTagged: true,
      inboundNamed: true,
    });
  });

  it('prefers an explicit utm_source over the click-id default', () => {
    expect(
      resolveStoreLinkAttribution({ placement: 'hero', inbound: { gclid: 'EAIaIQobChMI', utm_source: 'newsletter' } }),
    ).toMatchObject({ source: 'newsletter', medium: 'web' });
  });

  it('is not tagged by a visitor who brought only a content or term param', () => {
    expect(resolveStoreLinkAttribution({ placement: 'hero', inbound: { utm_content: 'x', utm_term: 'y' } })).toEqual({
      source: 'boardsesh',
      medium: 'web',
      campaign: 'www',
      content: 'hero',
      inboundTagged: false,
      inboundNamed: false,
    });
  });

  it('treats a null inbound campaign like none', () => {
    expect(resolveStoreLinkAttribution({ placement: 'hero', inbound: null })).toEqual(
      resolveStoreLinkAttribution({ placement: 'hero' }),
    );
  });
});

describe('storeLinkId', () => {
  it('is the placement, plus the printed medium after a scan', () => {
    expect(storeLinkId('gyms-directory')).toBe('gyms-directory');
    expect(storeLinkId('gym-page', null)).toBe('gym-page');
    expect(storeLinkId('gym-page', 'kiosk')).toBe('gym-page.kiosk');
  });

  it('is unique per placement', () => {
    const linkIds = APP_INSTALL_PLACEMENTS.map((placement) => storeLinkId(placement));
    expect(new Set(linkIds).size).toBe(APP_INSTALL_PLACEMENTS.length);
  });
});

describe('a session invite link (linkDetail)', () => {
  const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
  const invite = { placement: 'join-page', campaign: 'session-invite', linkDetail: SESSION_ID } as const;

  it('appends the session id to the Play link id', () => {
    expect(playStoreLinkId(invite)).toBe(`join-page.${SESSION_ID}`);
    expect(playStoreLinkId({ placement: 'join-page' })).toBe('join-page');
  });

  it('carries the session id to the app in the referrer utm_content', () => {
    const referrer = installReferrer(buildPlayStoreUrl(invite));

    expect(referrer.get('utm_content')).toBe(`join-page.${SESSION_ID}`);
    expect(referrer.get('utm_campaign')).toBe('session-invite');
    expect(referrer.get('utm_source')).toBe('boardsesh');
    expect(referrer.get('utm_medium')).toBe('web');
  });

  it('ignores a detail that is not letters, digits and hyphens', () => {
    for (const linkDetail of ['', 'bad id!', 'a&utm_source=evil', 'a.b', '../x', 'a b']) {
      expect(playStoreLinkId({ placement: 'join-page', linkDetail })).toBe('join-page');
    }
  });

  it('keeps the session id out of the App Store token', () => {
    expect(appStoreCampaignToken(invite)).toBe('join-page');
    expect(new URL(buildAppStoreUrl(invite)).searchParams.get('ct')).toBe('join-page');
    expect(buildAppStoreUrl(invite)).not.toContain(SESSION_ID);
  });

  it('still lets a tagged visitor name the campaign, and keeps the session in the link id', () => {
    const referrer = installReferrer(
      buildPlayStoreUrl({ ...invite, inbound: { utm_source: 'whatsapp', utm_campaign: 'crew-night' } }),
    );

    expect(referrer.get('utm_source')).toBe('whatsapp');
    expect(referrer.get('utm_campaign')).toBe('crew-night');
    expect(referrer.get('utm_content')).toBe(`join-page.${SESSION_ID}`);
  });
});

describe('gymInstallCampaign', () => {
  it('names the campaign after the gym', () => {
    // The string gym installs have reported since #4379. Do not change it.
    expect(gymInstallCampaign('boulderwelt-munich')).toBe('gym-boulderwelt-munich');
  });
});

describe('buildPlayStoreUrl', () => {
  it('builds the exact hero URL, with referrer as well as the bare utm params', () => {
    expect(buildPlayStoreUrl({ placement: 'hero' })).toBe(
      `${PLAY_BASE}&utm_source=boardsesh&utm_medium=web&utm_campaign=www&utm_content=hero` +
        '&referrer=utm_source%3Dboardsesh%26utm_medium%3Dweb%26utm_campaign%3Dwww%26utm_content%3Dhero',
    );
  });

  it('builds the exact URL for a click after a poster scan', () => {
    expect(buildPlayStoreUrl({ placement: 'gym-page', gymSlug: 'boulderwelt-munich', qrMedium: 'poster' })).toBe(
      `${PLAY_BASE}&utm_source=boardsesh&utm_medium=qr&utm_campaign=gym-boulderwelt-munich&utm_content=gym-page.poster` +
        '&referrer=utm_source%3Dboardsesh%26utm_medium%3Dqr%26utm_campaign%3Dgym-boulderwelt-munich%26utm_content%3Dgym-page.poster',
    );
  });

  it('round-trips the referrer back through the mobile parser contract', () => {
    // THIS is the consumer contract, not an implementation detail.
    // `packages/mobile/src/lib/install-referrer.ts` reads Play's Install
    // Referrer string with `new URLSearchParams(raw)`, and Play populates that
    // string from the `referrer` QUERY PARAM of the store URL, not from the bare
    // `utm_*` params. A link carrying only the bare params attributes nothing.
    const referrer = installReferrer(buildPlayStoreUrl({ placement: 'gym-page', gymSlug: 'boulderwelt-munich' }));

    expect(referrer.get('utm_source')).toBe('boardsesh');
    expect(referrer.get('utm_medium')).toBe('web');
    expect(referrer.get('utm_campaign')).toBe('gym-boulderwelt-munich');
    expect(referrer.get('utm_content')).toBe('gym-page');
  });

  it('puts the same four values in the referrer and in the bare params', () => {
    const url = new URL(
      buildPlayStoreUrl({
        placement: 'help',
        inbound: { utm_source: 'reddit', utm_medium: 'social', utm_campaign: 'ama' },
      }),
    );
    const referrer = installReferrer(url.toString());

    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
      expect(referrer.get(param)).toBe(url.searchParams.get(param));
    }
    expect([...referrer.keys()]).toEqual(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']);
  });

  it("keeps a tagged visitor's source through to the install", () => {
    const referrer = installReferrer(
      buildPlayStoreUrl({
        placement: 'hero',
        inbound: { utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'spray-launch' },
      }),
    );

    expect(referrer.get('utm_source')).toBe('instagram');
    expect(referrer.get('utm_medium')).toBe('social');
    expect(referrer.get('utm_campaign')).toBe('spray-launch');
    expect(referrer.get('utm_content')).toBe('hero');
  });

  it.each([
    { utm_source: 'google', utm_medium: 'organic', utm_campaign: 'gbp' },
    { utm_source: 'google', utm_medium: 'Organic' },
    { utm_medium: 'organic' },
    { utm_medium: '(not set)' },
    { utm_source: 'instagram', utm_medium: 'social' },
    { gclid: 'EAIaIQobChMI' },
    {},
  ])('never builds a referrer the app files as organic or unknown: %o', (inbound) => {
    // The rule in `classifyInstallChannel`
    // (packages/mobile/src/lib/install-referrer.ts), restated because the
    // mobile module cannot be imported here: a medium of `organic` is organic
    // whatever else the referrer says, and a referrer with no usable source,
    // medium or campaign is unknown. Every www button has to land in `campaign`.
    const referrer = installReferrer(buildPlayStoreUrl({ placement: 'gym-page', gymSlug: 'bloclab', inbound }));
    const medium = referrer.get('utm_medium');
    const hasValue = (param: string | null) => param !== null && param !== '' && param !== '(not set)';

    expect(medium?.toLowerCase()).not.toBe('organic');
    expect(hasValue(referrer.get('utm_source'))).toBe(true);
    expect(hasValue(medium)).toBe(true);
    expect(hasValue(referrer.get('utm_campaign'))).toBe(true);
    expect(referrer.get('utm_content')).toBe('gym-page');
  });

  it('does not copy the ad click id into the link', () => {
    const playUrl = buildPlayStoreUrl({ placement: 'hero', inbound: { gclid: 'EAIaIQobChMI' } });

    expect(playUrl).not.toContain('gclid');
    expect(playUrl).not.toContain('EAIaIQobChMI');
    expect(installReferrer(playUrl).get('utm_source')).toBe('google');
  });

  it('keeps the referrer parseable for values carrying characters that need escaping', () => {
    const url = new URL(
      buildPlayStoreUrl({
        placement: 'gym-page',
        gymSlug: 'a&b=c gym',
        inbound: { utm_source: 'x&utm_content=forged', utm_medium: 'a=b' },
      }),
    );
    const referrer = installReferrer(url.toString());

    // The nested query string is encoded once as a param value, so an inner `&`
    // or `=` cannot break out and forge another param.
    expect(referrer.get('utm_source')).toBe('x&utm_content=forged');
    expect(referrer.get('utm_medium')).toBe('a=b');
    expect(referrer.get('utm_campaign')).toBe('gym-a&b=c gym');
    expect(referrer.get('utm_content')).toBe('gym-page');
    expect(referrer.getAll('utm_content')).toHaveLength(1);
    expect(url.searchParams.getAll('utm_content')).toEqual(['gym-page']);
  });

  it('leaves the app id intact', () => {
    expect(new URL(buildPlayStoreUrl({ placement: 'site-banner' })).searchParams.get('id')).toBe('com.boardsesh.app');
  });

  it.each(APP_INSTALL_PLACEMENTS)('tags the %s link with its own id', (placement) => {
    expect(installReferrer(buildPlayStoreUrl({ placement })).get('utm_content')).toBe(placement);
  });
});

describe('appStoreProviderId', () => {
  it('is null when the build has no provider id', () => {
    vi.stubEnv(PROVIDER_ENV, '');
    expect(appStoreProviderId()).toBeNull();
  });

  it('reads a numeric provider id, ignoring surrounding whitespace', () => {
    vi.stubEnv(PROVIDER_ENV, ' 123456789 ');
    expect(appStoreProviderId()).toBe('123456789');
  });

  it('rejects anything that is not digits', () => {
    // A placeholder left in a deploy config must not reach a public link.
    vi.stubEnv(PROVIDER_ENV, 'TODO-provider-id');
    expect(appStoreProviderId()).toBeNull();
    vi.stubEnv(PROVIDER_ENV, '12345&ct=forged');
    expect(appStoreProviderId()).toBeNull();
  });
});

describe('appStoreCampaignToken', () => {
  it('is the link id for an untagged visit', () => {
    expect(appStoreCampaignToken({ placement: 'hero' })).toBe('hero');
    expect(appStoreCampaignToken({ placement: 'gym-page', gymSlug: 'boulderwelt-munich' })).toBe('gym-page');
    expect(appStoreCampaignToken({ placement: 'gym-page', gymSlug: 'bloclab', qrMedium: 'poster' })).toBe(
      'gym-page.poster',
    );
  });

  it('never names a single gym', () => {
    // App Analytics hides a campaign under 5 first-time downloads, and no one
    // gym reaches that from its page. All gyms share one token per kind of link.
    expect(appStoreCampaignToken({ placement: 'gym-page', gymSlug: 'seattle-bouldering-project-poplar' })).toBe(
      appStoreCampaignToken({ placement: 'gym-page', gymSlug: 'bloclab' }),
    );
  });

  it("is the visitor's source and campaign for a tagged visit", () => {
    expect(
      appStoreCampaignToken({
        placement: 'hero',
        inbound: { utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'spray-launch' },
      }),
    ).toBe('instagram-spray-launch');
  });

  it("is the visitor's source alone when their link named no campaign", () => {
    expect(appStoreCampaignToken({ placement: 'hero', inbound: { utm_source: 'chatgpt.com' } })).toBe('chatgpt.com');
    expect(
      appStoreCampaignToken({ placement: 'gym-page', gymSlug: 'bloclab', inbound: { utm_source: 'instagram' } }),
    ).toBe('instagram');
  });

  it('is the link id when the visitor tagged a medium and nothing else', () => {
    // Our own source would make the token `boardsesh` on every button, which
    // names neither where the visitor came from nor what they pressed.
    expect(appStoreCampaignToken({ placement: 'hero', inbound: { utm_medium: 'social' } })).toBe('hero');
    expect(appStoreCampaignToken({ placement: 'help', inbound: { utm_medium: 'email' } })).toBe('help');
    expect(
      appStoreCampaignToken({
        placement: 'gym-page',
        gymSlug: 'bloclab',
        qrMedium: 'poster',
        inbound: { utm_medium: 'social', utm_content: 'creative-7' },
      }),
    ).toBe('gym-page.poster');
  });

  it("names a visitor's campaign when their link had no source", () => {
    expect(appStoreCampaignToken({ placement: 'hero', inbound: { utm_campaign: 'spray-launch' } })).toBe(
      'boardsesh-spray-launch',
    );
  });

  it('reads a bare Google Ads click as google', () => {
    expect(appStoreCampaignToken({ placement: 'hero', inbound: { gclid: 'EAIaIQobChMI' } })).toBe('google');
  });

  it('never exceeds the 30 characters Apple allows', () => {
    const token = appStoreCampaignToken({
      placement: 'hero',
      inbound: { utm_source: 'newsletter', utm_campaign: 'an-even-longer-campaign-name-2026' },
    });

    expect(token).toHaveLength(APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH);
    expect(token).toBe('newsletter-an-even-longer-camp');
    expect(APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH).toBe(30);
  });

  it('does not end on a separator left behind by the cut', () => {
    const token = appStoreCampaignToken({
      placement: 'hero',
      inbound: { utm_source: 'abcdefghijklmnopqrstuvwxyz012', utm_campaign: 'spaced out' },
    });

    // 29 characters of source, then the joining `-` lands on character 30.
    expect(token).toBe('abcdefghijklmnopqrstuvwxyz012');
  });

  it('replaces anything outside letters, digits, dot, underscore and hyphen', () => {
    expect(
      appStoreCampaignToken({
        placement: 'hero',
        inbound: { utm_source: 'my news/letter', utm_campaign: 'été 2026!' },
      }),
    ).toBe('my-news-letter--t-2026');
  });

  it('falls back to the link id when the visitor tags reduce to nothing', () => {
    expect(appStoreCampaignToken({ placement: 'help', inbound: { utm_source: '???' } })).toBe('help');
  });

  it.each(APP_INSTALL_PLACEMENTS)('fits the %s link id, with a printed medium, inside the limit', (placement) => {
    for (const qrMedium of GYM_QR_MEDIUMS) {
      const token = appStoreCampaignToken({ placement, qrMedium });
      expect(token).toBe(`${placement}.${qrMedium}`);
      expect(token.length).toBeLessThanOrEqual(APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH);
    }
  });
});

describe('buildAppStoreUrl', () => {
  it('carries the campaign token and media type, and no provider when none is configured', () => {
    vi.stubEnv(PROVIDER_ENV, '');

    expect(buildAppStoreUrl({ placement: 'hero' })).toBe(`${APP_STORE_BASE}?ct=hero&mt=8`);
  });

  it('adds the provider id when the build has one', () => {
    vi.stubEnv(PROVIDER_ENV, '123456789');

    expect(buildAppStoreUrl({ placement: 'gym-page', gymSlug: 'bloclab', qrMedium: 'poster' })).toBe(
      `${APP_STORE_BASE}?pt=123456789&ct=gym-page.poster&mt=8`,
    );
  });

  it('omits pt for a provider id that is not a number', () => {
    vi.stubEnv(PROVIDER_ENV, 'not-a-number');

    expect(new URL(buildAppStoreUrl({ placement: 'hero' })).searchParams.has('pt')).toBe(false);
  });

  it("carries a tagged visitor's source", () => {
    vi.stubEnv(PROVIDER_ENV, '123456789');

    const url = new URL(
      buildAppStoreUrl({ placement: 'hero', inbound: { utm_source: 'reddit', utm_campaign: 'r-bouldering' } }),
    );

    expect(url.searchParams.get('ct')).toBe('reddit-r-bouldering');
    expect(url.searchParams.get('mt')).toBe('8');
    expect(url.searchParams.get('pt')).toBe('123456789');
  });

  it('still points at the Boardsesh listing', () => {
    const url = new URL(buildAppStoreUrl({ placement: 'climb-list' }));

    expect(`${url.origin}${url.pathname}`).toBe(APP_STORE_BASE);
  });
});

describe('buildStoreUrl', () => {
  it('picks the builder by store', () => {
    vi.stubEnv(PROVIDER_ENV, '');
    const storeLink = { placement: 'climb-view' } as const;

    expect(buildStoreUrl('android', storeLink)).toBe(buildPlayStoreUrl(storeLink));
    expect(buildStoreUrl('ios', storeLink)).toBe(buildAppStoreUrl(storeLink));
  });
});
