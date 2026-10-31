export const VISIBILITY_TITLE = 'Show this session live';
export const VISIBILITY_ON = `${VISIBILITY_TITLE}, Your crew and climbers on this board can see it and join.`;
export const VISIBILITY_OFF = `${VISIBILITY_TITLE}, Only people with your invite link can join.`;
export const OBSERVATION_STAGES = [
  'raw-wrapper',
  'make-toggle-entry',
  'before-haptic',
  'after-haptic',
  'before-parent-callback',
  'parent-handler-entry',
  'state-queue-request',
  'state-queued',
  'visibility-analytics-called',
  'after-parent-callback',
  'raw-wrapper-returned',
  'switch-row-props-committed',
  'pre-session-state-committed',
] as const;
export type Bounds = { left: number; top: number; right: number; bottom: number };
export type HierarchyNode = { attributes: Record<string, unknown>; children: HierarchyNode[] };
export function objectRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}
export function hierarchyNode(input: unknown): HierarchyNode {
  const node = objectRecord(input);
  return {
    attributes: objectRecord(node?.attributes) ?? {},
    children: Array.isArray(node?.children) ? node.children.map(hierarchyNode) : [],
  };
}
export function bounds(input: unknown): Bounds | null {
  if (typeof input !== 'string') return null;
  const match = input.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}
