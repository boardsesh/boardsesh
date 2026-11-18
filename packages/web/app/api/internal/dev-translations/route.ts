import { NextResponse } from 'next/server';
import { devEditorHostnames } from '@/app/lib/i18n/dev-editor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const responseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

function rejectRequest(request: Request): Response | undefined {
  if (process.env.NODE_ENV !== 'development') return new Response(null, { status: 404 });
  const requestUrl = new URL(request.url);
  // A development server can listen on every interface. Only expose filesystem
  // editing through loopback or exact hostnames configured by its launcher.
  const authority = request.headers.get('host') ?? '';
  // Next may build request.url from its bind address instead of the browser's
  // hostname. Validate the actual Host against our explicit allowlist, never
  // X-Forwarded-Host. Reject malformed authorities before constructing an origin.
  if (!authority || /[\s/\\@?#]/.test(authority)) return new Response(null, { status: 403 });
  let browserUrl: URL;
  try {
    browserUrl = new URL(`${requestUrl.protocol}//${authority}`);
  } catch {
    return new Response(null, { status: 403 });
  }
  if (
    browserUrl.host !== authority ||
    !devEditorHostnames(process.env.DEV_ALLOWED_ORIGINS).includes(browserUrl.hostname)
  ) {
    return new Response(null, { status: 403 });
  }
  const origin = request.headers.get('origin');
  if (
    (origin && origin !== browserUrl.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.method === 'POST' && origin !== browserUrl.origin)
  ) {
    return new Response(null, { status: 403 });
  }
}

export async function GET(request: Request) {
  const rejected = rejectRequest(request);
  if (rejected) return rejected;
  const { readDevEntries, CatalogEditError } = await import('@/app/lib/i18n/dev-catalog-store');
  try {
    return NextResponse.json(
      { entries: await readDevEntries(new URL(request.url).searchParams.get('locale') ?? '') },
      { headers: responseHeaders },
    );
  } catch (error) {
    return NextResponse.json(
      {},
      { status: error instanceof CatalogEditError ? error.status : 500, headers: responseHeaders },
    );
  }
}

export async function POST(request: Request) {
  const rejected = rejectRequest(request);
  if (rejected) return rejected;
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return new Response(null, { status: 415 });
  // Bound chunked bodies too, before parsing or importing filesystem tooling.
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(chunk.value);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { saveDevTranslation, CatalogEditError } = await import('@/app/lib/i18n/dev-catalog-store');
    try {
      await saveDevTranslation(input);
      return NextResponse.json({ saved: true }, { headers: responseHeaders });
    } catch (error) {
      return NextResponse.json(
        {},
        { status: error instanceof CatalogEditError ? error.status : 500, headers: responseHeaders },
      );
    }
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    reader.releaseLock();
  }
}
