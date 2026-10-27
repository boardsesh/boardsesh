# Gym fixture native tests

Run the BLE, button, cache, and preview geometry suites from the repository root:

```sh
vp exec node embedded/scripts/test-fixture.mjs
vp exec node embedded/scripts/test-fixture.mjs --sanitize
```

The runner requires a C/C++17 compiler and Unity from the existing native PlatformIO environment. If Unity is missing, install the native environment dependencies with `vp exec pio pkg install -d embedded/test -e native`. `CC` and `CXX` select alternative compiler executables. Sanitizers are optional and supported by current GCC and Clang on Linux and macOS. All build outputs live in a temporary directory.

The BLE suite compiles the production `gym/ble.h` coordinator and production Aurora/MoonBoard parsers. Its 49 assertions exercise independent local-address routing, fragmented and interleaved payloads, malformed packets, bounded multipart buffering, empty clears, update ordering, 12/18-row MoonBoard geometry, Mini flags, address stability, host recovery, and explicit shutdown. A failing assertion exits unsuccessfully; this suite does not rely on PlatformIO parsing a mocked Unity summary.

Local mocks replace the radio, clock, JSON views, mutex, and hardware identity. The hash stub is a deterministic test mixer: these tests verify the inputs to address derivation, not SHA-256's implementation. Production firmware uses the ESP32 SDK's mbedTLS. No USB device, Bluetooth adapter, network service, or filesystem outside temporary build outputs is accessed.
