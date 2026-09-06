import { describe, expect, it } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
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

/** The route file's source, or null when there is no route file. */
function routeSource(path: string): string | null {
  const dir = toRouteDir(path);
  for (const candidate of ['route.ts', 'route.tsx']) {
    const file = join(WEB_ROOT, dir, candidate);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  return null;
}

/**
 * Read as SOURCE, not by importing: a route module opens a database pool in its
 * body, and this suite must run with no `DATABASE_URL`. Next recognises a
 * handler declared any of these three ways.
 */
function routeExportsMethod(source: string, method: string): boolean {
  const verb = method.toUpperCase();
  return new RegExp(`export\\s+(?:async\\s+function|function|const)\\s+${verb}\\b`).test(source);
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

  it('never advertises an operation whose route file does not export that verb', () => {
    // The path-only check below cannot see this. `/api/internal/profile` was
    // published as a POST while the route exported GET and PUT, and
    // `/api/auth/verify-email` as a JSON POST while the route was a GET that
    // redirects — two operations on `/docs` and in the crawlable
    // `/openapi.json` that answered 405 to anyone who believed them (#4662).
    // A wrong verb is worse than a missing entry: it reads as a working
    // contract.
    const wrong: string[] = [];

    for (const [path, item] of Object.entries(document.paths ?? {})) {
      const source = routeSource(path);
      // A missing route file is the next test's finding, not this one's.
      if (source === null) continue;

      for (const method of Object.keys(item as Record<string, unknown>)) {
        if (!routeExportsMethod(source, method)) wrong.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('never advertises a registered path whose route file is gone', () => {
    // `/openapi.json` is a build artefact in public/, not a route — nothing
    // else reconciles the spec against the filesystem. Deleting a route
    // without deregistering it here leaves the published, crawlable spec
    // advertising a URL that 404s. The expected list is built ONLY from the
    // generated document (never from readdir), so an over-broad delete that
    // also removes a still-registered route file reds this, rather than the
    // check trivially agreeing with itself.
    //
    // existsSync is not a static import, so test-default's `--changed` never
    // relates this spec to the route-file-only diff it guards. The
    // `rest-surface` job in .github/workflows/ci.yml runs it unfiltered — see
    // the note in packages/web/app/__tests__/rest-surface-inventory.test.ts.
    const missing = paths.filter((path) => !routeFileExists(path));
    expect(missing).toEqual([]);
  });
});
