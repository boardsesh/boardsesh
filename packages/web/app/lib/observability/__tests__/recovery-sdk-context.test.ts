import { createRequire } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';
import { redactShareCapabilitiesFromEvent } from '../redact-share-capabilities';
import { scrubPasswordRecoveryEvent } from '@boardsesh/text-redaction';

// Public browser integration resolved through the installed web SDK, without
// adding an application dependency or initializing any telemetry transport.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@sentry/nextjs/package.json'));
const browser = sdkRequire('@sentry/react') as {
  BrowserClient: new (options: {
    integrations: unknown[];
    stackParser: () => [];
    transport: () => { send: () => Promise<object>; flush: () => Promise<boolean> };
    sendDefaultPii: boolean;
  }) => unknown;
  httpContextIntegration(): {
    preprocessEvent(event: Record<string, unknown>, hint: object, client: unknown): void;
    processSegmentSpan(span: { attributes: Record<string, unknown> }): void;
  };
};

describe('installed browser Sentry context on recovery links', () => {
  it.each(['?', '#'])(
    'redacts actual HttpContext URL/referrer enrichment with marker%s and PII disabled',
    async (marker) => {
      const originalLocation = window.location;
      const originalReferrer = Object.getOwnPropertyDescriptor(document, 'referrer');
      const token = 'a363934b-b7ba-41ba-a279-52185daa100e';
      const url = `https://www.boardsesh.com/auth/reset-password${marker}token=${token}&email=Climber%40example.test&src=mail`;
      Object.defineProperty(window, 'location', { value: new URL(url), configurable: true });
      let nestedReferrer = url;
      for (let depth = 0; depth < 12; depth += 1) nestedReferrer = encodeURIComponent(nestedReferrer);
      Object.defineProperty(document, 'referrer', {
        value: `https://www.boardsesh.com/auth/login?callbackUrl=${nestedReferrer}`,
        configurable: true,
      });
      try {
        const integration = browser.httpContextIntegration();
        const client = new browser.BrowserClient({
          integrations: [],
          stackParser: () => [],
          sendDefaultPii: false,
          transport: () => ({ send: async () => ({}), flush: async () => true }),
        });
        const enriched: Record<string, unknown> = {};
        expect(typeof integration.preprocessEvent).toBe('function');
        integration.preprocessEvent(enriched, {}, client);
        expect(JSON.stringify(enriched)).toContain(token);
        expect(JSON.stringify(enriched)).toContain('callbackUrl=');
        const scrubbed = JSON.stringify(redactShareCapabilitiesFromEvent(enriched));
        expect(scrubbed).not.toContain(token);
        expect(scrubbed).not.toContain('Climber');
        expect(scrubbed).not.toContain('src=mail');
        const span = { attributes: { 'sentry.op': 'navigation' } as Record<string, unknown> };
        expect(typeof integration.processSegmentSpan).toBe('function');
        integration.processSegmentSpan(span);
        expect(JSON.stringify(span)).toContain(token);
        const scrubbedSpan = JSON.stringify(scrubPasswordRecoveryEvent(span));
        expect(scrubbedSpan).not.toContain(token);
        expect(scrubbedSpan).not.toContain('Climber');
      } finally {
        Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
        if (originalReferrer) Object.defineProperty(document, 'referrer', originalReferrer);
        else Reflect.deleteProperty(document, 'referrer');
      }
    },
  );
});
