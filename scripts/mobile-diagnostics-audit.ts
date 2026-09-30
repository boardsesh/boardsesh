/// <reference types="node" />
/** Read-only audit of a private downloaded Sentry event. Never dumps event contents. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
type JsonObject = Record<string, unknown>;
function object(input: unknown): JsonObject {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as JsonObject) : {};
}
function list(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}
export interface NativeAuditExpectations {
  testRunId?: string;
  launchId?: string;
  updateId?: string;
  embedded?: boolean;
}
export function auditNativeDiagnosticEvent(
  input: unknown,
  platform: 'android' | 'ios',
  requireTombstone = false,
  expected: NativeAuditExpectations = {},
): string[] {
  const envelope = object(input);
  const event = object(envelope.event ?? input);
  const problems: string[] = [];
  const entries = list(event.entries).map(object);
  const exception = object(entries.find((entry) => entry.type === 'exception')?.data ?? event.exception);
  const exceptions = list(exception.values).map(object);
  const threadContainer = object(entries.find((entry) => entry.type === 'threads')?.data ?? event.threads);
  if (
    !exceptions.some(
      (item) =>
        /SIGABRT/.test(
          `${typeof item.type === 'string' ? item.type : ''} ${typeof item.value === 'string' ? item.value : ''}`,
        ) ||
        object(object(object(item.mechanism).meta).signal).number === 6 ||
        object(object(object(item.mechanism).meta).signal).name === 'SIGABRT',
    )
  )
    problems.push('No native abort signal evidence.');
  const threads = list(threadContainer.values).map(object);
  const crashedThreads = threads.filter((thread) => thread.crashed === true);
  if (!crashedThreads.length) problems.push('No identified crashing thread.');
  const frames = [
    ...crashedThreads.flatMap((thread) => list(object(thread.stacktrace).frames)),
    ...exceptions
      .filter((item) => crashedThreads.some((thread) => thread.id !== undefined && item.thread_id === thread.id))
      .flatMap((item) => list(object(item.stacktrace).frames)),
  ].map(object);
  if (
    !frames.some(
      (frame) =>
        typeof frame.function === 'string' &&
        frame.function !== 'abort' &&
        typeof frame.filename === 'string' &&
        typeof frame.lineno === 'number' &&
        /(?:boardsesh|board.renderer|renderer_jni|BoardRenderer)/i.test(
          typeof frame.package === 'string' ? frame.package : frame.filename,
        ),
    )
  )
    problems.push('No owned frame symbolicated to a source line.');
  const images = list(object(event.debug_meta ?? event.debugMeta).images);
  const debugEntry = object(entries.find((entry) => entry.type === 'debugmeta')?.data);
  if (
    ![...images, ...list(debugEntry.images)].some(
      (image) => typeof object(image).debug_id === 'string' || typeof object(image).debugId === 'string',
    )
  )
    problems.push('No native debug image IDs.');
  const contexts = object(event.contexts);
  const tags = Array.isArray(event.tags)
    ? Object.fromEntries(
        list(event.tags)
          .map(object)
          .map((tag) => [String(tag.key), tag.value]),
      )
    : object(event.tags);
  const launchId =
    tags.launch_id ??
    tags.launchId ??
    tags['diagnostics.launch_id'] ??
    object(contexts.diagnostics).launchId ??
    object(object(contexts.mobile_diagnostics).launch).launchId;
  if (!launchId) problems.push('No launch correlation ID.');
  if (expected.launchId && launchId !== expected.launchId)
    problems.push('Crash launch ID differs from expected launch.');
  if (
    expected.testRunId &&
    (tags.source !== 'sentry-test' || (tags.test_run_id ?? tags.testRunId) !== expected.testRunId)
  )
    problems.push('Diagnostic test run ID/source differs from expected test.');
  const otaContext = object(object(contexts.mobile_diagnostics).launch);
  const updateId = tags.ota_update_id ?? otaContext.otaUpdateId;
  const embedded = tags.ota_is_embedded ?? otaContext.otaIsEmbedded;
  if (expected.updateId && updateId !== expected.updateId)
    problems.push('Crash OTA update differs from expected running update.');
  if (expected.embedded !== undefined && String(embedded) !== String(expected.embedded))
    problems.push('Crash embedded-launch identity differs from expected launch.');
  if (platform === 'android' && requireTombstone) {
    const attachments = [...list(envelope.attachments), ...list(event.attachments)].map(object);
    if (
      !attachments.some(
        (attachment) =>
          /tombstone/i.test(String(attachment.name ?? attachment.filename)) &&
          typeof (attachment.size ?? attachment.filesize) === 'number' &&
          Number(attachment.size ?? attachment.filesize) > 0,
      )
    )
      problems.push('Android event has no nonempty raw tombstone attachment metadata.');
  }
  return problems;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [filename, platform, ...flags] = process.argv.slice(2);
  if (!filename || !['android', 'ios'].includes(platform))
    throw new Error('Usage: event.json android|ios [--require-tombstone]');
  const expected: NativeAuditExpectations = {};
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--require-tombstone') continue;
    const content = flags[++index];
    if (!content) throw new Error('Audit expectation flag requires a value.');
    if (flag === '--test-run-id') expected.testRunId = content;
    else if (flag === '--launch-id') expected.launchId = content;
    else if (flag === '--update-id') expected.updateId = content;
    else if (flag === '--embedded' && ['true', 'false'].includes(content)) expected.embedded = content === 'true';
    else throw new Error('Unknown audit expectation flag.');
  }
  const problems = auditNativeDiagnosticEvent(
    JSON.parse(readFileSync(filename, 'utf8')) as unknown,
    platform as 'android' | 'ios',
    flags.includes('--require-tombstone'),
    expected,
  );
  for (const problem of problems) console.error(`[diagnostics-audit] ${problem}`);
  if (problems.length) process.exitCode = 1;
  else console.log('[diagnostics-audit] Native crash evidence passed.');
}
