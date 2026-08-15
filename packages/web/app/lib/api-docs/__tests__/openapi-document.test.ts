import { describe, expect, it } from 'vite-plus/test';
import { generateOpenApiDocument } from '../generate-openapi';

const document = generateOpenApiDocument();
const paths = Object.keys(document.paths ?? {});

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

  it('exposes no Aurora proxy component schema', () => {
    const schemas = Object.keys(document.components?.schemas ?? {});
    expect(schemas).not.toContain('AuroraLoginRequest');
    expect(schemas).not.toContain('AuroraLoginResponse');
    expect(schemas).not.toContain('SaveAscentRequest');
  });

  it('still publishes the surviving public surface', () => {
    // Delete-safety half: an over-broad edit that empties the spec reds here.
    expect(paths.length).toBeGreaterThan(10);
    expect(paths).toContain('/api/internal/profile');
  });
});
