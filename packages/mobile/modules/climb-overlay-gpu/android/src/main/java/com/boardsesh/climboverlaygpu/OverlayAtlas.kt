package com.boardsesh.climboverlaygpu

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONArray
import org.json.JSONObject

internal fun directBytes(size: Int): ByteBuffer =
    ByteBuffer.allocateDirect(size).order(ByteOrder.nativeOrder())

internal fun JSONArray.floats(count: Int): FloatArray {
    require(length() == count) { "Invalid atlas vector" }
    return FloatArray(count) { getDouble(it).toFloat().also { value -> require(value.isFinite()) } }
}

internal data class AtlasRole(val state: Long, val color: FloatArray, val offsets: IntArray)

internal data class AtlasHold(
    val id: Long,
    val mirror: Long?,
    val bounds: FloatArray,
    val crop: IntArray,
    val field: Int,
    val reach: Float,
    val roles: Map<Long, AtlasRole>,
)

internal data class AtlasManifest(
    val width: Int,
    val height: Int,
    val covers: Int,
    val veil: FloatArray,
    val mirrored: Boolean,
    val glow: Boolean,
    val tuning: FloatArray,
    val tuning2: FloatArray,
    val lut: FloatArray,
    val holds: Map<Long, AtlasHold>,
) {
    val states = holds.values.flatMap { it.roles.keys }.toSet()

    companion object {
        fun parse(json: String, bytes: Int): AtlasManifest {
            val root = JSONObject(json)
            val width = root.getInt("width")
            val height = root.getInt("height")
            require(root.getInt("version") == 1 && width in 1..1536 && height in 1..2048)
            require(bytes in 1..OverlayPolicy.ATLAS_LIMIT)
            fun offset(raw: Long, length: Long, sentinel: Boolean = false): Int {
                if (sentinel && raw == 0xffffffffL) return -1
                require(raw >= 0 && raw % 4 == 0L && raw + length <= bytes) {
                    "Invalid atlas offset"
                }
                return raw.toInt()
            }
            val covers = offset(root.getLong("covers"), width.toLong() * height * 4)
            val entries = root.getJSONArray("holds")
            val holds = LinkedHashMap<Long, AtlasHold>()
            for (index in 0 until entries.length()) {
                val hold = entries.getJSONObject(index)
                val crop =
                    intArrayOf(
                        hold.getInt("x"),
                        hold.getInt("y"),
                        hold.getInt("width"),
                        hold.getInt("height"),
                    )
                require(
                    crop[0] >= 0 &&
                        crop[1] >= 0 &&
                        crop[2] > 0 &&
                        crop[3] > 0 &&
                        crop[0].toLong() + crop[2] <= width &&
                        crop[1].toLong() + crop[3] <= height,
                )
                val pixels = crop[2].toLong() * crop[3]
                val roles = LinkedHashMap<Long, AtlasRole>()
                val roleList = hold.getJSONArray("roles")
                for (roleIndex in 0 until roleList.length()) {
                    val role = roleList.getJSONObject(roleIndex)
                    val state = role.getLong("state")
                    require(state in 0..0xffffffffL)
                    roles[state] =
                        AtlasRole(
                            state,
                            role.getJSONArray("color").floats(3),
                            intArrayOf(
                                offset(role.getLong("fill"), pixels * 4, true),
                                offset(role.getLong("plate"), pixels * 4, true),
                                offset(role.getLong("glyph"), pixels * 4, true),
                            ),
                        )
                }
                val id = hold.getLong("id")
                require(id in 0..0xffffffffL && !holds.containsKey(id))
                val reach = hold.getDouble("reach").toFloat()
                require(reach.isFinite() && reach >= 0 && reach <= 512)
                holds[id] =
                    AtlasHold(
                        id,
                        if (hold.isNull("mirror")) null else hold.getLong("mirror"),
                        hold.getJSONArray("bounds").floats(4),
                        crop,
                        offset(hold.getLong("field"), pixels * 8),
                        reach,
                        roles,
                    )
            }
            return AtlasManifest(
                width,
                height,
                covers,
                root.getJSONArray("veil").floats(4),
                root.getBoolean("mirrored"),
                root.getBoolean("glow"),
                floatArrayOf(
                    root.getDouble("merge").toFloat(),
                    root.getDouble("seam").toFloat(),
                    root.getDouble("seamMix").toFloat(),
                    root.getDouble("seamSharpness").toFloat(),
                ),
                floatArrayOf(
                    root.getDouble("fringe").toFloat(),
                    root.getDouble("coreShare").toFloat(),
                ),
                root.getJSONArray("lut").floats(257),
                holds,
            )
        }
    }
}

internal data class ActiveHold(
    val hold: AtlasHold,
    val role: AtlasRole,
    var changed: Boolean = false,
    var previous: Int = 0,
    var next: Int = 0,
)

internal class ActiveScene(val descriptors: List<ActiveHold>, val buffer: Int) {
    val maxReach = descriptors.maxOfOrNull { it.hold.reach } ?: 0f
    val roles = descriptors.associate { it.hold.id to it.role.state }
}

internal fun selectHolds(manifest: AtlasManifest, frames: String): List<ActiveHold> {
    require(frames.length <= 32 * 1024) { "GPU frames too large" }
    val active = ArrayList<ActiveHold>()
    for (token in frames.substringBefore(',').split('p')) {
        val pieces = token.split('r')
        if (pieces.size != 2) continue
        val id = pieces[0].toLongOrNull()?.takeIf { it in 0..0xffffffffL } ?: continue
        val state = pieces[1].toLongOrNull()?.takeIf { it in 0..0xffffffffL } ?: continue
        require(state in manifest.states) { "Unsupported GPU hold role" }
        val original = manifest.holds[id] ?: continue
        val hold = if (manifest.mirrored) manifest.holds[original.mirror] ?: original else original
        val role = hold.roles[state] ?: error("Unsupported GPU hold role")
        require(active.size < OverlayPolicy.MAX_ACTIVE) { "GPU source exceeds 128 active holds" }
        active.add(ActiveHold(hold, role))
    }
    require(frames.isEmpty() || active.isNotEmpty()) { "GPU source contains no matching holds" }
    return active
}

internal fun encodeHolds(holds: List<ActiveHold>): ByteBuffer {
    // Six 16-byte vectors; identical to Metal Hold and GLSL std430 stride96.
    val bytes = directBytes(maxOf(1, holds.size) * 96)
    for (active in holds) {
        val hold = active.hold
        active.role.color.forEach { bytes.putFloat(it / 255) }
        bytes.putFloat(1f)
        hold.bounds.forEach { bytes.putFloat(it) }
        hold.crop.forEach { bytes.putInt(it) }
        bytes.putInt(hold.field)
        active.role.offsets.forEach { bytes.putInt(it) }
        bytes.putFloat(hold.reach)
        bytes.putFloat(if (active.changed) 1f else 0f)
        bytes.putFloat(active.previous.toFloat())
        bytes.putFloat(active.next.toFloat())
        bytes.putInt(hold.id.toInt())
        bytes.putInt(active.role.state.toInt())
        bytes.putInt(0)
        bytes.putInt(0)
    }
    bytes.rewind()
    return bytes
}
