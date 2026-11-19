import { describe, expect, it } from 'vite-plus/test';
import { gymMapsUrl } from '../gym-maps-url';

describe('public gym map link', () => {
  it('uses finite public coordinates, including zero', () => {
    expect(
      new URL(gymMapsUrl({ latitude: 0, longitude: -73.5, address: 'Elsewhere' })!).searchParams.get('query'),
    ).toBe('0,-73.5');
  });
  it('encodes an address without allowing extra query parameters', () => {
    const link = new URL(gymMapsUrl({ address: '12 Main St & query=elsewhere #hall' })!);
    expect(link.searchParams.get('query')).toBe('12 Main St & query=elsewhere #hall');
    expect([...link.searchParams.keys()]).toEqual(['api', 'query']);
  });
  it('falls back to the address when coordinates are missing or invalid', () => {
    expect(
      new URL(gymMapsUrl({ latitude: Infinity, longitude: 10, address: 'Main St' })!).searchParams.get('query'),
    ).toBe('Main St');
    expect(gymMapsUrl({ latitude: 91, longitude: 10 })).toBeNull();
    expect(gymMapsUrl({ address: '  ' })).toBeNull();
  });
});
