import { describe, expect, it } from 'vite-plus/test';
import { redactPasswordRecoveryUrls, scrubPasswordRecoveryEvent } from '../index';

const token = 'a363934b-b7ba-41ba-a279-52185daa100e';
const email = 'Climber+tag@example.test';
const url = `https://www.boardsesh.test/auth/reset-password?token=${token}&email=${encodeURIComponent(email)}&src=mail`;

describe('password recovery telemetry capabilities', () => {
  it.each(['/auth/reset-password', '/fr/auth/reset-password/', '/app/auth/reset-password', '/api/auth/reset-password'])(
    'scrubs the entire capability query and fragment on %s',
    (path) => {
      const result = redactPasswordRecoveryUrls(
        `${path}?%74oken=${token}&%65mail=${encodeURIComponent(email)}&angle=40&src=mail#help`,
      );
      expect(result).not.toContain(token);
      expect(result).not.toContain('Climber');
      expect(result).toBe(`${path}?[redacted]`);
    },
  );
  it.each([0, 1, 2, 3, 6, 12])('scrubs recovery URLs nested through %i encoding layers', (depth) => {
    let nested = url.replace('token=', '%74oken=').replace('email=', '%65mail=');
    for (let index = 0; index < depth; index += 1) nested = encodeURIComponent(nested);
    const result = redactPasswordRecoveryUrls(`/auth/login?callbackUrl=${nested}`);
    expect(result).not.toContain(token);
    expect(result).not.toContain('Climber');
    expect(result).not.toContain('src');
  });
  it.each(['/api/auth/verify-email', '/fr/api/auth/verify-email/', '/app/auth/verify-email'])(
    'drops the whole verification query on %s',
    (path) => {
      const verificationToken = `ev1_${'B'.repeat(43)}`;
      const result = redactPasswordRecoveryUrls(
        `${path}?token=${verificationToken}&email=${encodeURIComponent(email)}&src=mail`,
      );
      expect(result).toBe(`${path}?[redacted]`);
    },
  );
  it('masks a versioned verification token in free text and in event request fields', () => {
    const verificationToken = `ev1_${'B'.repeat(43)}`;
    const verificationUrl = `https://www.boardsesh.test/api/auth/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}`;
    expect(redactPasswordRecoveryUrls(`Link rejected: ${verificationToken}`)).toBe('Link rejected: [redacted]');
    const scrubbed = scrubPasswordRecoveryEvent({
      request: { url: verificationUrl, query_string: `token=${verificationToken}&email=${email}` },
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(verificationToken);
    expect(serialized).not.toContain('Climber');
    expect(scrubbed.request.query_string).toBe('[redacted]');
  });
  it('leaves words that only end in the verification prefix and similar paths alone', () => {
    for (const original of ['dev1_build-flag', 'prev1_snapshot', '/api/auth/verify-email-sent?email=public']) {
      expect(redactPasswordRecoveryUrls(original)).toBe(original);
    }
  });
  it('scrubs duplicate/mixed-case names and secret-bearing fragments', () => {
    const result = redactPasswordRecoveryUrls(
      `/auth/reset-password?TOKEN=${token}&token=${token}&EMAIL=Climber#email=Climber&token=${token}`,
    );
    expect(result).not.toContain(token);
    expect(result).not.toContain('Climber');
  });
  it('preserves unrelated query names, values and encoding exactly', () => {
    for (const original of [
      '/search?email=public%40example.test&token=lexical-token&angle=40',
      '/auth/reset-password-other?token=ordinary&email=ordinary',
      '/gym?callbackUrl=%2Fsearch%3Femail%3Dpublic%2540example.test',
    ])
      expect(redactPasswordRecoveryUrls(original)).toBe(original);
  });
  it('scrubs request query/body, navigation/referrer and span fields while preserving normal identity fields', () => {
    const event = {
      request: {
        url,
        query_string: `token=${token}&email=${email}&src=mail`,
        data: { token, email, password: 'raw-password', confirmPassword: 'raw-password' },
      },
      breadcrumbs: [{ data: { from: url, to: '/auth/login' } }],
      spans: [{ description: `GET ${url}`, data: { 'url.full': url, 'http.url': url } }],
      properties: { $current_url: url, $referrer: url, $set_once: { $initial_referrer: url } },
      user: { email: 'consented-profile@example.test' },
    };
    const scrubbed = scrubPasswordRecoveryEvent(event);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('Climber');
    expect(serialized).not.toContain('raw-password');
    expect(scrubbed.user.email).toBe('consented-profile@example.test');
    expect(scrubbed.request.query_string).toBe('[redacted]');
    expect(event.request.data.password).toBe('raw-password');
  });
  it('covers serialized credential bodies and private mail plans without scrubbing unrelated email properties', () => {
    const event = {
      body: JSON.stringify({ token, email, password: 'submitted' }),
      mailPlan: { token: `pr1_${'A'.repeat(43)}`, recipient: email },
      user: { email: 'normal@example.test' },
    };
    const result = JSON.stringify(scrubPasswordRecoveryEvent(event));
    expect(result).not.toContain(token);
    expect(result).not.toContain('Climber');
    expect(result).not.toContain('submitted');
    expect(result).not.toContain('A'.repeat(43));
    expect(result).toContain('normal@example.test');
  });
  it('retains Date values, harmless references and redacts every edge of a cycle', () => {
    const date = new Date();
    const harmless = { date, url: '/search?email=normal' };
    expect(scrubPasswordRecoveryEvent(harmless)).toBe(harmless);
    const event: { url: string; date: Date; self?: unknown } = { url, date };
    event.self = event;
    const result = scrubPasswordRecoveryEvent(event);
    expect(result).not.toBe(event);
    expect(result.self).toBe(result);
    expect(result.date).toBe(date);
    expect(result.url).not.toContain(token);
  });
  it('redacts a forgot body and every alias even when an ordinary path was visited first', () => {
    const shared = { token, email };
    const event = { extra: shared, request: { url: '/api/auth/reset-password', data: shared } };
    expect(JSON.stringify(scrubPasswordRecoveryEvent(event))).not.toContain(token);
    expect(JSON.stringify(scrubPasswordRecoveryEvent(event))).not.toContain(email);
    const forgot = { request: { url: '/api/auth/forgot-password', data: { email } } };
    expect(JSON.stringify(scrubPasswordRecoveryEvent(forgot))).not.toContain(email);
  });
  it('redacts detached query-string tuples using their associated request URL', () => {
    const event = {
      request: {
        url: '/auth/reset-password',
        query_string: [
          ['token', token],
          ['email', email],
          ['src', 'mail'],
        ],
      },
    };
    const result = scrubPasswordRecoveryEvent(event);
    expect(result.request.query_string).toBe('[redacted]');
  });
  it('redacts detached supported span query and fragment aliases with a queryless recovery URL', () => {
    const event = {
      data: {
        'url.full': '/auth/reset-password',
        'http.query': `token=${token}&email=${email}&src=mail`,
        'url.fragment': `token=${token}&email=${email}`,
      },
    };
    const result = JSON.stringify(scrubPasswordRecoveryEvent(event));
    expect(result).not.toContain(token);
    expect(result).not.toContain(email);
    expect(result).not.toContain('src=mail');
  });
  it('discovers tuple query context before reusing an earlier ordinary alias', () => {
    const query = [
      ['token', token],
      ['email', email],
      ['src', 'mail'],
    ];
    const event = { extra: query, request: { url: '/auth/reset-password', query_string: query } };
    const result = scrubPasswordRecoveryEvent(event);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(email);
    expect(result.extra).toBe(result.request.query_string);
    expect(result.extra).toBe('[redacted]');
  });
  it('handles overlapping escapes with linear decoding and encoded object-query names', () => {
    const sensitiveName = `%${'%3'.repeat(12000)}7%34oken`;
    const original = `/auth/reset-password?${sensitiveName}=${token}&%65mail=${encodeURIComponent(email)}&src=mail`;
    const result = redactPasswordRecoveryUrls(original);
    expect(result).not.toContain(token);
    expect(result).not.toContain('Climber');
    expect(result).not.toContain('src=mail');
    const query = { [sensitiveName]: token, '%65mail': email, src: 'mail' };
    const event = { extra: query, request: { url: '/auth/reset-password', query_string: query } };
    const scrubbed = scrubPasswordRecoveryEvent(event);
    expect(JSON.stringify(scrubbed)).not.toContain(token);
    expect(JSON.stringify(scrubbed)).not.toContain(email);
    expect(scrubbed.request.query_string).toBe('[redacted]');
    const body = { [sensitiveName]: token, '%65mail': email, src: 'mail' };
    const bodyEvent = { extra: body, request: { url: '/api/auth/reset-password', data: body } };
    const bodyResult = scrubPasswordRecoveryEvent(bodyEvent);
    expect(JSON.stringify(bodyResult)).not.toContain(token);
    expect(JSON.stringify(bodyResult)).not.toContain(email);
    expect(bodyResult.request.data.src).toBe('mail');
  });
  it('keeps large malformed ordinary names harmless and conservatively redacts oversized recovery markers', () => {
    const ordinaryName = `${'%3'.repeat(12000)}1`;
    expect(redactPasswordRecoveryUrls(`/search?${ordinaryName}=ordinary`)).toBe(`/search?${ordinaryName}=ordinary`);
    const ordinaryRecovery = redactPasswordRecoveryUrls(
      `/auth/reset-password?${ordinaryName}=ordinary&email=${encodeURIComponent(email)}`,
    );
    expect(ordinaryRecovery).toBe('/auth/reset-password?[redacted]');
    expect(ordinaryRecovery).not.toContain('Climber');
    let nested = `/auth/reset-password?token=${token}&email=${encodeURIComponent(email)}&src=mail`;
    for (let depth = 0; depth < 1000; depth += 1) nested = encodeURIComponent(nested);
    const redacted = redactPasswordRecoveryUrls(nested);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain('Climber');
    expect(redacted).toContain('[redacted]');
  });
  it.each(['raw', 'deep', 'overlapping'] as const)(
    'uses one%s-name policy across every SDK recovery container and object alias',
    (encoding) => {
      let tokenName = encoding === 'raw' ? 'token' : '%74oken';
      let emailName = encoding === 'raw' ? 'email' : '%65mail';
      if (encoding === 'deep')
        for (let depth = 0; depth < 12; depth += 1) {
          tokenName = encodeURIComponent(tokenName);
          emailName = encodeURIComponent(emailName);
        }
      if (encoding === 'overlapping') {
        tokenName = `%${'%3'.repeat(128)}7%34oken`;
        emailName = `%${'%3'.repeat(128)}6%35mail`;
      }
      const query = `${tokenName}=${token}&${emailName}=${encodeURIComponent(email)}&%73rc=spring+sale%20kept`;
      for (const shape of ['url', 'string', 'tuples', 'object', 'body', 'serialized'] as const) {
        const fields = { [tokenName]: token, [emailName]: email, '%73rc': 'spring+sale%20kept' };
        const payload: unknown =
          shape === 'string'
            ? query
            : shape === 'tuples'
              ? Object.entries(fields)
              : shape === 'serialized'
                ? JSON.stringify(fields)
                : fields;
        const request =
          shape === 'url'
            ? { url: `/auth/reset-password?${query}` }
            : {
                url: '/api/auth/reset-password',
                [shape === 'body' || shape === 'serialized' ? 'data' : 'query_string']: payload,
              };
        const event = {
          ...(typeof payload === 'object' && payload !== null && shape !== 'url' ? { extra: payload } : {}),
          request,
          user: { email: 'ordinary-profile@example.test' },
        };
        const serialized = JSON.stringify(scrubPasswordRecoveryEvent(event));
        expect(serialized, `${encoding}/${shape}`).not.toContain(token);
        expect(serialized, `${encoding}/${shape}`).not.toContain('Climber');
        if (shape === 'body' || shape === 'serialized') expect(serialized).toContain('spring+sale%20kept');
        else expect(serialized).not.toContain('spring+sale%20kept');
        expect(serialized).toContain('ordinary-profile@example.test');
      }
    },
  );
  it.each([0, 1, 6])(
    'redacts recovery-inside-recovery and unassigned nested values at depth%i without interpretation',
    (depth) => {
      let inner = `/auth/reset-password?token=${token}&email=${encodeURIComponent(email)}&src=inner`;
      for (let index = 0; index < depth; index += 1) inner = encodeURIComponent(inner);
      for (const marker of ['?', '#']) {
        const outer = `/auth/reset-password${marker}token=outer-fixture&email=OuterMailbox&callbackUrl=${inner}&src=outer`;
        const result = redactPasswordRecoveryUrls(outer);
        expect(result).toBe(`/auth/reset-password${marker}[redacted]`);
        expect(result).not.toContain(token);
        expect(result).not.toContain('Climber');
        expect(redactPasswordRecoveryUrls(`/auth/reset-password${marker}${inner}`)).toBe(
          `/auth/reset-password${marker}[redacted]`,
        );
      }
    },
  );
  it('masks reserved capabilities in standalone exception text and otherwise unrelated URL fields', () => {
    const capability = `pr1_${'B'.repeat(43)}`;
    expect(redactPasswordRecoveryUrls(`Failure included ${capability}`)).toBe('Failure included [redacted]');
    expect(redactPasswordRecoveryUrls(`/search?reference=${capability}`)).toBe('/search?reference=[redacted]');
    const event = {
      exception: { values: [{ value: `Failure included ${capability}` }] },
      message: `future pr2_${'C'.repeat(43)}`,
    };
    const result = JSON.stringify(scrubPasswordRecoveryEvent(event));
    expect(result).not.toContain(capability);
    expect(result).not.toContain('C'.repeat(43));
  });
  it.each(
    [0, 1, 2, 3, 6, 12].flatMap((depth) =>
      [token, `pr1_${'A'.repeat(43)}`].map((capability) => ({ depth, capability })),
    ),
  )('redacts fragment-only outbound URL credentials at encoding depth$depth', ({ depth, capability }) => {
    let fragment = `/auth/reset-password#%74oken=${capability}&%65mail=${encodeURIComponent(email)}&src=mail`;
    for (let index = 0; index < depth; index += 1) fragment = encodeURIComponent(fragment);
    const result = redactPasswordRecoveryUrls(fragment);
    expect(result).not.toContain(capability);
    expect(result).not.toContain('Climber');
    expect(result).not.toContain('src');
  });
});

describe('partner OAuth sign-in and consent requests', () => {
  const signature = 'k7Jq2mVxP0sRt4wYb9nC1dEfGhIjKlMnOpQrStUvWx8';
  const state = 'app-state-8f3c2d1e';
  const signedQuery = `response_type=code&client_id=bsk_app&state=${state}&code_challenge=E9Melhoa2Ow&exp=1700000600&sig=${signature}`;

  it.each(['/oauth/consent', '/oauth/sign-in', '/de/oauth/consent/', 'https://www.boardsesh.com/es/oauth/sign-in'])(
    'drops the whole signed request on %s',
    (path) => {
      const result = redactPasswordRecoveryUrls(`${path}?${signedQuery}`);
      expect(result).toBe(`${path}?[redacted]`);
    },
  );

  it('drops it when the sign-in page rides encoded in a callbackUrl', () => {
    const result = redactPasswordRecoveryUrls(
      `/auth/login?callbackUrl=${encodeURIComponent(`/oauth/sign-in?${signedQuery}&error=Callback`)}`,
    );
    expect(result).not.toContain(signature);
    expect(result).not.toContain(state);
  });

  it('scrubs the request out of event URLs, breadcrumbs and a posted oauth_query body', () => {
    const pageUrl = `https://www.boardsesh.com/oauth/consent?${signedQuery}`;
    const scrubbed = scrubPasswordRecoveryEvent({
      request: { url: pageUrl, query_string: signedQuery },
      breadcrumbs: [{ category: 'navigation', data: { from: pageUrl, to: '/oauth/consent' } }],
      extra: { body: { accept: true, oauth_query: signedQuery } },
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(signature);
    expect(serialized).not.toContain(state);
    expect(scrubbed.request.query_string).toBe('[redacted]');
    expect(scrubbed.extra.body.accept).toBe(true);
  });

  it('leaves lookalike paths alone', () => {
    for (const original of [
      '/oauthentication?sig=public',
      '/oauth/consent-help?client_id=public',
      '/api/auth/oauth2/token',
    ]) {
      expect(redactPasswordRecoveryUrls(original)).toBe(original);
    }
  });
});