export function inside(rectangle: Bounds, point: { x: number; y: number }): boolean {
  return (
    point.x >= rectangle.left && point.x < rectangle.right && point.y >= rectangle.top && point.y < rectangle.bottom
  );
}
function nodes(root: HierarchyNode): HierarchyNode[] {
  return [root, ...root.children.flatMap(nodes)];
}
export function inspectVisibility(input: unknown, requireOn: boolean) {
  const root = hierarchyNode(input);
  const screenBounds = nodes(root)
    .map((node) => bounds(node.attributes.bounds))
    .filter((rectangle): rectangle is Bounds => rectangle !== null && rectangle.left === 0 && rectangle.top === 0)
    .sort((first, second) => second.right * second.bottom - first.right * first.bottom)[0];
  const matching = nodes(root).filter(
    (node) => node.attributes.accessibilityText === (requireOn ? VISIBILITY_ON : VISIBILITY_OFF),
  );
  if (matching.length !== 1) throw new Error('visibility_parent_not_unique');
  const parent = matching[0];
  const parentBounds = bounds(parent.attributes.bounds);
  if (!parentBounds || parent.attributes.enabled !== 'true') throw new Error('visibility_not_enabled');
  const expected = requireOn ? 'true' : 'false';
  if (String(parent.attributes.checked) !== expected || String(parent.attributes.value) !== (requireOn ? '1' : '0'))
    throw new Error('visibility_wrong_state');
  const thumbs = nodes(parent)
    .slice(1)
    .filter(
      (node) =>
        node.attributes.accessibilityText === '' &&
        node.attributes.enabled === 'true' &&
        String(node.attributes.checked) === expected &&
        bounds(node.attributes.bounds),
    );
  if (thumbs.length !== 1) throw new Error('visibility_thumb_not_unique');
  const thumbBounds = bounds(thumbs[0].attributes.bounds)!;
  const observed = { x: 369, y: 487 };
  const relative = {
    x: Math.floor(parentBounds.left + (parentBounds.right - parentBounds.left) * 0.9),
    y: Math.floor(parentBounds.top + (parentBounds.bottom - parentBounds.top) * 0.5),
  };
  const point = inside(thumbBounds, observed) ? observed : relative;
  if (!inside(thumbBounds, point) || !inside(parentBounds, point)) throw new Error('tap_point_outside_observed_thumb');
  return {
    screenBounds,
    point,
    pointSource: point === observed ? 'verified-ci-point' : 'observed-parent-relative-point',
    parentBounds,
    thumbBounds,
    // Only generic visibility labels and numeric/boolean control metadata survive.
    hierarchy: {
      label: requireOn ? VISIBILITY_ON : VISIBILITY_OFF,
      enabled: true,
      checked: requireOn,
      value: requireOn ? 1 : 0,
      parentBounds,
      thumbBounds,
    },
  };
}
const stringFields = new Set([
  'timestamp',
  'attemptId',
  'interactionId',
  'runtimeId',
  'switchRowId',
  'componentId',
  'stage',
]);
const booleanFields = new Set([
  'isOn',
  'next',
  'capturedDisabled',
  'capturedIsStartPending',
  'isPublic',
  'isStartPending',
  'value',
  'disabled',
]);
export function redactedTrace(line: string): Record<string, unknown> | null {
  const marker = line.indexOf('[native-input] ');
  if (marker < 0) return null;
  try {
    const source = objectRecord(JSON.parse(line.slice(marker + '[native-input] '.length)));
    if (
      !source ||
      typeof source.stage !== 'string' ||
      ![
        ...OBSERVATION_STAGES,
        'switch-row-mounted',
        'switch-row-unmounted',
        'pre-session-mounted',
        'pre-session-unmounted',
      ].includes(source.stage as (typeof OBSERVATION_STAGES)[number])
    )
      return null;
    return Object.fromEntries(
      Object.entries(source).filter(([key, field]) =>
        stringFields.has(key)
          ? typeof field === 'string' && /^[\w.:+-]{1,120}$/.test(field)
          : booleanFields.has(key) && typeof field === 'boolean',
      ),
    );
  } catch {
    return null;
  }
}
export function classifyAttempt(traces: Record<string, unknown>[], offConfirmed: boolean) {
  const raw = traces.filter((trace) => trace.stage === 'raw-wrapper');
  if (raw.length !== 1)
    return { reproduced: true, boundary: raw.length === 0 ? 'before_raw_js_event' : 'unexpected_multiple_raw_events' };
  const event = raw[0];
  const matching = traces.filter(
    (trace) =>
      trace.attemptId === event.attemptId &&
      trace.interactionId === event.interactionId &&
      trace.switchRowId === event.switchRowId,
  );
  if (event.isOn !== false) return { reproduced: true, boundary: 'raw_value_not_off' };
  if (matching.some((trace) => trace.stage === 'switch-row-unmounted' && trace.componentId === event.switchRowId))
    return { reproduced: true, boundary: 'target_row_unmounted' };
  if (matching.some((trace) => trace.stage === 'switch-row-mounted' && trace.componentId === event.switchRowId))
    return { reproduced: true, boundary: 'target_row_remounted' };
  const rowCommits = matching.filter((trace) => trace.stage === 'switch-row-props-committed');
  if (rowCommits.some((trace) => trace.componentId !== event.switchRowId))
    return { reproduced: true, boundary: 'row_commit_instance_changed' };
  if (rowCommits.some((trace) => trace.value !== false))
    return { reproduced: true, boundary: 'target_row_not_committed_off' };

  for (const stage of OBSERVATION_STAGES)
    if (!matching.some((trace) => trace.stage === stage)) return { reproduced: true, boundary: `missing_${stage}` };
  if (
    !matching.some((trace) => trace.stage === 'pre-session-state-committed' && trace.isPublic === false) ||
    !offConfirmed
  )
    return { reproduced: true, boundary: 'committed_or_native_state_not_off' };
  const parent = matching.find((trace) => trace.stage === 'parent-handler-entry');
  const commit = matching.find((trace) => trace.stage === 'pre-session-state-committed');
  if (
    parent?.capturedIsStartPending !== false ||
    matching.find((trace) => trace.stage === 'make-toggle-entry')?.capturedDisabled !== false
  )
    return { reproduced: true, boundary: 'captured_guard_not_false' };
  if (!parent?.componentId || parent.componentId !== commit?.componentId)
    return { reproduced: true, boundary: 'parent_instance_changed' };
  return { reproduced: false, boundary: 'none_observed' };
}
export function singleTapFlow(point: { x: number; y: number }): string {
  if (![point.x, point.y].every((coordinate) => Number.isInteger(coordinate) && coordinate >= 0))
    throw new Error('invalid_tap_point');
  return `appId: com.boardsesh.app\n---\n- evalScript: \${http.get('http://127.0.0.1:8120/__observation/before')}\n- tapOn:\n    point: '${point.x},${point.y}'\n    repeat: 1\n    retryTapIfNoChange: false\n- evalScript: \${http.get('http://127.0.0.1:8120/__observation/after')}\n`;
}

export function mayAttemptFreshLaunch(result: {
  attempt: number;
  reproduced: boolean;
  validTap: boolean;
  completeHooks: boolean;
  offConfirmed: boolean;
  commandStatus: number;
}): boolean {
  return (
    result.attempt === 1 &&
    !result.reproduced &&
    result.validTap &&
    result.completeHooks &&
    result.offConfirmed &&
    result.commandStatus === 0
  );
}
