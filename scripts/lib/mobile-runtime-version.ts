/// <reference types="node" />

export interface RuntimeVersionResult {
  runtimeVersion?: unknown;
  fingerprintSources?: unknown;
}

function isRuntimeVersionResult(candidate: unknown): candidate is RuntimeVersionResult {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'runtimeVersion' in candidate &&
    typeof candidate.runtimeVersion === 'string' &&
    'fingerprintSources' in candidate &&
    Array.isArray(candidate.fingerprintSources)
  );
}

export function parseResolverOutput(stdout: string): RuntimeVersionResult {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRuntimeVersionResult(parsed)) return parsed;
  } catch {
    // Resolver wrappers may print diagnostics before or after the JSON payload.
  }

  type ObjectCandidate = {
    start: number;
    hasRuntimeVersionKey: boolean;
    hasFingerprintSourcesKey: boolean;
  };

  const objectCandidates: ObjectCandidate[] = [];
  let insideString = false;
  let escaped = false;
  let stringStart = -1;
  let pendingKey: { candidate: ObjectCandidate; name: 'runtimeVersion' | 'fingerprintSources' } | undefined;
  let matchedResult: RuntimeVersionResult | null = null;
  let remainingParseBudget = trimmed.length * 2;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];

    if (insideString) {
      if (character === '\n' || character === '\r') {
        // JSON strings cannot contain raw newlines. Recover from an unmatched
        // quote in a diagnostic without discarding balanced objects spanning
        // otherwise-valid pretty-printed JSON lines.
        insideString = false;
        escaped = false;
        stringStart = -1;
        pendingKey = undefined;
        objectCandidates.length = 0;
      } else if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
        const rawString = trimmed.slice(stringStart + 1, index);
        const candidate = objectCandidates.at(-1);
        if (candidate && (rawString === 'runtimeVersion' || rawString === 'fingerprintSources')) {
          pendingKey = { candidate, name: rawString };
        }
        stringStart = -1;
      }
      continue;
    }

    if (pendingKey) {
      if (/\s/.test(character)) continue;
      if (character === ':' && objectCandidates.at(-1) === pendingKey.candidate) {
        if (pendingKey.name === 'runtimeVersion') pendingKey.candidate.hasRuntimeVersionKey = true;
        else pendingKey.candidate.hasFingerprintSourcesKey = true;
      }
      pendingKey = undefined;
    }

    if (character === '"') {
      insideString = true;
      stringStart = index;
      continue;
    }

    if (character === '{') {
      objectCandidates.push({
        start: index,
        hasRuntimeVersionKey: false,
        hasFingerprintSourcesKey: false,
      });
      continue;
    }
    if (character !== '}') continue;
    const completedCandidate = objectCandidates.pop();
    if (!completedCandidate) continue;
    if (!completedCandidate.hasRuntimeVersionKey || !completedCandidate.hasFingerprintSourcesKey) continue;

    const candidate = trimmed.slice(completedCandidate.start, index + 1);
    remainingParseBudget -= candidate.length;
    if (remainingParseBudget < 0) {
      throw new Error('Too many resolver-shaped JSON objects found in stdout');
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRuntimeVersionResult(parsed)) continue;
      if (matchedResult !== null) {
        throw new Error('Multiple runtimeVersion resolver JSON objects found in stdout');
      }
      matchedResult = parsed;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Multiple runtimeVersion')) throw error;
      // Keep scanning: a diagnostic may contain braces before the payload.
    }
  }

  if (matchedResult !== null) return matchedResult;
  throw new Error('Could not find a runtimeVersion resolver JSON object in stdout');
}
