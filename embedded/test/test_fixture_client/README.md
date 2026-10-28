# Fixture connection regressions

Run `vp run controller:fixture:test --sanitize` from the repository root.

This suite compiles the actual fixture client with isolated transport/clock mocks.
It verifies the native Origin policy, a secure first attempt before 60 seconds,
outer retry backoff, failed-TCP cleanup, and late disconnect callback handling.
An activation failure also keeps its specific reason while scheduling a retry.
The WebSocket mock models the installed library's callback-then-continue behavior
so a zero reconnect interval exposes an unwanted same-loop TCP attempt.

These tests stop before GraphQL responses; their compile-only JSON types reject
incoming text. They do not establish certificate validity, manifest parsing, or
over-the-air BLE behavior. Live controller/asset and physical-device QA cover
those boundaries.
