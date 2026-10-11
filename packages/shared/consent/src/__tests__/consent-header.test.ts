import { describe, expect, it } from 'vitest';
import { ANALYTICS_CAPTURE_PATH, isAnalyticsCaptureUrl } from '../consent-header';

describe('ANALYTICS_CAPTURE_PATH', () => {
  it.each(['/batch', '/batch/', '/e/', '/i/v0/e/', '/s/'])('matches capture path %s', (path) => {
    expect(ANALYTICS_CAPTURE_PATH.test(path)).toBe(true);
  });
  it.each([
    '/flags/',
    '/decide/',
    '/flags//',
    '/array/phc_x/config',
    '/api/surveys/',
    '/i/v1/logs',
    '/batch/extra',
    '/capture/',
  ])('does not match %s', (path) => {
    expect(ANALYTICS_CAPTURE_PATH.test(path)).toBe(false);
  });
});

describe('isAnalyticsCaptureUrl', () => {
  const host = 'https://ws.boardsesh.com/api/posthog';
  it.each([
    [`${host}/batch/`, host, true],
    [`${host}/batch/?compression=gzip-js&_=1`, host, true],
    [`${host}/i/v0/e/`, `${host}/`, true],
    [`${host}/flags/?v=2`, host, false],
    [`${host}/array/phc_x/config`, host, false],
    ['https://us.i.posthog.com/batch/', host, false],
    ['https://ws.boardsesh.com/batch/', host, false],
    ['https://ws.boardsesh.com/api/posthogx/batch/', host, false],
    ['not a url', host, false],
    ['https://us.i.posthog.com/batch/', 'https://us.i.posthog.com', true],
  ])('%s under %s is capture: %s', (url, base, expected) => {
    expect(isAnalyticsCaptureUrl(url, base)).toBe(expected);
  });
});
