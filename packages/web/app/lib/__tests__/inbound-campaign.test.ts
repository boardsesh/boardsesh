import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  INBOUND_CAMPAIGN_PARAMS,
  MAX_INBOUND_CAMPAIGN_VALUE_LENGTH,
  __resetSessionInboundCampaignForTests,
  getSessionInboundCampaign,
  parseInboundCampaign,
} from '../inbound-campaign';

const originalLocation = window.location;

function setWindowLocation(url: string): void {
  Object.defineProperty(window, 'location', { value: new URL(url), writable: true, configurable: true });
}

describe('parseInboundCampaign', () => {
  it('returns null for an untagged URL', () => {
    expect(parseInboundCampaign('')).toBeNull();
    expect(parseInboundCampaign('?')).toBeNull();
    expect(parseInboundCampaign('?sort=popular&page=2')).toBeNull();
  });

  it('reads all five utm params and the Google Ads click id', () => {
    expect(
      parseInboundCampaign(
        '?utm_source=instagram&utm_medium=social&utm_campaign=spray-launch&utm_content=reel-1&utm_term=home+wall&gclid=Cj0KCQ',
      ),
    ).toEqual({
      utm_source: 'instagram',
      utm_medium: 'social',
      utm_campaign: 'spray-launch',
      utm_content: 'reel-1',
      utm_term: 'home wall',
      gclid: 'Cj0KCQ',
    });
  });

  it('accepts a query string without the leading question mark', () => {
    expect(parseInboundCampaign('utm_source=chatgpt.com')).toEqual({ utm_source: 'chatgpt.com' });
  });

  it('keeps only the params the URL carried', () => {
    // The real shape of the tagged traffic www gets today: ChatGPT sets a
    // source and nothing else.
    const campaign = parseInboundCampaign('?utm_source=chatgpt.com');
    expect(campaign).toEqual({ utm_source: 'chatgpt.com' });
    expect(Object.keys(campaign ?? {})).toEqual(['utm_source']);
  });

  it('ignores every param outside the contract', () => {
    expect(parseInboundCampaign('?utm_source=ig&fbclid=abc&src=qr&medium=poster&utm_id=7&ref=x')).toEqual({
      utm_source: 'ig',
    });
  });

  it('reads a bare gclid as a campaign', () => {
    expect(parseInboundCampaign('?gclid=EAIaIQobChMI')).toEqual({ gclid: 'EAIaIQobChMI' });
  });

  it('drops a param that is present but blank', () => {
    expect(parseInboundCampaign('?utm_source=&utm_medium=%20%20&utm_campaign=launch')).toEqual({
      utm_campaign: 'launch',
    });
    expect(parseInboundCampaign('?utm_source=&gclid=')).toBeNull();
  });

  it('trims whitespace around a value', () => {
    expect(parseInboundCampaign('?utm_source=%20reddit%20')).toEqual({ utm_source: 'reddit' });
  });

  it('decodes percent-encoded values', () => {
    expect(parseInboundCampaign('?utm_campaign=gym%20week%20%26%20more')).toEqual({
      utm_campaign: 'gym week & more',
    });
  });

  it('takes the first value when a param repeats', () => {
    expect(parseInboundCampaign('?utm_source=first&utm_source=second')).toEqual({ utm_source: 'first' });
  });

  it('is case-sensitive on the param name, like every analytics tool that reads these', () => {
    expect(parseInboundCampaign('?UTM_SOURCE=shouting')).toBeNull();
  });

  it('caps a value at the documented length', () => {
    const campaign = parseInboundCampaign(`?utm_campaign=${'x'.repeat(5000)}`);
    expect(campaign?.utm_campaign).toHaveLength(MAX_INBOUND_CAMPAIGN_VALUE_LENGTH);
  });

  it('lists the params in a stable order', () => {
    expect(INBOUND_CAMPAIGN_PARAMS).toEqual([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'gclid',
    ]);
  });
});

describe('getSessionInboundCampaign', () => {
  beforeEach(() => {
    __resetSessionInboundCampaignForTests();
  });

  afterEach(() => {
    __resetSessionInboundCampaignForTests();
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
  });

  it('reads the campaign off the landing URL', () => {
    setWindowLocation('https://www.boardsesh.com/?utm_source=ig&utm_medium=social');

    expect(getSessionInboundCampaign()).toEqual({ utm_source: 'ig', utm_medium: 'social' });
  });

  it('returns null for an untagged landing', () => {
    setWindowLocation('https://www.boardsesh.com/gyms');

    expect(getSessionInboundCampaign()).toBeNull();
  });

  it('keeps the landing campaign after a client-side navigation drops the params', () => {
    setWindowLocation('https://www.boardsesh.com/?utm_source=ig');
    getSessionInboundCampaign();

    setWindowLocation('https://www.boardsesh.com/gyms');

    expect(getSessionInboundCampaign()).toEqual({ utm_source: 'ig' });
  });

  it('does not adopt a campaign that shows up after an untagged landing', () => {
    // The landing URL is the source. A later URL with tags on it is an internal
    // link someone decorated, not where the visit came from.
    setWindowLocation('https://www.boardsesh.com/');
    getSessionInboundCampaign();

    setWindowLocation('https://www.boardsesh.com/gyms?utm_source=late');

    expect(getSessionInboundCampaign()).toBeNull();
  });

  it('returns the same object every time, so it can be a useSyncExternalStore snapshot', () => {
    setWindowLocation('https://www.boardsesh.com/?utm_source=ig');

    expect(getSessionInboundCampaign()).toBe(getSessionInboundCampaign());
  });
});
