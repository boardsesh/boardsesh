import { describe, it, expect } from 'vitest';
import { SUPPORT_EVENTS, supportCtaClicked } from '../support-events';

describe('supportCtaClicked', () => {
  it('pairs the event name with its properties', () => {
    expect(
      supportCtaClicked({
        cadence: 'monthly',
        currency: 'usd',
        src: 'web-home-banner',
        option: 2,
        placement: 'options',
      }),
    ).toEqual({
      name: SUPPORT_EVENTS.CtaClicked,
      properties: { cadence: 'monthly', currency: 'usd', src: 'web-home-banner', option: 2, placement: 'options' },
    });
  });

  // Labels come from env and name amounts. The event must never carry one.
  it('carries no label, link or amount', () => {
    const { properties } = supportCtaClicked({
      cadence: 'once',
      currency: 'aud',
      src: 'web-support',
      option: 1,
      placement: 'hero',
    });
    expect(Object.keys(properties).sort()).toEqual(['cadence', 'currency', 'option', 'placement', 'src']);
  });
});
