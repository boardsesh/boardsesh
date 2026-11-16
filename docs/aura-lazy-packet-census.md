# Lazy packet catalogue host census

All 51 frozen catalogue configurations passed at unchanged native dimensions. The selected current/previous/next scenes contain 6/6/5 actual frame tokens, including every MoonBoard auxiliary-marker configuration and both Woods configurations with placement zero.

The frozen Rust 1.98 census exporter matched 471 referenced field/stamp/cover regions, 194,208 descriptor bytes, 219,612 ordered tile rows, the exact 1,028-byte LUT per configuration and 1,530 uniform samples against the frozen full-atlas references. Nine corrupted pilot outputs were rejected. No full-atlas reference was regenerated for this census.

Largest selected payload: grasshopper-1-2, 7,976,204 bytes including its global cover. Its fresh single-packet allocation model is 8,442,348 bytes for GL and 8,552,448 bytes with conservative 16 KiB Metal rounding. The Metal model includes three fence-owned 144-byte uniform buffers, each rounded to 16 KiB; GL uses one 144-byte UBO. These models do not measure physical allocation, retained generations, simultaneous views, cache residency, comparison targets, OS drawables or driver internals. Runtime retains its 128 MiB application-owned aggregate budget.

Exporter host preparation observations were 4.939–13.237 ms (median 9.166 ms) while a concurrent Rust archive build was running. These single observations include output writing and establish no phone latency or speed comparison.

This is a selected-trio byte/encoder census. It is not 128-lit worst-case, all-theme or actual GPU image certification. The separately scoped rich Metal/GLES image checks are recorded below; final phone performance remains a release gate. This census grants no family rollout.

Production CLI SHA256: `42e62614f1e60df7bdec3120d47c4fcfd0fe03fc32e90b009a3cf422b92d897e`. Contract SHA256: `d87cba306e3092af094cb494f3c9d64b95adcdbb3e84b7f7a149351fa1a5914e`. Raw census SHA256: `133f89157326ae57b28901db1c65fd8dc5c25c00d8fa638a00e340481378ac8f`.

The raw census and first compact report retain their historical one-uniform model. [the allocation amendment](aura-lazy-packet-allocation-amendment.json) documents the final three-buffer correction without rerunning or relabelling the byte evidence.

The [per-configuration report](aura-lazy-packet-census.json) includes the corrected allocation model and original evidence hashes. Those hashes pin this host census; subsequent golden-exporter control support does not alter the production core or FFI.

## Final constants and kernel verification

The final contract is `ede51706c63cf2d0b543e5316c7e418e79e0f73c7f21a835f9c28fa8d4b0075f`. Rust now owns the existing 350 ms editing duration, 100 ms pulse peak, 1.35 peak reach, 0.22 reveal band and 128 MiB budget. Generated Swift/Kotlin aliases preserve the exact values and arithmetic. API 5, the 224-byte descriptor and 144-byte uniforms are unchanged.

The combined 87-file native freeze from `bcff183bdaf8648c8a80c6f23510c9e382789048` passed a fresh full Swift module typecheck, five Swift suites, 76 JVM tests, 40 workflow guards and both GLSL compiler checks. All six rebuilt Rust archives match their reviewed source; the seven architecture slices retain all 18 exports. Actual Swift and Kotlin comparisons each matched 350,001 pulse samples and 2,004,002 reveal samples bit for bit.

On the USB iPhone 13 Pro (Metal) and Pixel 8 Pro (GLES), each offscreen run compared 30 controls using the old full compositor and tiled/lazy compositor: all output bytes matched exactly. Each device also passed 14 independent Rust still/pulse references with a maximum channel difference of one byte and no larger errors. These physical runs used the earlier `d87cba30…` contract and `31a54acd…` native freeze; they are kernel checks for that rich fixture, not catalogue-wide or live-view certification.

The final `ede51706…` exporter reproduced all 34 binary inputs exactly, including pixels, descriptors, resources and 30 uniform buffers. Five JSON files differ only in contract identity. Both runtime shader sources are unchanged. This supports sampled pixel equivalence across the constants consolidation without relabelling the earlier physical runs as final-contract captures.

| Evidence | SHA256 |
| --- | --- |
| Combined final native freeze | `5aa1e9f6f30665b6b0c4a4522d37c86c524ad62362b0b64d5e2bacb643a10879` |
| Final binary-input equivalence | `4cf73a3d78b774ea6af1a7b21c4fd6820dd271aefe3230eac790e727718363fc` |
| iPhone offscreen completion | `d35abf228ad821b2a1cdee901f4d03f773c22525e7d73c091c9b419a3bd49946` |
| Pixel offscreen completion | `43cc4f8d3602fdd6220ed964d0c8cb9f04a557bcc9c24272f5ae1a1eb855105b` |

The proper baseline Release A at `5a7bc2da721edb9c585fecdf74aaf2564a77dba8`, using common instrumentation `e87f34f2…`, has been built and independently artifact-audited. Repeating the rich 30 physical Metal/GLES checks with final `ede51706…` inputs, the final candidate's proper Release build and paired phone performance remain pending. These kernel and artifact checks establish no final app latency, live arena/prefetch behaviour, retained allocation, presentation cadence or rollout acceptance. Historical phone measurements retain their original source scope and are not pooled with these results.
