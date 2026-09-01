#!/usr/bin/env bash
set -euo pipefail

# Cross-compile the board-renderer-ffi Rust crate for iOS and Android.
# Produces:
#   - iOS: xcframework at packages/mobile/modules/board-renderer/ios/BoardRendererNative.xcframework
#   - Android: .so files at packages/mobile/modules/board-renderer/android/src/main/jniLibs/{abi}/
#
# Usage: scripts/build-native-renderer.sh [ios|android|all]
#
# The optional first argument picks which platform to build; `all` (the default)
# keeps the original behaviour of building both in one run. The iOS half needs
# macOS — it shells out to `lipo` and `xcodebuild -create-xcframework`, neither of
# which exists on Linux — so `android` is the argument that lets a Linux box
# rebuild the four .so files without the run dying at the xcframework step, and
# without touching the committed xcframework (which a maintainer rebuilds on a Mac
# with `ios`). The Android half needs an NDK: set ANDROID_NDK_HOME, or leave it
# unset and let the detection below find one under the usual SDK locations.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FFI_DIR="$ROOT_DIR/packages/board-renderer/ffi"
MODULE_DIR="$ROOT_DIR/packages/mobile/modules/board-renderer"

PLATFORM="${1:-all}"
case "$PLATFORM" in
  ios | android | all) ;;
  *)
    echo "ERROR: unknown platform '$PLATFORM'. Usage: $0 [ios|android|all]" >&2
    exit 2
    ;;
esac

# Plain `if`s, not `[ … ] && VAR=true`: under `set -e` a false test would make the
# whole line non-zero and abort the script.
BUILD_IOS=false
BUILD_ANDROID=false
if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "all" ]; then BUILD_IOS=true; fi
if [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "all" ]; then BUILD_ANDROID=true; fi

# -- iOS targets --
IOS_TARGETS=(
  "aarch64-apple-ios"         # device
  "aarch64-apple-ios-sim"     # Apple Silicon simulator
  "x86_64-apple-ios"          # Intel simulator
)

# -- Android targets --
# Maps Rust target triple to Android ABI directory name
declare -A ANDROID_TARGETS=(
  ["aarch64-linux-android"]="arm64-v8a"
  ["armv7-linux-androideabi"]="armeabi-v7a"
  ["x86_64-linux-android"]="x86_64"
  ["i686-linux-android"]="x86"
)

echo "==> Installing Rust targets for '$PLATFORM'..."
if [ "$BUILD_IOS" = true ]; then
  for target in "${IOS_TARGETS[@]}"; do
    rustup target add "$target" 2>/dev/null || true
  done
fi
if [ "$BUILD_ANDROID" = true ]; then
  for target in "${!ANDROID_TARGETS[@]}"; do
    rustup target add "$target" 2>/dev/null || true
  done
fi

XCFW_DIR="$MODULE_DIR/ios/BoardRendererNative.xcframework"
# Shared by both halves: cargo's --target output tree.
RELEASE_DIR="$ROOT_DIR/packages/board-renderer/target"

if [ "$BUILD_IOS" = true ]; then
# -- Build iOS static libraries --
echo "==> Building iOS static libraries..."
for target in "${IOS_TARGETS[@]}"; do
  echo "  Building $target..."
  cargo build --manifest-path "$FFI_DIR/Cargo.toml" --release --target "$target"
done

# -- Create xcframework --
echo "==> Creating xcframework..."
rm -rf "$XCFW_DIR"

# Combine simulator architectures into a fat library
SIM_FAT_DIR="$RELEASE_DIR/ios-sim-fat"
mkdir -p "$SIM_FAT_DIR"

lipo -create \
  "$RELEASE_DIR/aarch64-apple-ios-sim/release/libboard_renderer_ffi.a" \
  "$RELEASE_DIR/x86_64-apple-ios/release/libboard_renderer_ffi.a" \
  -output "$SIM_FAT_DIR/libboard_renderer_ffi.a"

# xcodebuild -create-xcframework expects a headers directory
HEADERS_DIR="$MODULE_DIR/ios/include"
if [ ! -f "$HEADERS_DIR/board_renderer.h" ]; then
  echo "ERROR: $HEADERS_DIR/board_renderer.h not found" >&2
  exit 1
fi

xcodebuild -create-xcframework \
  -library "$RELEASE_DIR/aarch64-apple-ios/release/libboard_renderer_ffi.a" \
  -headers "$HEADERS_DIR" \
  -library "$SIM_FAT_DIR/libboard_renderer_ffi.a" \
  -headers "$HEADERS_DIR" \
  -output "$XCFW_DIR"

