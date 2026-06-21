// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals (process, NodeJS.ErrnoException) or `node:*`
// import specifiers. Type-checking happens at test-run time via vitest.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { initCors, isOriginAllowed, isSameOriginUpgrade, applyCorsHeaders, getAllowedOrigins } from '../handlers/cors';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('CORS Handler', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation(() => {
      const error = new Error('tailscale command not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    delete process.env.TAILSCALE_HOSTNAME;
    delete process.env.DEV_ALLOWED_ORIGINS;

    // Reset to a known state before each test.
    // initCors invokes execFileSync (for Tailscale discovery), so clear the
    // call history afterwards so individual tests start with a clean count.
    initCors('https://boardsesh.com');
    vi.mocked(execFileSync).mockClear();
  });

  describe('initCors', () => {
    it('adds the provided URL to allowed origins', () => {
      initCors('https://example.com');
      expect(getAllowedOrigins()).toContain('https://example.com');
    });

    it('adds www. subdomain variant when hostname does not start with www.', () => {
      initCors('https://boardsesh.com');
      const origins = getAllowedOrigins();
      expect(origins).toContain('https://boardsesh.com');
      expect(origins).toContain('https://www.boardsesh.com');
    });

    it('skips www. variant when hostname already starts with www.', () => {
      initCors('https://www.boardsesh.com');
      const origins = getAllowedOrigins();
      expect(origins).toContain('https://www.boardsesh.com');
      // Should NOT have https://www.www.boardsesh.com
      expect(origins).not.toContain('https://www.www.boardsesh.com');
    });

    it('handles invalid URL gracefully without crashing', () => {
      expect(() => initCors('not-a-valid-url')).not.toThrow();
      // The invalid string is still added as-is
      expect(getAllowedOrigins()).toContain('not-a-valid-url');
    });

    it('adds localhost origins in non-production env', () => {
      // vitest env is 'test', not 'production'
      initCors('https://boardsesh.com');
      const origins = getAllowedOrigins();
      expect(origins).toContain('http://localhost:3000');
      expect(origins).toContain('http://127.0.0.1:3000');
      expect(origins).toContain('http://localhost:3001');
      expect(origins).toContain('http://127.0.0.1:3001');
    });

    it('parses DEV_ALLOWED_ORIGINS env var (comma-separated, trimmed)', () => {
      process.env.DEV_ALLOWED_ORIGINS = ' http://192.168.0.1:3000 , http://10.0.0.1:3000 ';
      initCors('https://boardsesh.com');
      const origins = getAllowedOrigins();
      expect(origins).toContain('http://192.168.0.1:3000');
      expect(origins).toContain('http://10.0.0.1:3000');
      delete process.env.DEV_ALLOWED_ORIGINS;
    });

    it('ignores empty strings from DEV_ALLOWED_ORIGINS', () => {
      process.env.DEV_ALLOWED_ORIGINS = 'http://192.168.0.1:3000,,, ,';
      initCors('https://boardsesh.com');
      const origins = getAllowedOrigins();
      expect(origins).toContain('http://192.168.0.1:3000');
      // Should not contain empty strings
      expect(origins.every((o) => o.length > 0)).toBe(true);
      delete process.env.DEV_ALLOWED_ORIGINS;
    });

    it('adds Tailscale hostname origins from TAILSCALE_HOSTNAME env var', () => {
      process.env.TAILSCALE_HOSTNAME = 'My-Laptop.tailnet123.ts.net';
      initCors('https://boardsesh.com');

      const origins = getAllowedOrigins();
      expect(origins).toContain('http://my-laptop.tailnet123.ts.net:3000');
      expect(origins).toContain('http://my-laptop.tailnet123.ts.net:3001');
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('adds Tailscale hostname origins from tailscale status when available', () => {
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ Self: { DNSName: 'my-mac.tailnet123.ts.net.' } }));

      initCors('https://boardsesh.com');

      const origins = getAllowedOrigins();
      expect(origins).toContain('http://my-mac.tailnet123.ts.net:3000');
      expect(origins).toContain('http://my-mac.tailnet123.ts.net:3001');
      expect(execFileSync).toHaveBeenCalledWith('tailscale', ['status', '--json'], expect.any(Object));
    });

    it('fails gracefully when tailscale is unavailable', () => {
      expect(() => initCors('https://boardsesh.com')).not.toThrow();
      const origins = getAllowedOrigins();
      expect(origins).not.toContain('http://my-mac.tailnet123.ts.net:3000');
      expect(origins).toContain('http://localhost:3000');
    });
  });

  describe('isOriginAllowed', () => {
    beforeEach(() => {
      initCors('https://boardsesh.com');
    });

    it('returns true for origins in the allowed list', () => {
      expect(isOriginAllowed('https://boardsesh.com')).toBe(true);
      expect(isOriginAllowed('https://www.boardsesh.com')).toBe(true);
    });

    it('returns true for Vercel preview deployments matching regex', () => {
      expect(isOriginAllowed('https://boardsesh-abc123-marcodejonghs-projects.vercel.app')).toBe(true);
    });

    it('returns true for homelab preview deployments matching regex', () => {
      expect(isOriginAllowed('https://42.preview.boardsesh.com')).toBe(true);
      expect(isOriginAllowed('https://123.preview.boardsesh.com')).toBe(true);
    });

    it('returns false for non-numeric preview subdomains', () => {
      expect(isOriginAllowed('https://abc.preview.boardsesh.com')).toBe(false);
      expect(isOriginAllowed('https://pr-5.preview.boardsesh.com')).toBe(false);
    });

    it('returns false for preview origins with http (not https)', () => {
      expect(isOriginAllowed('http://42.preview.boardsesh.com')).toBe(false);
    });

    it('returns false for preview origins with extra path or suffix', () => {
      expect(isOriginAllowed('https://42.preview.boardsesh.com.evil.com')).toBe(false);
    });

    it('returns false for origins not in list and not matching regex', () => {
      expect(isOriginAllowed('https://evil.com')).toBe(false);
      expect(isOriginAllowed('https://notboardsesh.com')).toBe(false);
    });

    it('returns false for partial regex matches with wrong prefix', () => {
      expect(isOriginAllowed('http://boardsesh-abc123-marcodejonghs-projects.vercel.app')).toBe(false); // http not https
    });

    it('returns false for partial regex matches with wrong suffix', () => {
      expect(isOriginAllowed('https://boardsesh-abc123-marcodejonghs-projects.vercel.app.evil.com')).toBe(false);
    });

    it('returns true for localhost origins in non-production', () => {
      expect(isOriginAllowed('http://localhost:3000')).toBe(true);
      expect(isOriginAllowed('http://127.0.0.1:3001')).toBe(true);
    });

    it('returns true for private LAN origins in non-production', () => {
      expect(isOriginAllowed('http://192.168.0.42:3000')).toBe(true);
      expect(isOriginAllowed('http://10.0.1.15:3001')).toBe(true);
      expect(isOriginAllowed('http://172.20.10.3:3000')).toBe(true);
    });

    it('returns false for non-dev ports on private LAN origins', () => {
      expect(isOriginAllowed('http://192.168.0.42:8080')).toBe(false);
    });

    describe('Tailscale any-port allow', () => {
      beforeEach(() => {
        process.env.TAILSCALE_HOSTNAME = 'My-Laptop.tailnet123.ts.net';
        initCors('https://boardsesh.com');
      });

      afterEach(() => {
        // Belt-and-braces: outer beforeEach also wipes this, but isolating
        // here protects sibling describes from accidental ordering changes.
        delete process.env.TAILSCALE_HOSTNAME;
      });

      it('allows the resolved Tailscale host on a non-default port over https', () => {
        expect(isOriginAllowed('https://my-laptop.tailnet123.ts.net:3005')).toBe(true);
      });

      it('allows the resolved Tailscale host on a non-default port over http', () => {
        expect(isOriginAllowed('http://my-laptop.tailnet123.ts.net:8765')).toBe(true);
      });

      it('allows the resolved Tailscale host with no port', () => {
        expect(isOriginAllowed('https://my-laptop.tailnet123.ts.net')).toBe(true);
      });

      it('rejects a different Tailscale host even on a dev port', () => {
        expect(isOriginAllowed('https://other-laptop.tailnet123.ts.net:3005')).toBe(false);
      });

      it('rejects path or suffix attempts on the resolved Tailscale host', () => {
        expect(isOriginAllowed('https://my-laptop.tailnet123.ts.net:3005/foo')).toBe(false);
        expect(isOriginAllowed('https://my-laptop.tailnet123.ts.net.evil.com:3005')).toBe(false);
      });
    });
  });

  describe('isSameOriginUpgrade', () => {
    it('allows a genuine same-origin upgrade even in production', () => {
      // The same-origin allowance is NOT gated behind the dev-only branches —
      // this is what unblocks the React Native Android app (Origin derived from
      // wss://ws.boardsesh.com) and preview WS hosts against the prod backend.
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(isSameOriginUpgrade('https://ws.boardsesh.com', 'ws.boardsesh.com')).toBe(true);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('allows preview WS hosts without per-environment config', () => {
      expect(isSameOriginUpgrade('https://42.ws.preview.boardsesh.com', '42.ws.preview.boardsesh.com')).toBe(true);
    });

    it('ignores a port on the Host header (compares hostname only)', () => {
      expect(isSameOriginUpgrade('https://ws.boardsesh.com', 'ws.boardsesh.com:443')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isSameOriginUpgrade('https://WS.Boardsesh.com', 'ws.boardsesh.com')).toBe(true);
    });

    it('ignores a trailing dot on the Origin hostname', () => {
      expect(isSameOriginUpgrade('https://ws.boardsesh.com.', 'ws.boardsesh.com')).toBe(true);
    });

    it('ignores userinfo in the Origin', () => {
      expect(isSameOriginUpgrade('https://user:pass@ws.boardsesh.com', 'ws.boardsesh.com')).toBe(true);
    });

    it('rejects a cross-origin upgrade', () => {
      expect(isSameOriginUpgrade('https://evil.com', 'ws.boardsesh.com')).toBe(false);
    });

    it('rejects a look-alike host that is not an exact hostname match', () => {
      expect(isSameOriginUpgrade('https://ws.boardsesh.com.evil.com', 'ws.boardsesh.com')).toBe(false);
    });

    it('fails closed on a malformed Origin (does not throw)', () => {
      expect(isSameOriginUpgrade('http://[not-a-url', 'ws.boardsesh.com')).toBe(false);
    });

    it('fails closed when the Host header is missing', () => {
      expect(isSameOriginUpgrade('https://ws.boardsesh.com', undefined)).toBe(false);
    });
  });

  /* eslint-disable @typescript-eslint/unbound-method -- all assertions target vi.fn() mocks, no `this` concern */
  describe('applyCorsHeaders', () => {
    function createMockReq(method: string, origin?: string, host?: string) {
      const headers: Record<string, string> = {};
      if (origin) headers.origin = origin;
      if (host) headers.host = host;
      return {
        method,
        headers,
      } as unknown as IncomingMessage;
    }

    function createMockRes() {
      const headers: Record<string, string> = {};
      return {
        setHeader: vi.fn((key: string, value: string) => {
          headers[key] = value;
        }),
        writeHead: vi.fn(),
        end: vi.fn(),
        _headers: headers,
      } as unknown as ServerResponse & { _headers: Record<string, string> };
    }

    it('sets Access-Control-Allow-Origin to request origin when allowed', () => {
      const req = createMockReq('GET', 'https://boardsesh.com');
      const res = createMockRes();
      applyCorsHeaders(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://boardsesh.com');
    });

    it('sets Access-Control-Allow-Credentials to true when origin is allowed', () => {
      const req = createMockReq('GET', 'https://boardsesh.com');
      const res = createMockRes();
      applyCorsHeaders(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
    });

    it('does NOT set origin-specific headers when origin is not allowed', () => {
      const req = createMockReq('GET', 'https://evil.com');
      const res = createMockRes();
      applyCorsHeaders(req, res);

      expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', expect.anything());
      expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Credentials', expect.anything());
    });

    it('echoes the origin for a same-origin request not on the allow-list', () => {
      // ws.boardsesh.com is the backend's own host, never on the website
      // allow-list, but a request whose Origin matches its Host is same-origin.
      const req = createMockReq('GET', 'https://ws.boardsesh.com', 'ws.boardsesh.com');
      const res = createMockRes();
      applyCorsHeaders(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://ws.boardsesh.com');
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
    });

    it('does NOT echo the origin when Origin and Host differ and origin is not allowed', () => {
      const req = createMockReq('GET', 'https://evil.com', 'ws.boardsesh.com');
      const res = createMockRes();
      applyCorsHeaders(req, res);

      expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', expect.anything());
      expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Credentials', expect.anything());
    });

    it('always sets Access-Control-Allow-Methods', () => {
      const req = createMockReq('GET', 'https://evil.com');
      const res = createMockRes();
      applyCorsHeaders(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    });

    it('always sets Access-Control-Allow-Headers', () => {
      const req = createMockReq('GET');
      const res = createMockRes();
      applyCorsHeaders(req, res);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Content-Encoding',
      );
    });

    it('returns false and sends 200 for OPTIONS requests', () => {
      const req = createMockReq('OPTIONS', 'https://boardsesh.com');
      const res = createMockRes();
      const result = applyCorsHeaders(req, res);

      expect(result).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(200);
      expect(res.end).toHaveBeenCalled();
    });

    it('returns true for non-OPTIONS requests', () => {
      const req = createMockReq('GET', 'https://boardsesh.com');
      const res = createMockRes();
      const result = applyCorsHeaders(req, res);

      expect(result).toBe(true);
      expect(res.writeHead).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('returns true for POST requests', () => {
      const req = createMockReq('POST', 'https://boardsesh.com');
      const res = createMockRes();
      const result = applyCorsHeaders(req, res);

      expect(result).toBe(true);
    });
  });
  /* eslint-enable @typescript-eslint/unbound-method */

  describe('getAllowedOrigins', () => {
    it('returns the current allowed origins list', () => {
      initCors('https://test.com');
      const origins = getAllowedOrigins();
      expect(Array.isArray(origins)).toBe(true);
      expect(origins).toContain('https://test.com');
    });
  });
});
