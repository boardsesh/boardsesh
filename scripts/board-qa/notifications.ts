import { command } from './drivers';
import { Evidence, QaFailure, until } from './evidence';

type Node = { attributes: Record<string, string>; children: Node[]; parent?: Node };
function tree(xml: string): Node {
  const root: Node = { attributes: {}, children: [] };
  const stack = [root];
  let count = 0;
  for (const match of xml.matchAll(/<\/node\s*>|<node\b([^>]*?)(\/?)>/g)) {
    if (++count > 20_000) throw new QaFailure('Notification hierarchy exceeds bounds', 'infrastructure');
    if (match[0].startsWith('</')) {
      if (stack.length < 2) throw new Error('Invalid hierarchy');
      stack.pop();
      continue;
    }
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((entry) => [
        entry[1],
        entry[2]
          .replaceAll('&amp;', '&')
          .replaceAll('&quot;', '"')
          .replaceAll('&apos;', "'")
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>'),
      ]),
    );
    const node: Node = { attributes, children: [], parent: stack[stack.length - 1] };
    node.parent?.children.push(node);
    if (!match[2]) {
      stack.push(node);
      if (stack.length > 100) throw new Error('Hierarchy too deep');
    }
  }
  return root;
}
function descendants(node: Node): Node[] {
  return [node, ...node.children.flatMap(descendants)];
}
/** Locate only this app's notification for the expected queue item, never another media app. */
export function previousNotificationTarget(xml: string, currentClimb: string): { x: number; y: number } | null {
  const root = tree(xml);
  const labels = (node: Node) => [node.attributes.text, node.attributes['content-desc']];
  const titles = descendants(root).filter((node) => labels(node).includes(currentClimb));
  const targets = new Set<Node>();
  for (const title of titles) {
    let ancestor: Node | undefined = title.parent;
    while (ancestor && ancestor !== root) {
      const isNotification = /\/(status_bar_latest_event_content|expandableNotificationRow)$/.test(
        ancestor.attributes['resource-id'] ?? '',
      );
      if (!isNotification) {
        ancestor = ancestor.parent;
        continue;
      }
      const nodes = descendants(ancestor);
      const ownsApp = nodes.some((node) => labels(node).some((label) => /^Boardsesh(?: Dev)?$/.test(label ?? '')));
      const buttons = nodes.filter(
        (node) =>
          labels(node).some((label) => label === 'Previous' || label === 'Previous climb') &&
          node.attributes.enabled === 'true' &&
          node.attributes.clickable === 'true',
      );
      if (ownsApp && buttons.length) buttons.forEach((node) => targets.add(node));
      break; // Never escape this notification into a sibling app's controls.
    }
  }
  if (targets.size !== 1) return null;
  const selected = [...targets][0];
  const bounds = selected.attributes.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!bounds) return null;
  const [, left, top, right, bottom] = bounds.map(Number);
  if (right <= left || bottom <= top || right > 10_000 || bottom > 10_000) return null;
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}
export async function notificationPrevious(
  adb: string,
  device: string,
  currentClimb: string,
  evidence: Evidence,
): Promise<void> {
  await command(adb, ['-s', device, 'shell', 'cmd', 'statusbar', 'expand-notifications']);
  try {
    const selected = await until(
      async () =>
        previousNotificationTarget(
          await command(adb, ['-s', device, 'exec-out', 'uiautomator', 'dump', '/dev/tty']),
          currentClimb,
        ),
      Boolean,
      15_000,
      'Boardsesh notification scoped to current QA climb',
    );
    if (!selected) throw new QaFailure('No unique Boardsesh notification action', 'blocked');
    evidence.event('notification-previous', {
      currentClimb,
      selected,
      source: 'current accessibility bounds within Boardsesh notification',
    });
    await command(adb, ['-s', device, 'shell', 'input', 'tap', String(selected.x), String(selected.y)]);
  } finally {
    await command(adb, ['-s', device, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  }
}
