package com.boardsesh.sprayeditorinput

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * The spray-wall hold editor's hardware-keyboard shortcuts on Android.
 *
 * React Native 0.86 has a JS `onKeyDown`, but it sits behind the native
 * `enableKeyEvents` feature flag, which is off in every OSS release level and
 * cannot be turned on from JS. So the editor mounts this module's view while it
 * is open, as it does on iOS: the view takes key focus, matches each key against
 * the shortcut list JS gave it ([SprayShortcutMatcher]), and reports a match as
 * `onShortcut`. Which handler a shortcut runs is decided in JS
 * (`spray-editor-shortcuts.ts`), so both platforms share one map. There is no
 * Apple Pencil here, so the Pencil events the iOS view sends are not declared.
 */
class SprayEditorInputModule : Module() {
    override fun definition() = ModuleDefinition {
        // The contract with JS: modules/spray-editor-input/src/index.ts resolves
        // this name with requireOptionalNativeModule before it asks for the view,
        // so a binary without this module renders nothing. Must match the iOS
        // Name("SprayEditorInput").
        Name("SprayEditorInput")

        View(SprayEditorKeyScopeView::class) {
            Events("onShortcut")

            Prop("commands") { view: SprayEditorKeyScopeView, commands: List<SprayShortcutCommand> ->
                view.setCommands(commands)
            }
        }
    }
}

/** One key the editor answers, as JS describes it (`NativeShortcutCommand`). */
class SprayShortcutCommand : Record {
    /** Which shortcut this is. Sent back unchanged in `onShortcut`. */
    @Field
    val id: String = ""

    /** One character, or a named key: `escape`, `return`, `backspace`, `delete`. */
    @Field
    val input: String = ""

    /** Any of `command`, `shift`, `option`, `control`. */
    @Field
    val modifiers: List<String> = emptyList()

    /** The iOS Cmd-hold overlay's title. Android has no such overlay and ignores it. */
    @Field
    val title: String = ""
}
