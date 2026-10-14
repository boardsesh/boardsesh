# Offline-drain compatibility test bytes

These four text fixtures are the exact source bytes reviewed for #6452. They
are loaded as data and never executed. Keeping them immutable lets later app
changes correctly become ineligible for this compatibility exception without
breaking its historical regression tests or requiring Git history in CI.

- `producer`: commit `934beb7252534ddee20db1cd7a24db22e5a63fb8`.
- `current`: commit `50397fb9110559f5b2574bb4b761242628b39d63`.
- `database`: `packages/shared/offline-sync/src/database.ts`.
- `drainer`: `packages/shared/offline-sync/src/mutation-queue/drainer.ts`.

The test asserts each complete file's frozen SHA256 before using it.
