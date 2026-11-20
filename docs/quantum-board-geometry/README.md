# Fixed Quantum geometry

`catalogue-snapshot.json` is the temporary bootstrap source the user approved for this PR. Its provenance block records the pinned CruxCoach publisher, event, compressed snapshot hash and acquisition evidence. That verification establishes publisher provenance. It does not establish a Walltopia signature, direct eWalls acquisition, licensing terms or physical hardware testing. Direct vendor integration remains a follow-up while its contract is obtained.

Generate the committed constants without network or database access:

```sh
vp exec node --import tsx packages/board-constants/scripts/generate-quantum-geometry.ts
```

The generator follows the existing Woods source-to-constants pattern. It validates the complete source, emits ordinary layout/set hold tuples and per-layout/size LED lookup tables, and writes checksummed metadata. The large data module loads only when Quantum geometry is requested. Drift tests compare both generated artifacts to this source.

XL, L and M use layout `9101`, product `91`, sizes `9201`, `9202` and `9203`. All source holds shared across those sizes have identical UUID, source placement/autocad address, LED node, type and coordinates. Their canonical placement IDs therefore share one namespace: `1_000_000 + sourcePlacementId`. Size-specific LED membership determines which holds exist; a bounding rectangle alone does not determine climb compatibility. S uses layout `9104` / product `94`; Belay uses layout `9105` / product `95`.

The current snapshot contains 657 XL, 549 L, 432 M, 252 S and 1264 Belay diode rows. `placementId === autocadId` in every row. The controller's advertised rows/columns identify its protocol model; they do not define the physical render aspect. Rendering preserves the source-coordinate bounds, including the separate Belay map. Those bounds are exporter metadata, without a claim of manufacturer calibration or measured physical dimensions.

`QUANTUM_GEOMETRY_SOURCE_SHA256` hashes the exact source file bytes, including provenance. `QUANTUM_GEOMETRY_SHA256` hashes the generated model metadata, hold tuples and LED tables. `QUANTUM_HARDWARE_FINGERPRINT` is the backend's import fence and excludes routes, import time and manifest/provenance metadata:

- Sort model rows by model, then serialize `[model, canonicalLayoutId, productSizeId, name, columns, rows, forcedType, edgeLeft, edgeRight, edgeBottom, edgeTop]`.
- Sort diode rows by model, source placement ID and UUID, then serialize `[model, diodeUuid, placementId, ledNode, autocadId, holdType, x, y, z]`.
- SHA-256 hash `JSON.stringify([modelRows, diodeRows])`. Bounds and coordinates retain their raw source numbers in this fingerprint. Only internal layout/size IDs normalize through the model constants.

Database coordinates and the shipped map use the same `Math.trunc(coordinate * 1000)` integer scale. The backend rejects a hardware fingerprint mismatch before the first import can write catalogue rows. Route/catalogue updates can continue while this fixed hardware map stays the same. Clients do not fetch, register, replace or persist Quantum geometry at runtime. Angle options still use the existing generic catalogue query: they describe observed climb angles, rather than an invented mechanical angle range.
