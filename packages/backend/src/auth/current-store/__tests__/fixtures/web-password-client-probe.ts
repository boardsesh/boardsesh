import type { PasswordReply, RegisterReply } from '@boardsesh/auth-protocol';
import { sendVerificationEmail } from '@boardsesh/email';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import nodemailer from 'nodemailer';

// This child runs through the public tsx loader with Node's react-server
// condition. The web module's public server-only export is therefore valid.
// Dynamic URL avoids importing web app source into backend's production tsc
// rootDir. The real web module is separately checked by the web TS project.
interface WebClientModule {
  createPasswordCommandClient(options: { environment: Readonly<Record<string, string | undefined>> }): {
    register(payload: unknown): Promise<RegisterReply>;
    password(email: string, password: string): Promise<PasswordReply>;
  };
}
interface PublicVerifyModule {
  GET(request: unknown): Promise<Response>;
}

const timeout = setTimeout(() => process.exit(2), 15_000);
function complete(result: object, status: number) {
  clearTimeout(timeout);
  if (!process.send) {
    process.exit(status);
    return;
  }
  process.send(result, () => process.exit(status));
}

process.once('message', (message: unknown) => {
  let phase: 'input' | 'load' | 'register' | 'password' | 'mail' | 'public-verify' = 'input';
  void (async () => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid owned probe');
    const request = message as Record<string, unknown>;
    if (
      typeof request.origin !== 'string' ||
      typeof request.secret !== 'string' ||
      typeof request.email !== 'string' ||
      typeof request.password !== 'string'
    )
      throw new Error('Invalid owned probe');
    const origin = new URL(request.origin);
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
      throw new Error('Probe requires owned loopback');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin.origin,
      CURRENT_STORE_AUTH_RPC_SECRET: request.secret,
      // A versioned public reader must never query the web database. A
      // deliberately unreachable local URL makes accidental use fail closed.
      DATABASE_URL: 'postgresql://owned_probe:unused@127.0.0.1:1/owned_probe',
      READ_REPLICA_URL: 'postgresql://owned_probe:unused@127.0.0.1:1/owned_probe',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_USER: 'owned-probe@example.test',
      SMTP_PASSWORD: 'synthetic-offline-only',
    });
    const moduleUrl = new URL('../../../../../../web/app/lib/auth/password-command-client.server.ts', import.meta.url)
      .href;
    phase = 'load';
    const web = (await import(moduleUrl)) as WebClientModule;
    const client = web.createPasswordCommandClient({
      environment: {
        NODE_ENV: 'test',
        CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
        CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin.origin,
        CURRENT_STORE_AUTH_RPC_SECRET: request.secret,
      },
    });
    phase = 'register';
    const registered = await client.register({
      email: request.email,
      password: request.password,
      name: 'Actual web client probe',
    });
    phase = 'password';
    const authenticated = await client.password(request.email, request.password);
    const created = registered.outcome === 'created';
    const matched = authenticated.outcome === 'authenticated';
    let templateRoundTrip: boolean | null = null;
    let publicVerified: boolean | null = null;
    let publicPrivacy: boolean | null = null;
    let publicCookieUnchanged: boolean | null = null;
    let verifiedAfterLink: boolean | null = null;
    let verificationDiagnostic: object | undefined;
    if (created && registered.requiresVerification) {
      phase = 'mail';
      const offline = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
      let renderedHtml = '';
      let renderedText = '';
      offline.use('compile', (mail, done) => {
        renderedHtml = typeof mail.data.html === 'string' ? mail.data.html : '';
        renderedText = typeof mail.data.text === 'string' ? mail.data.text : '';
        done();
      });
      // Only SMTP I/O creation is replaced: the actual shared template,
      // address validation and public Nodemailer MIME pipeline still run.
      const replacement = mock.method(nodemailer, 'createTransport', () => offline);
      try {
        await sendVerificationEmail(registered.mailPlan.recipient, registered.mailPlan.token, origin.origin);
        const textLink = renderedText.match(/https?:\/\/[^\s]+/)?.[0];
        const htmlLink = renderedHtml.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
        if (!textLink || !htmlLink) throw new Error('Owned mail has no verification link');
        const link = new URL(textLink);
        templateRoundTrip =
          htmlLink === textLink &&
          link.searchParams.get('token') === registered.mailPlan.token &&
          link.searchParams.get('email') === request.email;
        phase = 'public-verify';
        const requireWeb = createRequire(new URL('../../../../../../web/package.json', import.meta.url));
        const next = requireWeb('next/server') as {
          NextRequest: new (url: string, options: { headers: Record<string, string> }) => { url: string };
        };
        const publicModuleUrl = new URL('../../../../../../web/app/api/auth/verify-email/route.ts', import.meta.url);
        const publicRoute = (await import(publicModuleUrl.href)) as PublicVerifyModule;
        const publicRequest = new next.NextRequest(link.href, {
          headers: { cookie: 'next-auth.session-token=owned-sibling-cookie' },
        });
        const response = await publicRoute.GET(publicRequest);
        // Public NextRequest normalizes loopback IPs to localhost. The route's
        // contract redirects relative to that actual public request URL.
        publicVerified =
          response.status === 307 &&
          response.headers.get('location') === new URL('/auth/login?verified=true', publicRequest.url).href;
        publicPrivacy =
          response.headers.get('cache-control') === 'private, no-store' &&
          response.headers.get('referrer-policy') === 'no-referrer';
        publicCookieUnchanged = !response.headers.has('set-cookie');
        if (!publicVerified) {
          const redirect = response.headers.get('location');
          const destination = redirect ? new URL(redirect, publicRequest.url) : undefined;
          const queryError = destination?.searchParams.get('error');
          verificationDiagnostic = {
            status: response.status,
            redirectOutcome: ['InvalidToken', 'TokenExpired', 'TooManyAttempts'].includes(queryError ?? '')
              ? queryError
              : 'other',
            modeStillActive: process.env.CURRENT_STORE_WEB_AUTH_MODE === 'backend-staging',
            nodeEnvironmentIsTest: process.env.NODE_ENV === 'test',
            originStillExpected: process.env.CURRENT_STORE_AUTH_BACKEND_ORIGIN === origin.origin,
            secretStillExpected: process.env.CURRENT_STORE_AUTH_RPC_SECRET === request.secret,
            secretMatchesNextAuth: process.env.CURRENT_STORE_AUTH_RPC_SECRET === process.env.NEXTAUTH_SECRET,
            secretMatchesCron: process.env.CURRENT_STORE_AUTH_RPC_SECRET === process.env.CRON_SECRET,
          };
        }
        const afterLink = await client.password(request.email, request.password);
        verifiedAfterLink =
          afterLink.outcome === 'authenticated' &&
          afterLink.user.id === registered.userId &&
          afterLink.verification.userId === registered.userId &&
          afterLink.verification.verified;
      } finally {
        replacement.mock.restore();
        offline.close();
      }
    }
    complete(
      {
        ok: created && matched,
        ownerMatches:
          created &&
          matched &&
          registered.userId === authenticated.user.id &&
          authenticated.verification.userId === registered.userId,
        requiresVerification: created ? registered.requiresVerification : null,
        verified: matched ? authenticated.verification.verified : null,
        mailIdentityMatches:
          created && registered.requiresVerification
            ? registered.mailPlan.recipient === request.email &&
              registered.mailPlan.kind === 'uid-email-verification-v1'
            : null,
        templateRoundTrip,
        publicVerified,
        publicPrivacy,
        publicCookieUnchanged,
        verifiedAfterLink,
        ...(verificationDiagnostic ? { verificationDiagnostic } : {}),
      },
      0,
    );
  })().catch(() => complete({ ok: false, phase }, 1));
});
