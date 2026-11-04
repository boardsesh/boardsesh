import type { PasswordReply, RegisterReply } from '@boardsesh/auth-protocol';

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
  let phase: 'input' | 'load' | 'register' | 'password' = 'input';
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
            ? registered.mailPlan.recipient === request.email && registered.mailPlan.identifier === request.email
            : null,
      },
      0,
    );
  })().catch(() => complete({ ok: false, phase }, 1));
});
