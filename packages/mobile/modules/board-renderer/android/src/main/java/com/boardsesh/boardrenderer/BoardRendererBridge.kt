package com.boardsesh.boardrenderer

import java.nio.ByteBuffer

data class RenderResult(
    val data: ByteArray,
    val width: Int,
    val height: Int,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is RenderResult) return false
        return data.contentEquals(other.data) && width == other.width && height == other.height
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + width
        result = 31 * result + height
        return result
    }
}

object BoardRendererBridge {
    init {
        System.loadLibrary("board_renderer_ffi")
        System.loadLibrary("board_renderer_jni")
    }

    external fun nativeRender(configJson: String): ByteArray?

    private external fun nativePrepareAtlas(configUtf8: ByteArray): ByteBuffer?

    private external fun nativePrepareOwnedAtlas(configUtf8: ByteArray, assetPath: ByteArray?, expectedSha: ByteArray?, generatedDir: ByteArray?): Array<ByteBuffer>?

    private external fun nativeFreeAtlas(buffer: ByteBuffer)

    /** No Java heap copy of the atlas. Upload inside useBuffer, then close. */
    fun prepareAtlas(configJson: String): OwnedAtlasBuffer {
        require(configJson.length <= 8 * 1024 * 1024) { "GPU config too large" }
        val utf8 = configJson.toByteArray(Charsets.UTF_8)
        require(utf8.size <= 8 * 1024 * 1024) { "GPU config too large" }
        val buffer =
            nativePrepareAtlas(utf8)
                ?: throw IllegalArgumentException("GPU atlas rejected config or exceeded budget")
        return OwnedAtlasBuffer(buffer, ::nativeFreeAtlas)
    }

    fun prepareOwnedAtlas(configJson: String, geometryAssetPath: String?, geometryAssetSha256: String?, generatedGeometryDirectory: String?): OwnedAtlasBuffers {
        require(configJson.length <= 8 * 1024 * 1024) { "GPU config too large" }
        val configBytes = configJson.toByteArray(Charsets.UTF_8)
        require(configBytes.size <= 8 * 1024 * 1024) { "GPU config too large" }
        fun pathBytes(path: String?): ByteArray? = path?.let {
            require(it.length <= 4096) { "GPU asset path too large" }
            val uri = android.net.Uri.parse(it)
            require(uri.scheme == null || uri.scheme == "file") { "GPU asset must be a local file" }
            (if (uri.scheme == "file") uri.path else it)?.toByteArray(Charsets.UTF_8)
        }
        val path = pathBytes(geometryAssetPath)
        val directory = pathBytes(generatedGeometryDirectory)
        require(path == null || path.size <= 4096) { "GPU asset path too large" }
        require(directory == null || directory.size <= 4096) { "GPU cache directory too large" }
        val hash = geometryAssetSha256?.toByteArray(Charsets.UTF_8)
        require(hash == null || hash.size <= 64) { "Invalid GPU asset checksum" }
        val buffers = nativePrepareOwnedAtlas(configBytes, path, hash, directory)
            ?: throw IllegalArgumentException("GPU atlas rejected config or exceeded budget")
        check(buffers.size == 2)
        return OwnedAtlasBuffers(
            OwnedAtlasBuffer(buffers[0], ::nativeFreeAtlas),
            OwnedAtlasBuffer(buffers[1], ::nativeFreeAtlas),
        )
    }

    fun render(configJson: String): RenderResult? {
        val raw = nativeRender(configJson) ?: return null
        if (raw.size < 8) return null

        // First 8 bytes: width (u32 LE) + height (u32 LE)
        val width =
            (raw[0].toInt() and 0xFF) or
                ((raw[1].toInt() and 0xFF) shl 8) or
                ((raw[2].toInt() and 0xFF) shl 16) or
                ((raw[3].toInt() and 0xFF) shl 24)
        val height =
            (raw[4].toInt() and 0xFF) or
                ((raw[5].toInt() and 0xFF) shl 8) or
                ((raw[6].toInt() and 0xFF) shl 16) or
                ((raw[7].toInt() and 0xFF) shl 24)

        val pixelData = raw.copyOfRange(8, raw.size)
        return RenderResult(pixelData, width, height)
    }
}
