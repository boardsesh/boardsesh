package com.boardsesh.climboverlaygpu

import org.json.JSONArray
import org.json.JSONObject

/** JSON integers only: JSONObject.getLong would truncate fractions and accept strings. */
internal fun JSONObject.atlasUInt32(name: String): Long {
    val number = when (val raw = get(name)) {
        is Byte -> raw.toLong()
        is Short -> raw.toLong()
        is Int -> raw.toLong()
        is Long -> raw
        else -> throw IllegalArgumentException("Invalid integer atlas role $name")
    }
    require(number in 0..0xffffffffL) { "Atlas role $name outside UInt32" }
    return number
}

/** Each call owns one hold's canonical table. Alias rows never become targets. */
internal fun decodeAtlasRoles(
    entries: JSONArray,
    decodeFull: (JSONObject, Long, Long) -> AtlasRole,
): Map<Long, AtlasRole> {
    require(entries.length() <= 32) { "Too many atlas roles" }
    val roles = LinkedHashMap<Long, AtlasRole>()
    val canonical = HashMap<Long, AtlasRole>()
    for (index in 0 until entries.length()) {
        val row = entries.getJSONObject(index)
        val state = row.atlasUInt32("state")
        require(!roles.containsKey(state)) { "Duplicate atlas role state" }
        if (row.has("alias")) {
            require(row.length() == 2) { "Atlas alias may contain only state and alias" }
            val target = row.atlasUInt32("alias")
            require(state != target) { "Self-referencing atlas alias" }
            val source = canonical[target] ?: throw IllegalArgumentException("Atlas alias needs an earlier full canonical role")
            roles[state] = source.copy(state = state)
        } else {
            val identity = row.atlasUInt32("identity")
            val role = decodeFull(row, state, identity)
            require(role.state == state && role.identity == identity)
            roles[state] = role
            if (state == identity) canonical[state] = role
        }
    }
    return roles
}
