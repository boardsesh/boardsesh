import { DOMParser, XMLSerializer, type Element, type Node } from '@xmldom/xmldom';

/**
 * A buyer's SVG, audited and rewritten before it is ever stored.
 *
 * The file arrives from the public internet and ends its life inside a CNC
 * pack, so it passes through three untrusted hops: our bucket, the generator's
 * XML parser, and whatever CAM seat opens the DXF. This module is the only
 * place any of that is decided, and it decides by ALLOWLIST — an element that
 * is not named here is refused, rather than every dangerous element being
 * remembered.
 *
 * Two rules shape everything below.
 *
 * **The stored bytes are the re-serialised document, not the upload.** An
 * audit that passes the original file through leaves every construct the
 * parser tolerated but the auditor never looked at — a second root, a stray
 * DTD subset, an attribute in a namespace nobody read. Serialising the cleaned
 * tree means the bytes in the bucket are exactly the bytes this module built,
 * and the sha256 on the row is of those.
 *
 * **We are at least as strict as the generator.** `cncpack/geometry/svg.py`
 * re-audits the file when the job runs, and a rejection there is a paid order
 * that fails to build. So every limit it enforces is enforced here first, at a
 * value no looser: the same 2 MB ceiling, the same refusal of `DOCTYPE`,
 * `ENTITY`, stylesheet instructions, `on*` handlers and off-document
 * references. Where the two differ, this side is tighter — an allowlist rather
 * than the generator's blocklist, `viewBox` required rather than optional, and
 * no `url(` at all rather than `url(#fragment)`.
 */

/**
 * Biggest upload we will parse, matching `MAX_SVG_BYTES` in the generator's
 * `svg.py` exactly. A logo past this is a traced photo, and the generator would
 * refuse it after the buyer had paid.
 */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

/**
 * Most `<path>` elements one file may carry.
 *
 * The generator counts flattened SEGMENTS (50 000) rather than elements, which
 * it can only do after parsing every curve. Counting elements is the cheap
 * upstream proxy: 2000 paths is far more than any logo and still well under the
 * segment budget for anything that is genuinely a drawing rather than a trace.
 */
export const MAX_PATH_ELEMENTS = 2000;

/**
 * Total `d` attribute bytes. A single path with a megabyte of coordinates
 * passes the element count and still takes the flattener minutes.
 */
export const MAX_PATH_DATA_BYTES = 1024 * 1024;

/**
 * Elements a build pack may contain. Everything here is geometry, a container
 * for geometry, or an accessible name for it.
 *
 * Lowercased local names — SVG is case-sensitive and `clipPath` is spelled with
 * a capital P, so the comparison is done on a lowercased copy and the document
 * keeps its own spelling.
 *
 * Notable absences and why: `style` and `script` execute, `image` and `use`
 * fetch, `foreignObject` opens an HTML document inside the drawing, and every
 * `animate*` element makes the shape a function of time — which is not a thing
 * a router can cut. All of them are on the generator's own refusal list.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'clippath',
  'title',
  'desc',
]);

/**
 * Editor bookkeeping that is dropped rather than refused.
 *
 * `<metadata>` is where Inkscape parks an RDF block naming the author, the
 * licence and often the file's original path on someone's disk; `namedview` is
 * its canvas state. Neither is geometry, both are in every Inkscape export, and
 * refusing them would reject the most common way a buyer produces a logo. They
 * are removed with their subtrees, so nothing inside them is audited or stored.
 */
const STRIPPED_ELEMENTS: ReadonlySet<string> = new Set(['metadata', 'namedview']);

/**
 * Attributes whose value is a reference. Only a same-document `#fragment` is
 * allowed — the same rule, and the same list, as the generator's
 * `REFERENCE_ATTRIBUTES`.
 */
const REFERENCE_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'xlink:href', 'src', 'from', 'to']);

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_CDATA = 4;
const NODE_TYPE_PROCESSING_INSTRUCTION = 7;
const NODE_TYPE_COMMENT = 8;
const NODE_TYPE_DOCUMENT_TYPE = 10;

/** Why one upload was refused. A stable code, so a client can translate it. */
export type SvgRejectionReason =
  | 'empty'
  | 'too_large'
  | 'not_xml'
  | 'not_svg'
  | 'doctype'
  | 'processing_instruction'
  | 'disallowed_element'
  | 'event_handler'
  | 'external_reference'
  | 'disallowed_style'
  | 'missing_view_box'
  | 'too_many_paths'
  | 'path_data_too_large';

export type SvgSanitiseResult =
  | {
      ok: true;
      /** The cleaned document, re-serialised. THESE are the bytes to store. */
      svg: string;
      /** The root's `viewBox`, verbatim. The generator reads path data in these user units. */
      viewBox: string;
    }
  | {
      ok: false;
      reason: SvgRejectionReason;
      /** One English sentence. Safe to log and to return: it never quotes file content. */
      message: string;
    };

function reject(reason: SvgRejectionReason, message: string): SvgSanitiseResult {
  return { ok: false, reason, message };
}

