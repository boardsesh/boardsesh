import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlacesSource } from './places-import-helpers.js';
import { normalizePlaceSearch } from '../src/queries/places/normalize.js';

const countries = '# country source\nAU\tAUS\t036\tAS\tAustralia\nDE\tDEU\t276\tGM\tGermany';
const regions = 'AU.02\tNew South Wales\tNew South Wales\t2155400\nDE.02\tBavaria\tBavaria\t2951839';
const city = (overrides: Record<number, string> = {}) => {
  const fields = [
    '2147714',
    'Sydney',
    'Sydney',
    'Sidney,悉尼',
    '-33.86785',
    '151.20732',
    'P',
    'PPLA',
    'AU',
    '',
    '02',
    '',
    '',
    '',
    '5638830',
    '',
    '58',
    'Australia/Sydney',
    '2026-01-01',
  ];
  for (const [index, content] of Object.entries(overrides)) fields[Number(index)] = content;
  return fields.join('\t');
};

void test('retains coordinates, qualifiers and alternate names in the searchable index', () => {
  const [place] = parsePlacesSource(city(), countries, regions);
  assert.equal(place.id, 2147714);
  assert.equal(place.region, 'New South Wales');
  assert.equal(place.latitude, -33.86785);
  assert.match(place.searchText, /sidney 悉尼 new south wales australia au/);
});
void test('deduplicates source IDs and normalizes accents consistently', () => {
  const rows = parsePlacesSource([city(), city({ 1: 'Sýdney' })].join('\n'), countries, regions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].normalizedName, 'sydney');
  assert.equal(normalizePlaceSearch('  MÜNCHEN, Straße %_  '), 'munchen strasse');
});
void test('rejects invalid rows and incomplete inputs before importing', () => {
  for (const invalid of [
    city({ 4: 'NaN' }),
    city({ 5: '181' }),
    city({ 8: 'ZZ' }),
    city({ 0: '-1' }),
    city({ 14: '-1' }),
    city({ 1: '' }),
    '',
  ]) {
    assert.throws(() => parsePlacesSource(invalid, countries, regions));
  }
  assert.throws(() => parsePlacesSource(city(), '', regions));
  assert.throws(() => parsePlacesSource(city(), countries, ''));
});
