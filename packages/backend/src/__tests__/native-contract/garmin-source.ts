import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { recordedSource, type GarminRecording } from './recordings';

type Scope = Record<string, unknown>;

/**
 * Bounded source replay, not a Monkey C runtime or hardware claim. The recorded
 * function body is unchanged except syntax spelling: types, array size/add,
 * dictionary/string/array type predicates and `"key" =>` dictionary keys.
 * Unknown syntax fails JavaScript parsing. No SDK, simulator, Attention,
 * test-function invocation, or FIT I/O is involved.
 */
export function garminFunction(recording: GarminRecording, path: string, name: string, scope: Scope) {
  return replayGarminFunction(
    recordedSource(recording, `garmin/source/${path}`),
    `${recording.name}:${path}`,
    name,
    scope,
  );
}

/**
 * The same replay over the CURRENT checkout's source, for pure functions that
 * have no recorded checkpoint yet. It proves only what the recorded replay
 * proves, for the source in this tree.
 */
export function currentGarminFunction(path: string, name: string, scope: Scope) {
  const source = readFileSync(new URL(`../../../../../garmin/source/${path}`, import.meta.url), 'utf8');
  return replayGarminFunction(source, `current:${path}`, name, scope);
}

function replayGarminFunction(source: string, label: string, name: string, scope: Scope) {
  // Tokenize comments/strings before locating balanced function braces, so
  // GraphQL literals and comment braces cannot truncate the recorded function.
  const tokenPattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\s+|./g;
  const tokens = [...source.matchAll(tokenPattern)].map((match) => ({ text: match[0], start: match.index }));
  const significant = tokens.filter((token) => !/^\s|^\/\//.test(token.text) && !token.text.startsWith('/*'));
  const declaration = significant.findIndex(
    (token, index) => token.text === 'function' && significant[index + 1]?.text === name,
  );
  if (declaration < 0) throw new Error(`Garmin recorded function absent: ${name}`);
  let opening = declaration;
  while (significant[opening]?.text !== '{') opening += 1;
  if (!significant[opening]) throw new Error('Garmin function opening absent');
  let depth = 1;
  let closing = opening;
  while (depth && significant[++closing]) {
    if (significant[closing].text === '{') depth += 1;
    if (significant[closing].text === '}') depth -= 1;
  }
  if (depth) throw new Error('Garmin function closing absent');
  const header = source.slice(significant[declaration + 1].start, significant[opening].start);
  const parameters = header
    .slice(header.indexOf('(') + 1, header.lastIndexOf(')'))
    .replace(/\s+as\s+[\w.]+(?:\s+or\s+[\w.]+)*/g, '');
  let body = tokens
    .filter((token) => token.start > significant[opening].start && token.start < significant[closing].start)
    .map((token) => (token.text.startsWith('//') || token.text.startsWith('/*') ? ' ' : token.text))
    .join('');
  body = body
    .replace(/\s+as\s+[\w.]+(?:\s+or\s+[\w.]+)*/g, '')
    .replace(/([\w.]+(?:\["[^"\n]+"\])?)\s+instanceof\s+Lang\.Dictionary/g, '__dictionary($1)')
    .replace(/([\w.]+(?:\["[^"\n]+"\])?)\s+instanceof\s+Lang\.String/g, '(typeof $1 === "string")')
    .replace(/([\w.]+(?:\["[^"\n]+"\])?)\s+instanceof\s+Lang\.Array/g, 'Array.isArray($1)')
    .replace(/("(?:\\.|[^"\\\n])*")\s*=>/g, '$1:')
    .replace(/\.size\(\)|\.length\(\)/g, '.length')
    .replace(/\.add\(/g, '.push(');
  // The bound object has a reserved name: recorded parameters such as
  // AuthState.empty(scope, revision) must not shadow it.
  const context = createContext({
    __recordedScope: scope,
    __dictionary: (candidate: unknown) =>
      candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
  });
  new Script('String.prototype.equals = function(other) { return String(this) === other; };').runInContext(context);
  const replay = new Script(`(function (${parameters}) { with (__recordedScope) { ${body} } })`, {
    filename: `${label}:${name}`,
  }).runInContext(context) as (...arguments_: unknown[]) => unknown;
  return (...arguments_: unknown[]) => Reflect.apply(replay, undefined, arguments_);
}
