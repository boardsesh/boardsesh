import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type CncGeneratorOperation = 'layout' | 'artwork' | 'preview' | 'full' | 'version';
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const envelope = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  buildSha: z.string().regex(/^[a-f0-9]{40}$/),
  generatorVersion: z.string().max(100),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), retryable: z.boolean() })
    .passthrough()
    .optional(),
});
export class CncGeneratorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'CncGeneratorError';
  }
}

/** No shell, HTTP listener, or child stdout/stderr logging: full results contain private marks. */
export async function runCncGenerator(
  operation: CncGeneratorOperation,
  payload: Record<string, unknown>,
  assets: Record<string, string>,
  signal: AbortSignal,
): Promise<{ buildSha: string; generatorVersion: string; result: Record<string, unknown> }> {
  signal.throwIfAborted();
  const requestId = randomUUID();
  const input = JSON.stringify({ protocolVersion: 1, requestId, operation, payload, assets });
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw new CncGeneratorError('INPUT_TOO_LARGE', false);
  const executable = process.env.CNC_GENERATOR_PYTHON || '/app/.venv/bin/python';
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['-m', 'cncpack.worker.task'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // Never give the renderer database, email, signing or provider credentials.
      env: {
        NODE_ENV: process.env.NODE_ENV,
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              [
                'PATH',
                'HOME',
                'MPLCONFIGDIR',
                'MPLBACKEND',
                'XDG_CACHE_HOME',
                'GIT_SHA',
                'FINGERPRINT_SECRET',
                'LANG',
                'LC_ALL',
              ].includes(key) || key.startsWith('PRIVATE_'),
          ),
        ),
      },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stopped = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceKill.unref();
    };
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESULT_BYTES) terminate();
      else chunks.push(chunk);
    });
    // Drain stderr without retaining potentially sensitive library errors.
    child.stderr.resume();
    child.stdin.on('error', () => terminate());
    child.on('error', () => reject(new CncGeneratorError('GENERATOR_START_FAILED', true)));
    child.on('close', (code) => {
      signal.removeEventListener('abort', terminate);
      clearTimeout(forceKill);
      if (signal.aborted) reject(new CncGeneratorError('GENERATOR_ABORTED', true));
      else if (outputBytes > MAX_RESULT_BYTES) reject(new CncGeneratorError('RESULT_TOO_LARGE', false));
      else if (code !== 0) reject(new CncGeneratorError('GENERATOR_FAILED', true));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(result);
  } catch {
    throw new CncGeneratorError('INVALID_GENERATOR_RESULT', true);
  }
  const parsed = envelope.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.requestId !== requestId ||
    parsed.data.buildSha !== process.env.CNC_GENERATOR_SHA
  ) {
    throw new CncGeneratorError('GENERATOR_RELEASE_MISMATCH', false);
  }
  if (!parsed.data.ok)
    throw new CncGeneratorError(parsed.data.error?.code ?? 'GENERATOR_FAILED', parsed.data.error?.retryable ?? true);
  if (!parsed.data.result) throw new CncGeneratorError('INVALID_GENERATOR_RESULT', false);
  return { buildSha: parsed.data.buildSha, generatorVersion: parsed.data.generatorVersion, result: parsed.data.result };
}
