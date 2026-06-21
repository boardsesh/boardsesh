export type MoonBoardMarker = {
  Name: string;
  Description?: string | null;
  Image?: string | null;
  Latitude: number | null;
  Longitude: number | null;
  IsCommercial?: boolean | null;
  IsLed?: boolean | null;
  LatLng?: [number, number] | null;
};

const MOONBOARD_HOST = 'https://moonboard.com';
const REQUEST_TIMEOUT_MS = 30000;

function setCookieValues(headers: Headers): string[] {
  const headerWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headerWithGetSetCookie.getSetCookie === 'function') {
    return headerWithGetSetCookie.getSetCookie();
  }
  const header = headers.get('set-cookie');
  return header ? [header] : [];
}

export function parseSetCookieHeaders(headers: string[]): string[] {
  const cookies: string[] = [];
  for (const header of headers) {
    const parts = header.split(/,(?=\s*[^;,=\s]+\s*=)/);
    for (const part of parts) {
      const nameValue = part.trim().split(';')[0]?.trim();
      if (nameValue && nameValue.includes('=')) {
        cookies.push(nameValue);
      }
    }
  }
  return cookies;
}

function upsertCookies(existingCookies: string[], nextCookies: string[]): string[] {
  const cookieByName = new Map<string, string>();
  for (const cookie of existingCookies) {
    const [name] = cookie.split('=');
    if (name) {
      cookieByName.set(name, cookie);
    }
  }
  for (const cookie of nextCookies) {
    const [name] = cookie.split('=');
    if (name) {
      cookieByName.set(name, cookie);
    }
  }
  return [...cookieByName.values()];
}

function inputAttributes(inputTag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of inputTag.matchAll(attributePattern)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (name) {
      attributes[name] = value;
    }
  }
  return attributes;
}

function extractInputValue(formContent: string, name: string): string | null {
  for (const match of formContent.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = inputAttributes(match[0]);
    if (attributes.name === name) {
      return attributes.value ?? '';
    }
  }
  return null;
}

function containsLoginForm(responseText: string): boolean {
  return /<form\b[^>]*id\s*=\s*["']frmLogin["'][^>]*>/i.test(responseText);
}

async function assertNotLoginForm(response: Response, context: string): Promise<void> {
  const text = await response.text();
  if (containsLoginForm(text)) {
    throw new Error(`MoonBoard login failed: still on login form after ${context}`);
  }
}

export class MoonBoardClient {
  private readonly host: string;
  private sessionCookies: string[] = [];
  private authenticated = false;

  constructor(host: string = MOONBOARD_HOST) {
    this.host = host;
  }

  private storeResponseCookies(response: Response): void {
    const nextCookies = parseSetCookieHeaders(setCookieValues(response.headers));
    this.sessionCookies = upsertCookies(this.sessionCookies, nextCookies);
  }

  private cookieHeader(): string {
    return this.sessionCookies.join('; ');
  }

  async authenticate(username: string, password: string): Promise<void> {
    const loginPageResponse = await fetch(`${this.host}/account/login`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!loginPageResponse.ok) {
      throw new Error(`MoonBoard login page failed: ${loginPageResponse.status}`);
    }
    this.storeResponseCookies(loginPageResponse);
    const loginPageText = await loginPageResponse.text();
    const formMatch = loginPageText.match(/<form\b[^>]*id\s*=\s*["']frmLogin["'][^>]*>([\s\S]*?)<\/form>/i);
    if (!formMatch?.[1]) {
      throw new Error("Could not find MoonBoard login form with id='frmLogin'");
    }

    const verificationToken = extractInputValue(formMatch[1], '__RequestVerificationToken');
    const formKey = extractInputValue(formMatch[1], 'form_key');
    if (!verificationToken || !formKey) {
      throw new Error('Could not extract MoonBoard CSRF tokens');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${this.host}/account/login`,
    };
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const loginResponse = await fetch(`${this.host}/Account/login`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        'Login.Username': username,
        'Login.Password': password,
        __RequestVerificationToken: verificationToken,
        form_key: formKey,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.storeResponseCookies(loginResponse);

    if (loginResponse.status >= 300 && loginResponse.status < 400) {
      const redirectLocation = loginResponse.headers.get('location');
      if (!redirectLocation) {
        throw new Error('MoonBoard login redirect missing Location header');
      }
      const redirectUrl = redirectLocation.startsWith('/') ? `${this.host}${redirectLocation}` : redirectLocation;
      const redirectResponse = await fetch(redirectUrl, {
        method: 'GET',
        headers: { Cookie: this.cookieHeader() },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.storeResponseCookies(redirectResponse);
      if (!redirectResponse.ok) {
        throw new Error(`MoonBoard login redirect failed: ${redirectResponse.status}`);
      }
      await assertNotLoginForm(redirectResponse, 'redirect');
    } else if (!loginResponse.ok) {
      throw new Error(`MoonBoard login failed: ${loginResponse.status}`);
    } else {
      await assertNotLoginForm(loginResponse, 'submit');
    }

    this.authenticated = true;
  }

  async getMapMarkers(): Promise<MoonBoardMarker[]> {
    if (!this.authenticated) {
      throw new Error('MoonBoard authentication required before fetching map markers');
    }

    const response = await fetch(`${this.host}/MoonBoard/GetMapMarkers`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Boardsesh MoonBoard sync',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: this.cookieHeader(),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const respondedJson = response.headers.get('x-responded-json');
    if (respondedJson) {
      const parsedHeader = JSON.parse(respondedJson) as unknown;
      if (
        typeof parsedHeader === 'object' &&
        parsedHeader !== null &&
        'status' in parsedHeader &&
        parsedHeader.status === 401
      ) {
        throw new Error('MoonBoard map markers request was not authenticated');
      }
    }

    if (!response.ok) {
      throw new Error(`MoonBoard map markers failed: ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      return [];
    }
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('MoonBoard map markers response was not an array');
    }
    return parsed as MoonBoardMarker[];
  }
}
