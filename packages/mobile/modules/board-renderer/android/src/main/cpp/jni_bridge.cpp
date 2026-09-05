// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

#include <jni.h>
#include <cstdint>
#include <cstring>

extern "C" {
    int32_t board_renderer_render(
        const uint8_t *config_json, uint32_t config_json_len,
        uint8_t **out_data, uint32_t *out_len,
        uint32_t *out_width, uint32_t *out_height
    );
    void board_renderer_free(uint8_t *ptr, uint32_t len);
}

// NOTE: GetStringUTFChars returns JNI Modified UTF-8, not standard UTF-8.
// The Rust side (std::str::from_utf8) expects standard UTF-8 and will reject
// surrogate-pair sequences. This is safe today because board config JSON is
// ASCII-only (no non-ASCII strings in keys/values). If that ever changes,
// switch to GetStringChars + manual UTF-16 -> UTF-8 conversion.
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_boardsesh_boardrenderer_BoardRendererBridge_nativeRender(
    JNIEnv *env,
    jobject /* thiz */,
    jstring configJson
) {
    jsize jsonLen = env->GetStringUTFLength(configJson);
    const char *jsonChars = env->GetStringUTFChars(configJson, nullptr);
    if (!jsonChars) return nullptr;
    uint8_t *outData = nullptr;
    uint32_t outLen = 0;
    uint32_t outWidth = 0;
    uint32_t outHeight = 0;

    int32_t result = board_renderer_render(
        reinterpret_cast<const uint8_t *>(jsonChars),
        static_cast<uint32_t>(jsonLen),
        &outData,
        &outLen,
        &outWidth,
        &outHeight
    );

    env->ReleaseStringUTFChars(configJson, jsonChars);

    if (result != 0 || !outData) return nullptr;

    // Pack: [width_u32_le, height_u32_le, rgba_bytes...]
    uint32_t totalLen = 8 + outLen;
    jbyteArray output = env->NewByteArray(static_cast<jsize>(totalLen));
    if (!output) {
        // NewByteArray on failure leaves an OutOfMemoryError pending. Don't
        // clear it — let it propagate into Kotlin so the caller actually
        // sees the failure instead of receiving a silent null.
        board_renderer_free(outData, outLen);
        return nullptr;
    }

    uint8_t header[8];
    memcpy(header, &outWidth, 4);
    memcpy(header + 4, &outHeight, 4);

    env->SetByteArrayRegion(output, 0, 8, reinterpret_cast<jbyte *>(header));
    env->SetByteArrayRegion(output, 8, static_cast<jsize>(outLen), reinterpret_cast<jbyte *>(outData));

    board_renderer_free(outData, outLen);
    return output;
}
