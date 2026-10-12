import { describe, expect, it } from 'vitest';
import { CONSENT_PROMPT_COUNTRIES, consentPromptRequired, normalizeConsentCountry } from '../index';

const EU_27 = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
];

describe('consentPromptRequired', () => {
  it('lists every EU member state exactly once', () => {
    expect(EU_27).toHaveLength(27);
    for (const country of EU_27) expect(CONSENT_PROMPT_COUNTRIES).toContain(country);
    expect(new Set(CONSENT_PROMPT_COUNTRIES).size).toBe(CONSENT_PROMPT_COUNTRIES.length);
  });

  it.each(EU_27)('asks in EU member state %s', (country) => {
    expect(consentPromptRequired(country)).toBe(true);
  });

  it.each([
    ['IS', 'EEA'],
    ['LI', 'EEA'],
    ['NO', 'EEA'],
    ['GB', 'UK GDPR'],
    ['CH', 'Swiss revised FADP'],
    ['GI', 'Gibraltar GDPR'],
    ['GG', 'Guernsey'],
    ['JE', 'Jersey'],
    ['IM', 'Isle of Man'],
    ['RE', 'Réunion, France'],
    ['GP', 'Guadeloupe, France'],
    ['MQ', 'Martinique, France'],
    ['GF', 'French Guiana, France'],
    ['YT', 'Mayotte, France'],
    ['MF', 'Saint-Martin, France'],
    ['AX', 'Åland, Finland'],
    ['CN', 'China, PIPL'],
    ['KR', 'South Korea, PIPA'],
    ['AD', 'Andorra'],
    ['MC', 'Monaco'],
    ['SM', 'San Marino'],
    ['VA', 'Vatican City'],
    ['FO', 'Faroe Islands'],
  ])('asks in %s (%s)', (country) => {
    expect(consentPromptRequired(country)).toBe(true);
  });

  it.each(['US', 'AU', 'BR', 'NZ', 'JP', 'ZA', 'MX', 'IN', 'HK', 'TW', 'SG'])('does not ask in %s', (country) => {
    expect(consentPromptRequired(country)).toBe(false);
  });

  it.each([
    ['QC', true],
    ['ON', false],
    ['BC', false],
    ['AB', false],
    ['MB', false],
    ['NB', false],
    ['NL', false],
    ['NS', false],
    ['NT', false],
    ['NU', false],
    ['PE', false],
    ['SK', false],
    ['YT', false],
    [undefined, true],
    [null, true],
    ['', true],
    ['qc', true],
    ['CA-QC', true],
    ['ZZ', true],
    ['QZ', true],
  ])('Canadian subdivision %j prompts: %s', (regionCode, expected) => {
    expect(consentPromptRequired('CA', regionCode)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['XX'],
    ['ZZ'],
    ['T1'],
    ['AA'],
    ['AB'],
    ['AP'],
    ['DY'],
    ['WK'],
    ['QM'],
    ['XK'],
    ['EU'],
    ['UK'],
    ['us'],
    ['De'],
    [' US'],
    ['USA'],
    ['U'],
    ['1A'],
  ])('asks when the country is unknown or unreadable: %j', (country) => {
    expect(consentPromptRequired(country)).toBe(true);
  });
});

describe('normalizeConsentCountry', () => {
  it('keeps a real country code and drops everything else', () => {
    expect(normalizeConsentCountry('US')).toBe('US');
    expect(normalizeConsentCountry('DE')).toBe('DE');
    expect(normalizeConsentCountry('XX')).toBeNull();
    expect(normalizeConsentCountry('AB')).toBeNull();
    expect(normalizeConsentCountry('T1')).toBeNull();
    expect(normalizeConsentCountry('us')).toBeNull();
    expect(normalizeConsentCountry(null)).toBeNull();
  });
});