echo "  xcframework created at $XCFW_DIR"
fi

if [ "$BUILD_ANDROID" = true ]; then
# -- Build Android shared libraries --
echo "==> Building Android shared libraries..."

# Detect NDK
if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  # `vp run mobile:android-doctor` bootstraps an SDK here on a clean Linux box
  # (see scripts/lib/android-sdk.ts, DEFAULT_SDK_HOME), so check it first.
  if [ -d "$HOME/.cache/boardsesh/android-sdk/ndk" ]; then
    ANDROID_NDK_HOME="$(ls -d "$HOME/.cache/boardsesh/android-sdk/ndk"/*/ 2>/dev/null | sort -V | tail -1)"
  elif [ -d "$HOME/Android/Sdk/ndk" ]; then
    ANDROID_NDK_HOME="$(ls -d "$HOME/Android/Sdk/ndk"/*/ 2>/dev/null | sort -V | tail -1)"
  elif [ -d "$HOME/Library/Android/sdk/ndk" ]; then
    ANDROID_NDK_HOME="$(ls -d "$HOME/Library/Android/sdk/ndk"/*/ 2>/dev/null | sort -V | tail -1)"
  elif [ -d "/opt/homebrew/share/android-commandlinetools/ndk" ]; then
    ANDROID_NDK_HOME="$(ls -d "/opt/homebrew/share/android-commandlinetools/ndk"/*/ 2>/dev/null | sort -V | tail -1)"
  fi
fi

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  echo "WARNING: ANDROID_NDK_HOME not set and NDK not found. Skipping Android builds."
  echo "Set ANDROID_NDK_HOME to your NDK installation directory."
else
  # NDK only ships an x86_64 toolchain on macOS (runs under Rosetta on Apple
  # Silicon) and on Linux. uname -m would otherwise resolve to arm64/aarch64
  # and miss the actual prebuilt directory.
  case "$(uname -s)" in
    Darwin) HOST_TAG="darwin-x86_64" ;;
    Linux)  HOST_TAG="linux-x86_64" ;;
    *)      HOST_TAG="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)" ;;
  esac
  TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG"

  for target in "${!ANDROID_TARGETS[@]}"; do
    abi="${ANDROID_TARGETS[$target]}"
    echo "  Building $target -> $abi..."

    # Set the appropriate linker for each target
    case "$target" in
      aarch64-linux-android)
        export CC_aarch64_linux_android="$TOOLCHAIN/bin/aarch64-linux-android24-clang"
        export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/aarch64-linux-android24-clang"
        ;;
      armv7-linux-androideabi)
        export CC_armv7_linux_androideabi="$TOOLCHAIN/bin/armv7a-linux-androideabi24-clang"
        export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$TOOLCHAIN/bin/armv7a-linux-androideabi24-clang"
        ;;
      x86_64-linux-android)
        export CC_x86_64_linux_android="$TOOLCHAIN/bin/x86_64-linux-android24-clang"
        export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/x86_64-linux-android24-clang"
        ;;
      i686-linux-android)
        export CC_i686_linux_android="$TOOLCHAIN/bin/i686-linux-android24-clang"
        export CARGO_TARGET_I686_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/i686-linux-android24-clang"
        ;;
    esac

    # Align LOAD segments to 16 KB. Android 15 devices with 16 KB memory pages
    # (Pixel 8/9, etc.) refuse to dlopen a .so whose segments are only 4 KB
    # aligned ("not 16 KB aligned" → UnsatisfiedLinkError). The NDK linker still
    # defaults to 4 KB for these targets, so force it; 16 KB-aligned libs also
    # load fine on 4 KB devices, so this is unconditionally safe.
    RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384" \
      cargo build --manifest-path "$FFI_DIR/Cargo.toml" --release --target "$target"

    # Copy .so to jniLibs
    JNILIBS_DIR="$MODULE_DIR/android/src/main/jniLibs/$abi"
    mkdir -p "$JNILIBS_DIR"
    cp "$RELEASE_DIR/$target/release/libboard_renderer_ffi.so" "$JNILIBS_DIR/"
    echo "  Copied to $JNILIBS_DIR/"
  done
fi
fi

echo "==> Build complete!"
if [ "$BUILD_IOS" = true ]; then
  echo "iOS: $XCFW_DIR"
fi
if [ "$BUILD_ANDROID" = true ]; then
  echo "Android: $MODULE_DIR/android/src/main/jniLibs/"
fi
