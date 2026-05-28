// aurora-api-client.ts

import { type ClientOptions, type LoginResponse, type Session, HOST_BASES } from './types';

/**
 * Aurora Climbing API Client
 */
class AuroraClimbingClient {
  private baseURL: string;
  private token: string | null;
  private session: Session | null;
  private apiVersion: string;

  /**
   * Create a new API client instance
   * @param options - Configuration options
   */
  constructor({ boardName, token = null, apiVersion = 'v1' }: ClientOptions) {
    this.token = token;
    this.session = null;
    this.apiVersion = apiVersion;
    this.baseURL = `${HOST_BASES[boardName]}.com`;
  }

  /**
   * Set the authentication token
   * @param token - The authentication token
   */
  setSession(session: Session): void {
    this.session = session;
    this.token = session.token;
  }

  getUserId(): number | null {
    return this.session?.user_id || null;
  }

  /**
   * Create URL encoded form data from an object
   * @param data - Data to encode
   * @returns URL encoded string
   */
  private encodeFormData(data: Record<string, string | number | boolean | null | undefined>): string {
    return Object.keys(data)
      .map((key) => {
        if (data[key] === null || data[key] === undefined) {
          return '';
        }
        return `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`;
      })
      .filter((part) => part !== '')
      .join('&');
  }

  /**
   * Create request headers with authentication
   * @param contentType - Optional content type override
   * @returns Headers object
   */
  private createHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': contentType || 'application/x-www-form-urlencoded',
      Connection: 'keep-alive',
      'Accept-Language': 'en-AU,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': 'Kilter Board/202 CFNetwork/1568.100.1 Darwin/24.0.0',
    };

    if (this.token) {
      headers['Cookie'] = `token=${this.token}`;
    }

    return headers;
  }

  /**
   * Make an API request
   * @param endpoint - API endpoint
   * @param fetchOptions - Fetch options
   * @returns Response data
   */
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
          ...(fetchOptions.headers as Record<string, string> | undefined),
        },
        // Add timeout to prevent hanging requests
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      if (!response.ok) {
        const responseClone = response.clone();
        let errorData;
        try {
          errorData = await response.json();
        } catch {
          try {
            errorData = await responseClone.text();
          } catch {
            errorData = 'Could not read error response';
          }
        }
        console.error(`API Error - ${url}:`, {
          status: response.status,
          statusText: response.statusText,
          data: errorData,
        });
        throw new Error(
          JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            data: errorData,
            url: url,
          }),
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      console.error(`API request failed: ${endpoint}`, error);

      // Enhance error messages for common issues
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout: ${url} took longer than 30 seconds`);
        }
        if (error.message.includes('fetch')) {
          throw new Error(
            `Network error: Unable to connect to ${url}. Check internet connection and Aurora API status.`,
          );
        }
        if (error.message.includes('Failed to fetch')) {
          throw new Error(`DNS/Connection error: Cannot resolve ${url}. Aurora servers may be unavailable.`);
        }
      }

      throw error;
    }
  }

  // #region Authentication

  /**
   * Sign in to the Aurora Climbing API with username and password
   * @param username - Username
   * @param password - Password
   * @returns Session data including token
   */
  async signIn(username: string, password: string): Promise<LoginResponse> {
    try {
      // Use /sessions endpoint on web host only
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
        { apiUrl: false }, // Use web host only
      );

      // Handle session extraction - response might have a session object
      if (data.session) {
        this.setSession({ token: data.session.token, user_id: data.session.user_id });

        // Construct a response that matches the UI expectations
        return {
          token: data.session.token,
          user_id: data.session.user_id,
          username: username, // Use the provided username since API doesn't return it
          error: '', // No error
          login: {
            created_at: new Date().toISOString(), // Use current time since API doesn't provide it
            token: data.session.token,
            user_id: data.session.user_id,
          },
          user: {
            id: data.session.user_id,
            username: username,
            email_address: '', // These will be filled by subsequent API calls
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
      } else if (data.token && data.user_id) {
        this.setSession({ token: data.token, user_id: data.user_id });
        return data;
      }
      throw new Error('Login failed: Invalid response format');
    } catch (error) {
      // Parse error message
      if (typeof error === 'object' && error !== null && 'message' in error) {
        try {
          const errorObj = JSON.parse((error as Error).message);
          if (errorObj.status === 422) {
            throw new Error('Invalid username or password');
          } else if (errorObj.status === 429) {
            throw new Error('Too many login attempts. Please try again later.');
          }
        } catch {
          // If parsing fails, just throw the original error
        }
      }
      throw error;
    }
  }

  // #endregion
}

export default AuroraClimbingClient;
