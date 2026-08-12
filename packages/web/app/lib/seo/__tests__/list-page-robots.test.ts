import { describe, expect, it } from 'vite-plus/test';
import { hasListFilterParams } from '../list-page-robots';

describe('hasListFilterParams', () => {
  it('is false for an empty query', () => {
    expect(hasListFilterParams({})).toBe(false);
  });

  it('is false when only `page` is set', () => {
    expect(hasListFilterParams({ page: '2' })).toBe(false);
  });

  it.each([
    ['minGrade', '20'],
    ['sortBy', 'quality'],
    ['name', 'crimpy'],
    ['settername', 'someone'],
  ])('is true when `%s` is set', (key, value) => {
    expect(hasListFilterParams({ [key]: value })).toBe(true);
  });

  it('is true for array-valued params with at least one entry', () => {
    expect(hasListFilterParams({ settername: ['alice', 'bob'] })).toBe(true);
  });

  it('is false for an empty-array param', () => {
    expect(hasListFilterParams({ settername: [] })).toBe(false);
  });

  it('is false for an empty-string param', () => {
    expect(hasListFilterParams({ name: '' })).toBe(false);
  });

  it('is true when a filter param is combined with pagination', () => {
    expect(hasListFilterParams({ page: '3', minGrade: '15' })).toBe(true);
  });
});
