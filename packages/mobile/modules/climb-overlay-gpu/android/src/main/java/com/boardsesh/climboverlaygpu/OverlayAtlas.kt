package com.boardsesh.climboverlaygpu

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONArray
import org.json.JSONObject

internal fun directBytes(size: Int): ByteBuffer =
    ByteBuffer.allocateDirect(size).order(ByteOrder.nativeOrder())

internal fun checkedAtlasOffset(raw: Long, length: Long, bytes: Int): Int {
    require(raw >= 0 && raw <= bytes && raw % 4 == 0L && length >= 0 && length <= bytes - raw) {
        "Invalid atlas offset"
    }
    return raw.toInt()
}

internal fun JSONArray.floats(count: Int): FloatArray {
    require(length() == count) { "Invalid atlas vector" }
    return FloatArray(count) { getDouble(it).toFloat().also { value -> require(value.isFinite()) } }
}

internal data class AtlasStamp(val offset: Int, val crop: IntArray)

internal data class AtlasRole(
    val state: Long,
    val color: FloatArray,
    val stamps: List<AtlasStamp?>,
    val extraStamps: List<AtlasStamp?>,
    val annotation: Boolean,
    val identity: Long = state,
)

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
    val covers: AtlasStamp?,
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
            require(root.getInt("version") == 2 && width in 1..1536 && height in 1..2304)
            require(bytes in 1..OverlayPolicy.ATLAS_LIMIT)
            fun offset(raw: Long, length: Long): Int = checkedAtlasOffset(raw, length, bytes)
            fun stampEntry(entry: JSONObject): AtlasStamp {
                val crop = intArrayOf(entry.getInt("x"), entry.getInt("y"), entry.getInt("width"), entry.getInt("height"))
                require(crop[0] >= 0 && crop[1] >= 0 && crop[2] > 0 && crop[3] > 0 &&
                    crop[0].toLong() + crop[2] <= width && crop[1].toLong() + crop[3] <= height)
                return AtlasStamp(offset(entry.getLong("offset"), crop[2].toLong() * crop[3] * 4), crop)
            }
            fun stamp(parent: JSONObject, name: String): AtlasStamp? =
                if (parent.isNull(name)) null else stampEntry(parent.getJSONObject(name))
            fun pass(stamps: JSONArray, index: Int): AtlasStamp? =
                if (index >= stamps.length() || stamps.isNull(index)) null else stampEntry(stamps.getJSONObject(index))
            val covers = stamp(root, "covers")
            val entries = root.getJSONArray("holds")
            require(entries.length() <= 1024)
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
                val roles = decodeAtlasRoles(hold.getJSONArray("roles")) { role, state, identity ->
                    val color = role.getJSONArray("color").floats(3)
                    require(color.all { it in 0f..255f })
                    val fillPasses = role.getJSONArray("fillPasses")
                    val glyphPasses = role.getJSONArray("glyphPasses")
                    require(fillPasses.length() <= 4 && glyphPasses.length() <= 2)
                    AtlasRole(
                        state,
                        color,
                        listOf(pass(fillPasses, 0), stamp(role, "plate"), pass(glyphPasses, 0)),
                        listOf(pass(fillPasses, 1), pass(fillPasses, 2), pass(fillPasses, 3), pass(glyphPasses, 1)),
                        role.optBoolean("annotation", false),
                        identity,
                    )
                }
                val id = hold.getLong("id")
                require(id in 0..0xffffffffL && !holds.containsKey(id))
                val reach = hold.getDouble("reach").toFloat()
                require(reach.isFinite() && reach >= 0 && reach <= 512)
                val mirror = if (hold.isNull("mirror")) null else hold.getLong("mirror")
                require(mirror == null || mirror in 0..0xffffffffL)
                holds[id] =
                    AtlasHold(
                        id,
                        mirror,
                        hold.getJSONArray("bounds").floats(4),
                        crop,
                        offset(hold.getLong("field"), pixels * 4),
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
    val maxReach = descriptors.filterNot { it.role.annotation }.maxOfOrNull { it.hold.reach } ?: 0f
    val roles = descriptors.associate { it.hold.id to it.role.identity }
    val stampLayers = descriptors.fold(0) { layers, active ->
        layers or OverlayPolicy.stampLayers(
            active.role.annotation,
            active.role.stamps.map { it?.offset ?: -1 }.toIntArray(),
            active.role.extraStamps.map { it?.offset ?: -1 }.toIntArray(),
        )
    }
}

internal fun selectHolds(manifest: AtlasManifest, frames: String): List<ActiveHold> {
    if (frames.length > 32 * 1024) throw AtlasFrameFailure("frame-too-large")
    val active = ArrayList<ActiveHold>()
    for (token in frames.substringBefore(',').split('p')) {
        val pieces = token.split('r')
        if (pieces.size != 2) continue
        val id = pieces[0].toLongOrNull()?.takeIf { it in 0..0xffffffffL } ?: continue
        val state = pieces[1].toLongOrNull()?.takeIf { it in 0..0xffffffffL } ?: continue
        if (state !in manifest.states) throw AtlasFrameFailure("frame-role-unsupported")
        val original = manifest.holds[id] ?: continue
        val hold = if (manifest.mirrored) manifest.holds[original.mirror] ?: original else original
        val role = hold.roles[state] ?: throw AtlasFrameFailure("frame-role-unsupported")
        if (active.size >= OverlayPolicy.MAX_ACTIVE) throw AtlasFrameFailure("frame-active-limit")
        active.add(ActiveHold(hold, role))
    }
    if (frames.isNotEmpty() && active.isEmpty()) throw AtlasFrameFailure("frame-no-matching-holds")
    return active
}

internal fun encodeHolds(holds: List<ActiveHold>): ByteBuffer {
    // Fourteen 16-byte vectors; identical to Metal Hold and GLSL std430 stride224.
    val bytes = directBytes(maxOf(1, holds.size) * 224)
    for (active in holds) {
        val hold = active.hold
        active.role.color.forEach { bytes.putFloat(it / 255) }
        bytes.putFloat(1f)
        hold.bounds.forEach { bytes.putFloat(it) }
        hold.crop.forEach { bytes.putInt(it) }
        bytes.putInt(hold.field)
        active.role.stamps.forEach { bytes.putInt(it?.offset ?: -1) }
        bytes.putFloat(hold.reach)
        bytes.putFloat(if (active.changed) 1f else 0f)
        bytes.putFloat(active.previous.toFloat())
        bytes.putFloat(active.next.toFloat())
        bytes.putInt(hold.id.toInt())
        bytes.putInt(active.role.identity.toInt())
        bytes.putInt(if (active.role.annotation) 1 else 0)
        bytes.putInt(0)
        active.role.stamps.forEach { stamp ->
            (stamp?.crop ?: intArrayOf(0, 0, 0, 0)).forEach { bytes.putInt(it) }
        }
        active.role.extraStamps.forEach { bytes.putInt(it?.offset ?: -1) }
        active.role.extraStamps.forEach { stamp ->
            (stamp?.crop ?: intArrayOf(0, 0, 0, 0)).forEach { bytes.putInt(it) }
        }
    }
    bytes.rewind()
    return bytes
}
