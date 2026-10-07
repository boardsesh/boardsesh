# Service-only spray recognition: native release

This `release/next` change removes `onnxruntime-react-native`, its Android
autolinking shim, the model downloader/cache/runtime and tester benchmark route.
It also removes `com.apple.developer.kernel.increased-memory-limit`, introduced
for the on-device model in #5524. Camera permissions and the shared TypeScript
decoding/training code remain. Unrelated memory fixes remain untouched.

A new iOS/Android binary is required; this is not an OTA-only removal. Existing
installed binaries may retain old cached model files, but no code downloads or
loads them after this change. No user photos or wall data are deleted.

The paired main-branch rollout provides authenticated GraphQL jobs and the
homelab Node worker. The exposure flag remains gated independently. Merge this
cleanup into `release/next`, not directly into `main`; publish native artifacts
and record their actual fingerprints using the normal release workflow. Do not
invent fingerprints from local config or reuse the old ONNX binary's values.
