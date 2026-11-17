#include <jni.h>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <unordered_map>

extern "C" {
    int32_t board_renderer_render(
        const uint8_t *config_json, uint32_t config_json_len,
        uint8_t **out_data, uint32_t *out_len,
        uint32_t *out_width, uint32_t *out_height
    );
    int32_t board_renderer_prepare_gpu_atlas(
        const uint8_t *config_json, uint32_t config_json_len,
        uint8_t **out_data, uint32_t *out_len
    );
    int32_t board_renderer_prepare_gpu_atlas_owned(
        const uint8_t *config_json, uint32_t config_json_len,
        const uint8_t *asset_path, uint32_t asset_path_len,
        const uint8_t *expected_sha, uint32_t expected_sha_len,
        const uint8_t *generated_dir, uint32_t generated_dir_len,
        uint8_t **out_manifest, uint32_t *out_manifest_len,
        uint8_t **out_pixels, uint32_t *out_pixels_len
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

// The atlas stays in Rust-owned native memory until glBufferData completes.
// A registry makes duplicate release or a sliced/foreign buffer harmless.
static std::mutex atlas_mutex;
static std::unordered_map<void *, uint32_t> atlas_allocations;

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_boardsesh_boardrenderer_BoardRendererBridge_nativePrepareOwnedAtlas(
    JNIEnv *env, jobject, jbyteArray config, jbyteArray assetPath,
    jbyteArray expectedSha, jbyteArray generatedDir
) {
    if (!config) return nullptr;
    const jsize length = env->GetArrayLength(config);
    const jsize path_length = assetPath ? env->GetArrayLength(assetPath) : 0;
    const jsize sha_length = expectedSha ? env->GetArrayLength(expectedSha) : 0;
    const jsize directory_length = generatedDir ? env->GetArrayLength(generatedDir) : 0;
    if (length <= 0 || length > 8 * 1024 * 1024 || path_length > 4096 ||
        sha_length > 64 || directory_length > 4096) return nullptr;
    jbyte *bytes = env->GetByteArrayElements(config, nullptr);
    if (!bytes) return nullptr;
    jbyte *path_bytes = assetPath ? env->GetByteArrayElements(assetPath, nullptr) : nullptr;
    if (assetPath && !path_bytes) {
        env->ReleaseByteArrayElements(config, bytes, JNI_ABORT);
        return nullptr;
    }
    jbyte *sha_bytes = expectedSha ? env->GetByteArrayElements(expectedSha, nullptr) : nullptr;
    jbyte *directory_bytes = (!env->ExceptionCheck() && generatedDir)
        ? env->GetByteArrayElements(generatedDir, nullptr) : nullptr;
    if ((expectedSha && !sha_bytes) || (generatedDir && !directory_bytes)) {
        if (assetPath) env->ReleaseByteArrayElements(assetPath, path_bytes, JNI_ABORT);
        if (sha_bytes) env->ReleaseByteArrayElements(expectedSha, sha_bytes, JNI_ABORT);
        env->ReleaseByteArrayElements(config, bytes, JNI_ABORT);
        return nullptr;
    }
    uint8_t *manifest = nullptr;
    uint8_t *pixels = nullptr;
    uint32_t manifest_length = 0;
    uint32_t pixels_length = 0;
    const int32_t status = board_renderer_prepare_gpu_atlas_owned(
        reinterpret_cast<const uint8_t *>(bytes), static_cast<uint32_t>(length),
        reinterpret_cast<const uint8_t *>(path_bytes), static_cast<uint32_t>(path_length),
        reinterpret_cast<const uint8_t *>(sha_bytes), static_cast<uint32_t>(sha_length),
        reinterpret_cast<const uint8_t *>(directory_bytes), static_cast<uint32_t>(directory_length),
        &manifest, &manifest_length, &pixels, &pixels_length);
    if (assetPath) env->ReleaseByteArrayElements(assetPath, path_bytes, JNI_ABORT);
    if (expectedSha) env->ReleaseByteArrayElements(expectedSha, sha_bytes, JNI_ABORT);
    if (generatedDir) env->ReleaseByteArrayElements(generatedDir, directory_bytes, JNI_ABORT);
    env->ReleaseByteArrayElements(config, bytes, JNI_ABORT);
    if (status != 0 || !manifest || !pixels || manifest_length == 0 ||
        manifest_length > 4 * 1024 * 1024 || pixels_length > 128 * 1024 * 1024) {
        board_renderer_free(manifest, manifest_length);
        board_renderer_free(pixels, pixels_length);
        return nullptr;
    }
    jclass buffer_class = env->FindClass("java/nio/ByteBuffer");
    jobjectArray result = buffer_class ? env->NewObjectArray(2, buffer_class, nullptr) : nullptr;
    jobject manifest_buffer = result ? env->NewDirectByteBuffer(manifest, manifest_length) : nullptr;
    jobject pixels_buffer = manifest_buffer ? env->NewDirectByteBuffer(pixels, pixels_length) : nullptr;
    if (!pixels_buffer) {
        board_renderer_free(manifest, manifest_length);
        board_renderer_free(pixels, pixels_length);
        return nullptr;
    }
    env->SetObjectArrayElement(result, 0, manifest_buffer);
    env->SetObjectArrayElement(result, 1, pixels_buffer);
    if (env->ExceptionCheck()) {
        board_renderer_free(manifest, manifest_length);
        board_renderer_free(pixels, pixels_length);
        return nullptr;
    }
    {
        std::lock_guard<std::mutex> lock(atlas_mutex);
        atlas_allocations.emplace(manifest, manifest_length);
        atlas_allocations.emplace(pixels, pixels_length);
    }
    return result;
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_boardsesh_boardrenderer_BoardRendererBridge_nativePrepareAtlas(
    JNIEnv *env, jobject, jbyteArray config
) {
    if (!config) return nullptr;
    const jsize length = env->GetArrayLength(config);
    if (length <= 0 || length > 8 * 1024 * 1024) return nullptr;
    jbyte *bytes = env->GetByteArrayElements(config, nullptr);
    if (!bytes) return nullptr;
    uint8_t *output = nullptr;
    uint32_t output_length = 0;
    const int32_t status = board_renderer_prepare_gpu_atlas(
        reinterpret_cast<const uint8_t *>(bytes), static_cast<uint32_t>(length),
        &output, &output_length);
    env->ReleaseByteArrayElements(config, bytes, JNI_ABORT);
    if (status != 0 || !output) return nullptr;
    // 128 MiB pixels plus the bounded 4 MiB JSON manifest and length prefix.
    if (output_length < 4 || output_length > 132 * 1024 * 1024 + 4) {
        board_renderer_free(output, output_length);
        return nullptr;
    }
    jobject buffer = env->NewDirectByteBuffer(output, output_length);
    if (!buffer) {
        board_renderer_free(output, output_length);
        return nullptr;
    }
    {
        std::lock_guard<std::mutex> lock(atlas_mutex);
        atlas_allocations.emplace(output, output_length);
    }
    return buffer;
}

extern "C" JNIEXPORT void JNICALL
Java_com_boardsesh_boardrenderer_BoardRendererBridge_nativeFreeAtlas(
    JNIEnv *env, jobject, jobject buffer
) {
    void *address = env->GetDirectBufferAddress(buffer);
    const jlong capacity = env->GetDirectBufferCapacity(buffer);
    std::lock_guard<std::mutex> lock(atlas_mutex);
    const auto found = atlas_allocations.find(address);
    if (found == atlas_allocations.end() || capacity != found->second) return;
    board_renderer_free(static_cast<uint8_t *>(address), found->second);
    atlas_allocations.erase(found);
}
