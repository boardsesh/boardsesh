# Gym fixture native tests

Run the BLE, button, cache, client, preview geometry, and USB output suites from the repository root:

```sh
vp exec node embedded/scripts/test-fixture.mjs
vp exec node embedded/scripts/test-fixture.mjs --sanitize
```

The runner requires a C/C++17 compiler and Unity from the existing native PlatformIO environment. If Unity is missing, install it without changing project configuration: `vp exec pio pkg install -d embedded/test -e native --library throwtheswitch/Unity@2.6.0 --no-save`. `CC` and `CXX` select alternative compiler executables. Sanitizers are optional and supported by current GCC and Clang on Linux and macOS. All build outputs live in a temporary directory.

The BLE suite compiles the production `gym/ble.h` coordinator and production Aurora/MoonBoard parsers. It exercises independent local-address routing, fragmented and interleaved payloads, malformed packets, bounded multipart buffering, empty clears, update ordering, 12/18-row MoonBoard geometry, Mini flags, address stability, host recovery, and explicit shutdown. The temporary QA policy tests cover run ownership, heartbeat expiry, last-connection-wins isolation, stale callbacks, retained complete payload evidence, partial-frame invalidation, handle reuse, and reset to concurrent connections. A failing assertion exits unsuccessfully; this suite does not rely on PlatformIO parsing a mocked Unity summary.

The mocked coordinator can exercise slot replacement after a fourth connection callback. This is not proof that the physical radio admits that callback with three links already established: the firmware radio limit remains three. Normal two-phone QA stays below that limit.

The USB output suite checks raw-span framing, maximum-size output, pre-emission bounds and short-write failure handling. Its deferred-enqueue counterexample shows why a caller-held stdout lock cannot protect bytes later drained by HWCDC's ISR from an independent IDF USB console writer. The gym target instead compiles NimBLE C++/host logs out using their respective NONE levels (0/5). Verify the built NimBLE server object contains no MTU/subscription diagnostic formats, then use physical connect traces to validate deployed behavior. Exceptional console output still fails the strict host parser.

Local mocks replace the radio, clock, JSON views, mutex, and hardware identity. The hash stub is a deterministic test mixer: these tests verify the inputs to address derivation, not SHA-256's implementation. Production firmware uses the ESP32 SDK's mbedTLS. No USB device, Bluetooth adapter, network service, or filesystem outside temporary build outputs is accessed.
