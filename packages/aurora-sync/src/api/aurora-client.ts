import { auroraUserAgent, type LoginResponse, type Session, type ClientOptions, HOST_BASES } from './types';
import {
  assertAuroraResponseOk,
  createAuroraInvalidResponseError,
  createAuroraNetworkError,
  createAuroraTimeoutError,
  isAuroraRequestError,
} from './errors';

/**
 * Aurora Climbing API Client
 */
export class AuroraClimbingClient {
  private baseURL: string;
  private readonly boardName: ClientOptions['boardName'];
  private token: string | null;
  private session: Session | null;
  private apiVersion: string;

  constructor({ boardName, token = null, apiVersion = 'v1' }: ClientOptions) {
    this.token = token;
    this.session = null;
    this.apiVersion = apiVersion;
    this.boardName = boardName;
    this.baseURL = `${HOST_BASES[boardName]}.com`;
  }

  setSession(session: Session): void {
    this.session = session;
    this.token = session.token;
  }

  getUserId(): number | null {
    return this.session?.user_id || null;
  }

  private createHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': contentType || 'application/x-www-form-urlencoded',
      Connection: 'keep-alive',
      'Accept-Language': 'en-AU,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': auroraUserAgent(this.boardName),
    };

    if (this.token) {
      headers['Cookie'] = `token=${this.token}`;
    }

    return headers;
  }

  private async request<T>(
    endpoint: string,
    fetchOptions: RequestInit = {},
    options: { apiUrl: boolean } = { apiUrl: false },
  ): Promise<T> {
    const url = `https://${options.apiUrl ? 'api.' : ''}${this.baseURL}${options.apiUrl ? `/${this.apiVersion}` : ''}${endpoint}`;

    try {
      const contentType =
        fetchOptions.headers && typeof fetchOptions.headers === 'object' && !Array.isArray(fetchOptions.headers)
          ? (fetchOptions.headers as Record<string, string>)['Content-Type']
          : undefined;

      const response = await fetch(url, {
        ...fetchOptions,
        headers: {
          ...this.createHeaders(contentType),
          ...((fetchOptions.headers as Record<string, string> | undefined) ?? {}),
        },
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      console.info(`Response status: ${response.status} ${response.statusText}`);

      await assertAuroraResponseOk(response, url, {
        invalidCredentialsMessage: 'Invalid username or password',
        rateLimitedMessage: 'Too many login attempts. Please try again later.',
      });

      try {
        return (await response.json()) as T;
      } catch (error) {
        throw createAuroraInvalidResponseError(url, error);
      }
    } catch (error) {
      console.error(`API request failed: ${endpoint}`, error);

      if (isAuroraRequestError(error)) {
        throw error;
      }

      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw createAuroraTimeoutError(url, error);
      }

      if (error instanceof TypeError) {
        throw createAuroraNetworkError(url, error);
      }

      throw error;
    }
  }

  async signIn(username: string, password: string): Promise<LoginResponse> {
    const data = await this.request<LoginResponse>(
      '/sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          tou: 'accepted',
          pp: 'accepted',
          ua: 'app',
        }),
      },
      { apiUrl: false },
    );

    if (data.session) {
      this.setSession({ token: data.session.token, user_id: data.session.user_id });

      return {
        token: data.session.token,
        user_id: data.session.user_id,
        username: username,
        error: '',
        login: {
          created_at: new Date().toISOString(),
          token: data.session.token,
          user_id: data.session.user_id,
        },
        user: {
          id: data.session.user_id,
          username: username,
          email_address: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          is_listed: true,
          is_public: true,
          avatar_image: null,
          banner_image: null,
          city: null,
          country: null,
          height: null,
          weight: null,
          wingspan: null,
        },
      };
    }

    if (data.token && data.user_id) {
      this.setSession({ token: data.token, user_id: data.user_id });
      return data;
    }

    throw new Error('Login failed: Invalid response format');
  }
}

export default AuroraClimbingClient;
