#pragma once
#include "../../../../ios/include/board_renderer.h"

// JNI requires a non-null address even for zero-capacity direct buffers.
// This byte is never registered as Rust-owned and is never freed or accessed.
inline void *aura_gpu_direct_buffer_address(const AuraGpuBytes &buffer) {
    static uint8_t empty_buffer = 0;
    return buffer.length == 0 ? &empty_buffer : buffer.pointer;
}
