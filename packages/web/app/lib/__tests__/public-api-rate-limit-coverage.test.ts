import { describe, expect, it } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiDocument } from '../api-docs/generate-openapi';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../api/v1');

// This explicit policy inventory is compared with a recursive census of every
// route file that actually exports GET below. Adding or renaming a public GET
// therefore fails until its guard and OpenAPI path are reviewed here together.
const EXPECTED_PUBLIC_GET_ROUTES = [
  '[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/[climb_uuid]/route.ts',
  '[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/heatmap/route.ts',
  '[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/setters/route.ts',
  '[board_name]/climb-stats/[climb_uuid]/route.ts',
  '[board_name]/grades/route.ts',
  '[board_name]/slugs/layout/[slug]/route.ts',
  '[board_name]/slugs/sets/[layout_id]/[size_id]/[slug]/route.ts',
  '[board_name]/slugs/size/[layout_id]/[slug]/route.ts',
  'angles/[board_name]/[layout_id]/route.ts',
  'grades/[board_name]/route.ts',
];

const EXPECTED_OPENAPI_PATHS = [
  '/api/v1/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/{climb_uuid}',
  '/api/v1/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/heatmap',
  '/api/v1/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/setters',
  '/api/v1/{board_name}/climb-stats/{climb_uuid}',
  '/api/v1/{board_name}/grades',
  '/api/v1/{board_name}/slugs/layout/{slug}',
  '/api/v1/{board_name}/slugs/sets/{layout_id}/{size_id}/{slug}',
  '/api/v1/{board_name}/slugs/size/{layout_id}/{slug}',
  '/api/v1/angles/{board_name}/{layout_id}',
  '/api/v1/grades/{board_name}',
];

function listRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((directoryEntry) => {
    const childPath = join(directory, directoryEntry.name);
    if (directoryEntry.isDirectory()) return listRouteFiles(childPath);
    return directoryEntry.name === 'route.ts' ? [childPath] : [];
  });
}

describe('public API rate-limit coverage', () => {
  it('guards exactly every public GET route and leaves legacy proxy POSTs alone', () => {
    const routeFiles = listRouteFiles(API_ROOT);
    const publicGetRoutes = routeFiles
      .filter((routeFile) => readFileSync(routeFile, 'utf8').includes('export async function GET'))
      .map((routeFile) => relative(API_ROOT, routeFile))
      .sort();

    expect(publicGetRoutes).toEqual([...EXPECTED_PUBLIC_GET_ROUTES].sort());

    for (const relativeRoute of publicGetRoutes) {
      const source = readFileSync(join(API_ROOT, relativeRoute), 'utf8');
      expect(source).toContain("from '@/app/lib/public-api-rate-limit.server'");
      expect(source.match(/await enforcePublicApiRateLimit\(/g)).toHaveLength(1);
    }

    const proxyRoutes = routeFiles.filter((routeFile) => relative(API_ROOT, routeFile).includes('/proxy/'));
    expect(proxyRoutes).toHaveLength(5);
    for (const proxyRoute of proxyRoutes) {
      expect(readFileSync(proxyRoute, 'utf8')).not.toContain('enforcePublicApiRateLimit');
    }
  });

  it('documents 429 and cached-hit behavior on all ten OpenAPI GET operations', () => {
    const document = generateOpenApiDocument();

    for (const openApiPath of EXPECTED_OPENAPI_PATHS) {
      const getOperation = document.paths?.[openApiPath]?.get;
      expect(getOperation, openApiPath).toBeDefined();
      expect(getOperation?.responses?.[429], openApiPath).toBeDefined();
      expect(getOperation?.description, openApiPath).toContain('CDN cache');
    }
  });
});
