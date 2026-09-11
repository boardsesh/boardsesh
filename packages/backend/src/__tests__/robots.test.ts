import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import { DISALLOWED_ROBOTS_PATHS, handleRobotsTxt, ROBOTS_TXT_BODY } from '../handlers/robots';

type MockRes = {
  statusCode: number;
  body: string | undefined;
  ended: boolean;
  headers: Record<string, string>;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  end: (body?: string) => void;
};

function makeResponse(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    ended: false,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      this.ended = true;
      this.body = body;
    },
  };
}

const request = (method: string) => ({ method }) as IncomingMessage;
const respond = (method: string) => {
  const res = makeResponse();
  handleRobotsTxt(request(method), res as unknown as ServerResponse);
  return res;
};

/** Directive lines only — blank lines and `#` comments carry no meaning. */
function directives(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Evaluate a path the way a crawler does. The policy carries no `Allow`, so a
 * path is crawlable exactly when no `Disallow` prefix matches it (RFC 9309
 * §2.2.2 — longest match wins, and there is nothing to win against).
 */
function isPathCrawlable(body: string, path: string): boolean {
  return !directives(body)
    .filter((line) => line.toLowerCase().startsWith('disallow:'))
    .map((line) => line.slice('disallow:'.length).trim())
    .some((prefix) => path.startsWith(prefix));
}

describe('GET /robots.txt on the backend host', () => {
  it('refuses the API surface', () => {
    const res = respond('GET');
    expect(res.statusCode).toBe(200);
    expect(directives(res.body ?? '')).toEqual([
      'User-agent: *',
      'Disallow: /graphql',
      'Disallow: /api/',
      'Disallow: /health',
      'Disallow: /board-credentials/',
    ]);
  });

  it.each(['/graphql', '/api/posthog/batch/', '/health', '/health/db', '/board-credentials/kilter/start'])(
    'refuses %s',
    (path) => {
      expect(isPathCrawlable(respond('GET').body ?? '', path)).toBe(false);
    },
  );

  it.each([
    // og:image and twitter:image on every climb page, emitted as an absolute
    // URL by buildOgBoardRenderUrl. Blocking it drops the share preview.
    '/og/climb',
    // The climb page's LCP image and the traced art behind it.
    '/render/board',
    '/render/geometry',
    // Avatars, gym logos, gym photos and beta thumbnails, all <img> on
    // indexable pages.
    '/static/avatars/x.png',
    '/static/gym-photos/y.jpg',
    '/static/beta-link-thumbnails/z.jpg',
  ])('still lets a crawler fetch %s', (path) => {
    // This host is mostly an image CDN. A blanket `Disallow: /` would have
    // taken all of these out by omission, which is why the policy is a
    // deny-list.
    expect(isPathCrawlable(respond('GET').body ?? '', path)).toBe(true);
  });

  it('carries no Allow line, so the deny-list is the whole policy', () => {
    // An `Allow` would mean someone had switched to carve-outs; the ordering
    // rules then start to matter and this file's reasoning no longer holds.
    expect(directives(respond('GET').body ?? '').some((line) => line.toLowerCase().startsWith('allow:'))).toBe(false);
  });

  it('serves robots syntax, not HTML', () => {
    // The failure this guards against is the one app.boardsesh.com actually
    // shipped: a /robots.txt that answers with a page. A crawler reading HTML
    // where robots syntax should be finds no rules and crawls everything.
    const res = respond('GET');
    expect(res.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(res.body).not.toContain('<');
  });

  it('is cacheable, since the answer never varies by request', () => {
    expect(respond('GET').headers['Cache-Control']).toBe('public, max-age=86400');
  });

  it('answers HEAD with the same headers and no body', () => {
    const res = respond('HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
  });
});

describe('server.ts routing', () => {
  // handleRobotsTxt is only worth anything if the dispatcher calls it. The
  // route lives inside startServer's closure and cannot be imported, so this
  // reads the source — the one case where a text assertion is the only option.
  const serverSource = readFileSync(resolve(import.meta.dirname, '..', 'server.ts'), 'utf8');

  it('routes /robots.txt to the handler for GET and HEAD', () => {
    expect(serverSource).toContain("import { handleRobotsTxt } from './handlers/robots';");
    expect(serverSource).toMatch(
      /pathname === '\/robots\.txt' && \(req\.method === 'GET' \|\| req\.method === 'HEAD'\)[\s\S]{0,120}handleRobotsTxt\(req, res\);/,
    );
  });

  it('keeps the body a single source of truth', () => {
    // Nothing should re-declare the policy inline next to the route.
    expect(serverSource).not.toContain('Disallow:');
    for (const path of DISALLOWED_ROBOTS_PATHS) {
      expect(ROBOTS_TXT_BODY).toContain(`Disallow: ${path}`);
    }
  });
});
