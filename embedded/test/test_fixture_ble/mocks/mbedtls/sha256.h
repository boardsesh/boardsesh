#pragma once
#include <cstddef>
#include <cstdint>

// Deterministic test-only stand-in. These tests check address derivation inputs,
// stability, routing and random-static bits; they do not test SHA-256 itself.
// Production builds continue to use the ESP32 SDK's mbedTLS implementation.
inline int mbedtls_sha256(const uint8_t* input, size_t length, uint8_t output[32], int) {
    uint32_t state = 2166136261u;
    for (size_t index = 0; index < length; ++index)
        state = (state ^ input[index]) * 16777619u;
    for (size_t index = 0; index < 32; ++index) {
        state ^= state >> 16;
        state *= 0x85EBCA6Bu;
        state ^= state >> 13;
        output[index] = static_cast<uint8_t>(state);
    }
    return 0;
}
