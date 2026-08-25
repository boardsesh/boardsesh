package com.boardsesh.liveactivity

internal const val ANDROID_ASSET_URI_PREFIX = "file:///android_asset/"
private val PACKAGED_BOARD_ART_PATTERN = Regex("^boardsesh-board-art/static/v1/[0-9a-f]{64}\\.webp$")

internal fun packagedAssetPath(uri: String): String? {
    if (!uri.startsWith(ANDROID_ASSET_URI_PREFIX)) return null
    val assetPath = uri.removePrefix(ANDROID_ASSET_URI_PREFIX)
    return assetPath.takeIf(PACKAGED_BOARD_ART_PATTERN::matches)
}
