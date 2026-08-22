import { describe, expect, it } from 'vite-plus/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as openApiRegistry from '../openapi-registry';
import { generateOpenApiDocument } from '../generate-openapi';

const document = generateOpenApiDocument();
const paths = Object.keys(document.paths ?? {});

// packages/web/app/lib/api-docs/__tests__ -> packages/web
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** `/api/v1/{board_name}/grades` -> `app/api/v1/[board_name]/grades` */
function toRouteDir(path: string): string {
  return join('app', path.replace(/\{([^}]+)\}/g, '[$1]'));
}

function routeFileExists(path: string): boolean {
  const dir = toRouteDir(path);
  return existsSync(join(WEB_ROOT, dir, 'route.ts')) || existsSync(join(WEB_ROOT, dir, 'route.tsx'));
}

describe('generated OpenAPI document', () => {
  it('publishes no Aurora proxy operation', () => {
    // /docs is indexable and sitemapped and /openapi.json is served from public/,
    // so a registration here is a public contract. W-25a (#4441) withdrew both.
    expect(paths.filter((path) => path.includes('/proxy/'))).toEqual([]);
  });

  it('does not name proxy/login or proxy/saveAscent', () => {
    expect(paths).not.toContain('/api/v1/{board_name}/proxy/login');
    expect(paths).not.toContain('/api/v1/{board_name}/proxy/saveAscent');
  });

  it('declares no tag without operations', () => {
    const declared = new Set((document.tags ?? []).map((tag) => tag.name));
    const used = new Set(
      Object.values(document.paths ?? {}).flatMap((item) =>
        Object.values(item as Record<string, { tags?: string[] }>).flatMap((operation) => operation.tags ?? []),
      ),
    );
    // Swagger UI renders an operation-less tag as an empty section on /docs.
    expect([...declared].filter((tag) => !used.has(tag))).toEqual([]);
  });

  it('does not advertise a withdrawn capability in the overview description', () => {
    expect(document.info.description ?? '').not.toContain('Aurora Proxy');
  });

  it('keeps no Aurora proxy schema, in the document or in the registry module', () => {
    const schemas = Object.keys(document.components?.schemas ?? {});
    expect(schemas).not.toContain('AuroraLoginRequest');
    expect(schemas).not.toContain('AuroraLoginResponse');
    expect(schemas).not.toContain('SaveAscentRequest');

    // The document half above cannot see a restored dead export on its own:
    // zod-to-openapi only emits a `components.schemas` entry for a schema some
    // *registered path* references, so a half-revert that brings the schemas
    // back without the registerPath blocks would leave it green. Assert the
    // module surface, which is where the half-revert actually lands.
    const registryExports = Object.keys(openApiRegistry);
    expect(registryExports).not.toContain('AuroraLoginRequestSchema');
    expect(registryExports).not.toContain('AuroraLoginResponseSchema');
    expect(registryExports).not.toContain('SaveAscentRequestSchema');
  });

  it('still publishes the surviving public surface', () => {
    // Delete-safety half: an over-broad edit that empties the spec reds here.
    expect(paths.length).toBeGreaterThan(10);
    expect(paths).toContain('/api/internal/profile');
  });

  it('never advertises a registered path whose route file is gone', () => {
    // `/openapi.json` is a build artefact in public/, not a route — nothing
    // else reconciles the spec against the filesystem. Deleting a route
    // without deregistering it here leaves the published, crawlable spec
    // advertising a URL that 404s. The expected list is built ONLY from the
    // generated document (never from readdir), so an over-broad delete that
    // also removes a still-registered route file reds this, rather than the
    // check trivially agreeing with itself.
    const missing = paths.filter((path) => !routeFileExists(path));
    expect(missing).toEqual([]);
  });
});
