package com.boardsesh.sprayeditorinput

import android.view.KeyEvent

/** A shortcut as the matcher needs it: no Expo types, so the JVM tests can build one. */
data class ShortcutKey(val id: String, val input: String, val modifiers: Set<String>)

/**
 * Which shortcut, if any, a key press is. Pure: it takes the key press as
 * plain values rather than a [KeyEvent], so it runs in a JVM unit test (the
 * `KEYCODE_*` constants are inlined at compile time; no Android method runs).
 *
 * `command` matches Ctrl or Meta, because an Android keyboard's undo is Ctrl+Z
 * and a Chromebook's search/Meta key plays the Command role too. Every other
 * modifier has to match exactly, so Ctrl+Z (undo) and Ctrl+Shift+Z (redo)
 * stay apart and a plain `a` does not fire on Alt+A.
 */
object SprayShortcutMatcher {
    fun match(
        keys: List<ShortcutKey>,
        keyCode: Int,
        /** `KeyEvent.getUnicodeChar(0)`: the key's character with no modifier applied, or 0. */
        baseChar: Int,
        ctrlDown: Boolean,
        metaDown: Boolean,
        shiftDown: Boolean,
        altDown: Boolean,
    ): String? {
        val commandDown = ctrlDown || metaDown
        return keys.firstOrNull { key ->
            key.modifiers.contains("command") == commandDown &&
                key.modifiers.contains("shift") == shiftDown &&
                key.modifiers.contains("option") == altDown &&
                inputMatches(key.input, keyCode, baseChar)
        }?.id
    }

    private fun inputMatches(input: String, keyCode: Int, baseChar: Int): Boolean =
        when (input) {
            "escape" -> keyCode == KeyEvent.KEYCODE_ESCAPE
            "return" -> keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
            "backspace" -> keyCode == KeyEvent.KEYCODE_DEL
            "delete" -> keyCode == KeyEvent.KEYCODE_FORWARD_DEL
            else -> input.length == 1 && baseChar != 0 && Character.toLowerCase(baseChar) == input[0].code
        }
}
