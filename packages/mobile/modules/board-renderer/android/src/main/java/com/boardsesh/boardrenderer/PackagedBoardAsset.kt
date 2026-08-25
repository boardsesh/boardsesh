package com.boardsesh.boardrenderer

internal object PackagedBoardAsset {
    private const val ASSET_ROOT = "boardsesh-board-art"
    private const val URI_PREFIX = "file:///android_asset/"
    private val objectKeyPattern = Regex("^static/v1/[0-9a-f]{64}\\.webp$")

    fun assetPath(objectKey: String): String? =
        if (objectKeyPattern.matches(objectKey)) "$ASSET_ROOT/$objectKey" else null

    fun uri(assetPath: String): String = "$URI_PREFIX$assetPath"
}