/**
 * A cheap "does this claim to be an SVG at all" check on the raw upload.
 *
 * Deliberately separate from sanitising, and deliberately generous: its only
 * job is to route an upload to the SVG path rather than answer 415. A file that
 * gets past this and is then malformed, or carries a `DOCTYPE`, is a 422 naming
 * what is wrong — which is far more useful to the buyer than "unsupported
 * type".
 *
 * Skips a byte-order mark, an XML declaration and any leading comments, because
 * every editor emits at least the first two.
 */
export function looksLikeSvg(buffer: Buffer): boolean {
  const head = stripByteOrderMark(buffer.subarray(0, 4096).toString('utf8'));
  const withoutPreamble = head
    .replace(/^\s+/, '')
    .replace(/^<\?xml[\s\S]*?\?>/i, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/, '')
    .replace(/^\s*<!DOCTYPE[^>]*>/i, '')
    .replace(/^\s+/, '');
  return /^<svg[\s>]/i.test(withoutPreamble) || /^<[a-z]+:svg[\s>]/i.test(withoutPreamble);
}

/** A leading U+FEFF survives `toString('utf8')` and makes the XML parser fail on byte one. */
function stripByteOrderMark(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

/** `{http://www.w3.org/1999/xlink}href` never appears here — xmldom keeps the source prefix. */
function attributeKey(name: string): string {
  return name.toLowerCase();
}

function localNameOf(nodeName: string): string {
  const withoutPrefix = nodeName.includes(':') ? nodeName.slice(nodeName.indexOf(':') + 1) : nodeName;
  return withoutPrefix.toLowerCase();
}

/**
 * Audit one element's attributes.
 *
 * Returns a rejection or null. Every check runs against a lowercased name and
 * the raw value; nothing is rewritten, because an attribute worth repairing is
 * an attribute worth refusing — a silently corrected reference would cut a
 * shape the buyer never approved.
 */
function auditAttributes(element: Element, elementName: string): SvgSanitiseResult | null {
  const { attributes } = element;
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes.item(index);
    if (!attribute) continue;

    const name = attributeKey(attribute.name);
    const value = attribute.value;

    if (name.startsWith('on')) {
      return reject('event_handler', `<${elementName}> carries the event handler "${name}".`);
    }

    if (value.toLowerCase().includes('javascript:')) {
      return reject('external_reference', `<${elementName}> carries a javascript: reference.`);
    }

    // `url(` is refused outright rather than restricted to `url(#id)` the way
    // the generator does. A gradient or clip reference is the only legitimate
    // use, none of it survives into a routed toolpath, and the parenthesised
    // form is exactly where a same-document check is easiest to get subtly
    // wrong. Refusing the whole construct is one rule instead of two.
    if (value.toLowerCase().includes('url(')) {
      return reject('external_reference', `<${elementName}> uses url(), which a build pack may not reference.`);
    }

    if (name === 'style') {
      const style = value.toLowerCase();
      if (style.includes('expression(') || style.includes('@import')) {
        return reject('disallowed_style', `<${elementName}> carries a style attribute that pulls in outside content.`);
      }
    }

    if (REFERENCE_ATTRIBUTES.has(name) && !value.trim().startsWith('#')) {
      return reject(
        'external_reference',
        `<${elementName}> points "${name}" outside the document; only same-document #ids are allowed.`,
      );
    }
  }
  return null;
}

type WalkTally = { pathElements: number; pathDataBytes: number };

/**
 * Depth-first audit of one element and its subtree.
 *
 * Removals are collected and applied after the child loop rather than during
 * it: `childNodes` is live, so splicing while iterating silently skips the node
 * that slides into the vacated index — which for a stripped `<metadata>` would
 * mean its sibling never being audited at all.
 */
function walkElement(element: Element, tally: WalkTally): SvgSanitiseResult | null {
  const name = localNameOf(element.nodeName);

  if (!ALLOWED_ELEMENTS.has(name)) {
    return reject('disallowed_element', `<${name}> is not an element a build pack may contain.`);
  }

  const attributeProblem = auditAttributes(element, name);
  if (attributeProblem) return attributeProblem;

  if (name === 'path') {
    tally.pathElements += 1;
    if (tally.pathElements > MAX_PATH_ELEMENTS) {
      return reject('too_many_paths', `The drawing has more than ${String(MAX_PATH_ELEMENTS)} paths.`);
    }
    tally.pathDataBytes += Buffer.byteLength(element.getAttribute('d') ?? '', 'utf8');
    if (tally.pathDataBytes > MAX_PATH_DATA_BYTES) {
      return reject('path_data_too_large', 'The drawing carries more path data than a build pack can route.');
    }
  }

  const doomed: Node[] = [];
  const { childNodes } = element;
  for (let index = 0; index < childNodes.length; index += 1) {
    const child = childNodes.item(index);
    if (!child) continue;

    switch (child.nodeType) {
      case NODE_TYPE_ELEMENT: {
        const childElement = child as Element;
        if (STRIPPED_ELEMENTS.has(localNameOf(childElement.nodeName))) {
          doomed.push(child);
          break;
        }
        const problem = walkElement(childElement, tally);
        if (problem) return problem;
        break;
      }
      case NODE_TYPE_TEXT:
      case NODE_TYPE_CDATA:
        // Kept: `<text>`, `<tspan>`, `<title>` and `<desc>` are all content.
        break;
      case NODE_TYPE_COMMENT:
        // Dropped. Carries no geometry and is a free ride for anything an
        // editor, or a buyer, left in the file.
        doomed.push(child);
        break;
      case NODE_TYPE_PROCESSING_INSTRUCTION:
        return reject(
          'processing_instruction',
          'The drawing carries a processing instruction, which a build pack may not contain.',
        );
      default:
        return reject('disallowed_element', 'The drawing carries a node a build pack may not contain.');
    }
  }

  for (const node of doomed) element.removeChild(node);
  return null;
}

