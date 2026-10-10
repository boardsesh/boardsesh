import type { AppleAdsAttributionResult, AppleAdsAttributionStatus } from '@boardsesh/shared-schema';
import { normalizeAppleAdsAttributionPayload } from '@boardsesh/shared-schema/apple-ads-attribution';

const APPLE_ADSERVICES_URL = 'https://api-adservices.apple.com/api/v1/';
export const APPLE_ADS_EXCHANGE_TIMEOUT_MS = 5_000;
export const APPLE_ADS_TOKEN_MAX_BYTES = 16 * 1024;
const APPLE_ADS_RESPONSE_MAX_BYTES = 16 * 1024;

export function appleAdsTerminalResult(
  status: Exclude<AppleAdsAttributionStatus, 'RETRYABLE' | 'ATTRIBUTED'>,
): AppleAdsAttributionResult {
  return { status, attribution: null, retryAfterSeconds: null, retryReason: null };
}

function unavailableResult(): AppleAdsAttributionResult {
  return { status: 'RETRYABLE', attribution: null, retryAfterSeconds: 5, retryReason: 'unavailable' };
}

/** Read the stream under a byte cap, even when Apple supplies no content-length. */
async function readAttributionResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > APPLE_ADS_RESPONSE_MAX_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error('Apple Ads response exceeded its limit or was empty');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > APPLE_ADS_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Apple Ads response exceeded its limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/**
 * One bounded exchange. The caller owns retries and consent cancellation.
 * Raw tokens, upstream bodies and exceptions never reach logs or telemetry.
 */
export async function exchangeAppleAdsToken(token: string): Promise<AppleAdsAttributionResult> {
  if (token.length === 0 || Buffer.byteLength(token, 'utf8') > APPLE_ADS_TOKEN_MAX_BYTES || /\s/.test(token)) {
    return appleAdsTerminalResult('INVALID_TOKEN');
  }

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error('Apple Ads exchange timed out'));
    }, APPLE_ADS_EXCHANGE_TIMEOUT_MS);
  });
  try {
    const exchange = async (): Promise<AppleAdsAttributionResult> => {
      const response = await fetch(APPLE_ADSERVICES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Accept: 'application/json' },
        body: token,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        // Do not read Apple's error body: it can contain sensitive request data.
        await response.body?.cancel();
        if (response.status === 400) return appleAdsTerminalResult('INVALID_TOKEN');
        if (response.status === 404) {
          return { status: 'RETRYABLE', attribution: null, retryAfterSeconds: 5, retryReason: 'not_ready' };
        }
        return unavailableResult();
      }
      return normalizeAppleAdsAttributionPayload(await readAttributionResponse(response));
    };
    return await Promise.race([exchange(), timeout]);
  } catch {
    // fetch errors and JSON syntax errors can embed request/response content.
    return unavailableResult();
  } finally {
    clearTimeout(timeoutHandle);
  }
}
