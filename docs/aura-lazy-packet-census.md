# Lazy packet catalogue host census

All 51 frozen catalogue configurations passed at unchanged native dimensions. The selected current/previous/next scenes contain 6/6/5 actual frame tokens, including every MoonBoard auxiliary-marker configuration and both Woods configurations with placement zero.

The final Rust 1.98 production exporter matched 471 referenced field/stamp/cover regions, 194,208 descriptor bytes, 219,612 ordered tile rows, the exact 1,028-byte LUT per configuration and 1,530 uniform samples against the frozen full-atlas references. Nine corrupted pilot outputs were rejected. No full-atlas reference was regenerated for this census.

Largest selected payload: grasshopper-1-2, 7,976,204 bytes including its global cover. Its fresh single-packet allocation model is 8,442,348 bytes for GL and 8,552,448 bytes with conservative 16 KiB Metal rounding. The Metal model includes three fence-owned 144-byte uniform buffers, each rounded to 16 KiB; GL uses one 144-byte UBO. These models do not measure physical allocation, retained generations, simultaneous views, cache residency, comparison targets, OS drawables or driver internals. Runtime retains its 128 MiB application-owned aggregate budget.

Exporter host preparation observations were 4.939–13.237 ms (median 9.166 ms) while a concurrent Rust archive build was running. These single observations include output writing and establish no phone latency or speed comparison.

This is a selected-trio byte/encoder census. It is not 128-lit worst-case, all-theme or actual GPU image certification. One rich Metal/GLES image golden and final phone performance remain separate release gates. It grants no family rollout.

Production CLI SHA256: `42e62614f1e60df7bdec3120d47c4fcfd0fe03fc32e90b009a3cf422b92d897e`. Contract SHA256: `d87cba306e3092af094cb494f3c9d64b95adcdbb3e84b7f7a149351fa1a5914e`. Raw census SHA256: `133f89157326ae57b28901db1c65fd8dc5c25c00d8fa638a00e340481378ac8f`.

The raw census and first compact report retain their historical one-uniform model. [the allocation amendment](aura-lazy-packet-allocation-amendment.json) documents the final three-buffer correction without rerunning or relabelling the byte evidence.

The [per-configuration report](aura-lazy-packet-census.json) includes the corrected allocation model and original evidence hashes. Those hashes pin this host census; subsequent golden-exporter control support does not alter the production core or FFI.