/**
 * `viewBox`, checked rather than merely present.
 *
 * The generator reads every coordinate in the viewBox's user units and rescales
 * the result to the placement width. Without one there is no coordinate space
 * at all; with a zero-extent one the rescale divides by zero, deep inside a job
 * that has already been paid for.
 */
function readViewBox(root: Element): { viewBox: string } | SvgSanitiseResult {
  const raw = root.getAttribute('viewBox');
  if (!raw || raw.trim().length === 0) {
    return reject('missing_view_box', 'The drawing has no viewBox, so there is nothing to scale it against.');
  }

  const numbers = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) {
    return reject('missing_view_box', 'The drawing’s viewBox is not four numbers.');
  }
  if (numbers[2] <= 0 || numbers[3] <= 0) {
    return reject('missing_view_box', 'The drawing’s viewBox has no width or height.');
  }

  return { viewBox: raw.trim() };
}

/**
 * Audit an SVG and return the bytes to store.
 *
 * Takes a string because that is what the document has to become to be parsed;
 * the size cap is measured in UTF-8 bytes so it means the same thing as the
 * generator's cap on the file.
 */
export function sanitiseSvg(source: string): SvgSanitiseResult {
  const text = stripByteOrderMark(source);

  if (text.trim().length === 0) {
    return reject('empty', 'The file is empty.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SVG_BYTES) {
    return reject(
      'too_large',
      `The drawing is bigger than ${String(MAX_SVG_BYTES / 1024 / 1024)} MB, which is the most we can route.`,
    );
  }

  // xmldom reports a malformed document through this callback and then carries
  // on with whatever it managed to build. Collecting the errors and refusing
  // when any arrived is what stops a half-parsed tree being audited as if it
  // were the file the buyer sent.
  const parseErrors: string[] = [];
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') parseErrors.push(message);
    },
  });

  let parsed;
  try {
    parsed = parser.parseFromString(text, 'image/svg+xml');
  } catch {
    return reject('not_xml', 'The file is not well-formed XML.');
  }
  if (parseErrors.length > 0) {
    return reject('not_xml', 'The file is not well-formed XML.');
  }

  if (parsed.doctype) {
    return reject('doctype', 'The file carries a DOCTYPE or an ENTITY declaration, which we never expand.');
  }

  const root = parsed.documentElement;
  if (!root || localNameOf(root.nodeName) !== 'svg') {
    return reject('not_svg', 'The file’s root element is not <svg>.');
  }

  // Everything outside the root: the XML declaration is kept (every editor
  // emits one and it is not a directive to anything), a comment is dropped, and
  // any other instruction — `<?xml-stylesheet?>` above all, which the generator
  // refuses by name — is a rejection.
  const doomedTopLevel: Node[] = [];
  for (let index = 0; index < parsed.childNodes.length; index += 1) {
    const node = parsed.childNodes.item(index);
    if (!node || node === root) continue;
    if (node.nodeType === NODE_TYPE_COMMENT) {
      doomedTopLevel.push(node);
      continue;
    }
    if (node.nodeType === NODE_TYPE_DOCUMENT_TYPE) {
      return reject('doctype', 'The file carries a DOCTYPE or an ENTITY declaration, which we never expand.');
    }
    if (node.nodeType === NODE_TYPE_PROCESSING_INSTRUCTION && node.nodeName.toLowerCase() !== 'xml') {
      return reject(
        'processing_instruction',
        'The file carries a processing instruction, which a build pack may not contain.',
      );
    }
  }
  for (const node of doomedTopLevel) parsed.removeChild(node);

  const viewBox = readViewBox(root);
  if ('ok' in viewBox) return viewBox;

  const problem = walkElement(root, { pathElements: 0, pathDataBytes: 0 });
  if (problem) return problem;

  const svg = new XMLSerializer().serializeToString(parsed);
  if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
    return reject(
      'too_large',
      `The drawing is bigger than ${String(MAX_SVG_BYTES / 1024 / 1024)} MB, which is the most we can route.`,
    );
  }

  return { ok: true, svg, viewBox: viewBox.viewBox };
}
