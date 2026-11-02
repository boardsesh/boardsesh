import { describe, expect, it } from 'vitest';
import { previousNotificationTarget } from './notifications';

const action = '<node text="Previous" enabled="true" clickable="true" bounds="[10,20][50,60]"/>';
const notification = (app: string, title: string) =>
  `<node resource-id="com.android.systemui:id/status_bar_latest_event_content"><node text="${app}"/><node text="${title}"/>${action}</node>`;
describe('scoped Android notification action', () => {
  it('targets only the current Boardsesh notification despite another media app', () => {
    expect(
      previousNotificationTarget(notification('Music', 'Other track') + notification('Boardsesh', 'DUNES'), 'DUNES'),
    ).toEqual({ x: 30, y: 40 });
  });
  it('refuses wrong app, stale climb, duplicate notifications and missing controls', () => {
    expect(previousNotificationTarget(notification('Music', 'DUNES'), 'DUNES')).toBeNull();
    expect(
      previousNotificationTarget(
        `<node>${notification('Music', 'DUNES')}${notification('Boardsesh', 'Other climb')}</node>`,
        'DUNES',
      ),
    ).toBeNull();
    expect(previousNotificationTarget(notification('Boardsesh', 'Other climb'), 'DUNES')).toBeNull();
    expect(previousNotificationTarget(notification('Boardsesh', 'DUNES').repeat(2), 'DUNES')).toBeNull();
    expect(previousNotificationTarget('<node><node text="Boardsesh"/><node text="DUNES"/></node>', 'DUNES')).toBeNull();
  });
});

it('decodes XML entities once and tolerates a malformed transient dump', () => {
  expect(previousNotificationTarget(notification('Boardsesh', '&amp;lt;'), '&lt;')).toEqual({ x: 30, y: 40 });
  expect(previousNotificationTarget(notification('Boardsesh', '&amp;lt;'), '<')).toBeNull();
  expect(previousNotificationTarget('<node><node text="DUNES"/>', 'DUNES')).toBeNull();
  expect(previousNotificationTarget('ERROR: null root node', 'DUNES')).toBeNull();
});
