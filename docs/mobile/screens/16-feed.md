# Mobile feed

The crew feed is part of [Home](02-home.md), not a standalone mobile Feed tab.
`packages/mobile/src/components/feed/` supplies the top chrome, scope title, and
feed cards; Home's FlashList virtualizes the feed and uses its header for optional
sections.

Scope can select My crew, a gym, or Everyone. Hidden feed sections do not mount,
query, or page cached results. Loading, offline, failed reads, and an empty feed
remain distinct states. Pull-to-refresh operates on the sections currently shown;
see Home's visibility and refresh contract.

Profile session history uses `SessionsTab` under
`packages/mobile/src/components/you/`; it is distinct from the Home crew feed.
Moderation is the root `/moderation` task, not a Proposals tab, and comment threads
open their own entity sheets. Notification navigation follows
[notifications](17-notifications.md).

Use [mobile performance](../react-native-performance.md) for virtualized rows and
pagination, and [privacy](../../product/privacy.md) for who may read another climber's activity.
