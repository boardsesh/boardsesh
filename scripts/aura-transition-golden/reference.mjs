import { requireCondition as check } from './lib.mjs';
import { isDeepStrictEqual } from 'node:util';
const NONE = 0xffffffff;
const crop = (stamp) => (stamp ? [stamp.x, stamp.y, stamp.width, stamp.height] : [0, 0, 0, 0]);
const stamps = (role) => [...role.fillPasses, role.plate, ...role.glyphPasses];
const same = (first, second, message) => check(isDeepStrictEqual(first, second), message);
export function referencePacket(manifest, request, packet, chunks, oldPixels, newPixels, resources) {
  check(manifest.covers === null, 'This fixture intentionally has no LED covers');
  check(manifest.mirrored === false, 'Display-mirror controls do not change physical placement lookup');
  const holds = new Map(manifest.holds.map((hold) => [hold.id, hold]));
  const roles = new Map();
  for (const hold of manifest.holds) {
    const decoded = new Map();
    for (let role of hold.roles) {
      if ('alias' in role) {
        check(decoded.has(role.alias), 'Unknown/forward legacy role alias');
        role = { ...decoded.get(role.alias), state: role.state };
      }
      decoded.set(role.state, role);
    }
    roles.set(hold.id, decoded);
  }
  const frames = (text) => {
    const tokens = [...text.matchAll(/p(\d+)r(\d+)/g)];
    check(tokens.map((token) => token[0]).join('') === text, 'Malformed fixture frames');
    return tokens.map((token) => {
      const hold = Number(token[1]),
        state = Number(token[2]);
      check(holds.has(hold) && roles.get(hold).has(state), 'Fixture references missing catalogue role/hold');
      return { hold, state, role: roles.get(hold).get(state) };
    });
  };
  const scenes = [request.current, request.previous, request.next].map(frames);
  same(
    scenes.map((scene) => scene.length),
    [6, 7, 7],
    'Actual rich trio counts changed',
  );
  const membershipMaps = scenes.map(
    (scene) => new Map(scene.map((selected) => [selected.hold, selected.role.identity])),
  );
  const baseline = new Map(request.edit_baseline);
  const fieldChunks = new Map(),
    roleChunks = new Map();
  let cursor = 0,
    regions = 0;
  const compareRegion = (actual, offset, length) => {
    check(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset + length <= oldPixels.length &&
        actual.length === length &&
        actual.equals(oldPixels.subarray(offset, offset + length)),
      'Selected raster bytes changed',
    );
    regions++;
  };
  for (const chunk of chunks) {
    const layout = chunk.layout;
    check(
      chunk.sourceOffset === cursor && layout.bytes >= 0 && cursor + layout.bytes <= newPixels.length,
      'Invalid chunk range',
    );
    const pixels = newPixels.subarray(cursor, cursor + layout.bytes);
    cursor += layout.bytes;
    if (layout.field) {
      const hold = holds.get(layout.field.id);
      same(
        layout.field,
        { id: hold.id, crop: crop(hold), bounds: hold.bounds, reach: hold.reach },
        'Field layout changed',
      );
      check(!fieldChunks.has(hold.id), 'Duplicate field chunk');
      compareRegion(pixels, hold.field, hold.width * hold.height * 4);
      fieldChunks.set(hold.id, chunk);
    } else {
      check(layout.role && !layout.covers, 'Unexpected cover/unlit chunk');
      const actual = layout.role,
        role = roles.get(actual.hold.id).get(actual.identity);
      const hold = holds.get(actual.hold.id);
      same(
        actual.hold,
        { id: hold.id, crop: crop(hold), bounds: hold.bounds, reach: hold.reach },
        'Role hold layout changed',
      );
      same(actual.color, role.color, 'Role color changed');
      check(actual.annotation === role.annotation, 'Role annotation changed');
      const originals = stamps(role),
        prepared = [...actual.fills, actual.plate, ...actual.glyphs];
      const begin = Math.min(...originals.filter(Boolean).map((stamp) => stamp.offset), Infinity);
      let end = Number.isFinite(begin) ? begin : 0;
      originals.forEach((stamp, index) => {
        if (!stamp) {
          check(prepared[index] === null, 'Unexpected stamp');
          return;
        }
        same(crop(prepared[index]), crop(stamp), 'Stamp crop changed');
        check(prepared[index].offset === stamp.offset - begin, 'Stamp relocation changed');
        const length = stamp.width * stamp.height * 4;
        compareRegion(pixels.subarray(prepared[index].offset, prepared[index].offset + length), stamp.offset, length);
        end = Math.max(end, stamp.offset + length);
      });
      check(layout.bytes === end - (Number.isFinite(begin) ? begin : 0), 'Unexpected unreferenced role payload');
      const key = `${hold.id}/${actual.identity}`;
      check(!roleChunks.has(key), 'Duplicate canonical role chunk');
      roleChunks.set(key, chunk);
    }
  }
  check(cursor === newPixels.length, 'Unreferenced selected pixels');
  const requiredFields = new Set(scenes.flatMap((scene) => scene.map((selected) => selected.hold)));
  const requiredRoles = new Set(
    scenes.flatMap((scene) => scene.map((selected) => `${selected.hold}/${selected.role.identity}`)),
  );
  same(
    [...fieldChunks.keys()].sort((a, b) => a - b),
    [...requiredFields].sort((a, b) => a - b),
    'Unlit field materialized',
  );
  same(
    [...roleChunks.keys()].sort((first, second) => first.localeCompare(second)),
    [...requiredRoles].sort((first, second) => first.localeCompare(second)),
    'Unlit canonical role materialized',
  );
  const counts = scenes.map((scene) => scene.length),
    reaches = [],
    layers = [],
    crops = [];
  function encode(editor, relocated) {
    const output = Buffer.alloc(counts.reduce((sum, count) => sum + Math.max(1, count) * 224, 0));
    let rowStart = 0;
    scenes.forEach((scene, slot) => {
      check(
        packet.scenes[slot].offset === rowStart && packet.scenes[slot].count === scene.length,
        'Scene offsets/counts changed',
      );
      let maximumReach = 0,
        stampLayers = 0;
      const sceneCrops = [];
      for (const { hold: id, role } of scene) {
        check(!role.annotation, 'The rich Kilter fixture must contain ordinary roles');
        const hold = holds.get(id),
          chunk = roleChunks.get(`${id}/${role.identity}`);
        const begin = Math.min(
          ...stamps(role)
            .filter(Boolean)
            .map((stamp) => stamp.offset),
          Infinity,
        );
        const offset = (stamp) =>
          stamp ? (relocated ? chunk.sourceOffset + stamp.offset - begin : stamp.offset) : NONE;
        const float = (at, number) => output.writeFloatLE(number, rowStart + at);
        const integer = (at, number) => output.writeUInt32LE(number, rowStart + at);
        role.color.forEach((channel, index) => float(index * 4, channel / 255));
        float(12, 1);
        hold.bounds.forEach((bound, index) => float(16 + index * 4, bound));
        crop(hold).forEach((coordinate, index) => integer(32 + index * 4, coordinate));
        [
          relocated ? fieldChunks.get(id).sourceOffset : hold.field,
          offset(role.fillPasses[0]),
          offset(role.plate),
          offset(role.glyphPasses[0]),
        ].forEach((address, index) => integer(48 + index * 4, address));
        const [before, after] =
          slot === 0
            ? [membershipMaps[1], membershipMaps[2]]
            : slot === 1
              ? [new Map(), membershipMaps[0]]
              : [membershipMaps[0], new Map()];
        const membership = (other) => (!other.has(id) ? 0 : other.get(id) === role.identity ? 1 : 2);
        [
          hold.reach,
          Number(slot === 0 && (editor || baseline.get(id) !== role.identity)),
          membership(before),
          membership(after),
        ].forEach((number, index) => float(64 + index * 4, number));
        [id, role.identity, 0, 0].forEach((number, index) => integer(80 + index * 4, number));
        [role.fillPasses[0], role.plate, role.glyphPasses[0]].forEach((stamp, index) =>
          crop(stamp).forEach((coordinate, component) => integer(96 + index * 16 + component * 4, coordinate)),
        );
        const extras = [...role.fillPasses.slice(1), role.glyphPasses[1]];
        extras.forEach((stamp, index) => integer(144 + index * 4, offset(stamp)));
        extras.forEach((stamp, index) =>
          crop(stamp).forEach((coordinate, component) => integer(160 + index * 16 + component * 4, coordinate)),
        );
        rowStart += 224;
        maximumReach = Math.max(maximumReach, hold.reach);
        stampLayers |=
          (role.fillPasses.some(Boolean) ? 1 : 0) | (role.plate ? 2 : 0) | (role.glyphPasses.some(Boolean) ? 4 : 0);
        sceneCrops.push([crop(hold), ...stamps(role).filter(Boolean).map(crop)]);
      }
      reaches[slot] = maximumReach;
      layers[slot] = stampLayers;
      crops[slot] = sceneCrops;
      check(
        packet.scenes[slot].max_reach === maximumReach && packet.scenes[slot].stamp_layers === stampLayers,
        'Scene reach/layers changed',
      );
    });
    return output;
  }
  const oldDescriptors = { transition: encode(false, false), editor: encode(true, false) };
  const expectedNewDescriptors = { transition: encode(false, true), editor: encode(true, true) };
  const lut = Buffer.alloc(1028);
  manifest.lut.forEach((number, index) => lut.writeFloatLE(number, index * 4));
  check(resources.subarray(0, 1028).equals(lut), 'Falloff LUT changed');
  const columns = Math.ceil(manifest.width / 32),
    rows = Math.ceil(manifest.height / 32);
  let checkedTiles = 0;
  const ranges = [[0, 1028]];
  crops.forEach((scene, slot) => {
    const directory = packet.scenes[slot].tile_directory * 4;
    check(
      directory >= 1028 && directory + rows * columns * 8 <= resources.length,
      'Tile directory outside resource bytes',
    );
    ranges.push([directory, directory + rows * columns * 8]);
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        const tile = row * columns + column,
          start = resources.readUInt32LE(directory + tile * 8) * 4,
          count = resources.readUInt32LE(directory + tile * 8 + 4);
        check(start + count * 4 <= resources.length, 'Tile index range outside resources');
        const expected = scene.flatMap((rectangles, ordinal) =>
          rectangles.some(
            ([left, top, width, height]) =>
              left < Math.min(manifest.width, (column + 1) * 32) &&
              top < Math.min(manifest.height, (row + 1) * 32) &&
              left + width > column * 32 &&
              top + height > row * 32,
          )
            ? [ordinal]
            : [],
        );
        same(
          Array.from({ length: count }, (_, index) => resources.readUInt32LE(start + index * 4)),
          expected,
          'Tile membership/order changed',
        );
        if (count) ranges.push([start, start + count * 4]);
        checkedTiles++;
      }
  });
  ranges.sort((first, second) => first[0] - second[0]);
  check(
    ranges[0][0] === 0 &&
      ranges.at(-1)[1] === resources.length &&
      ranges.every((range, index) => index === 0 || ranges[index - 1][1] === range[0]),
    'Resource ranges overlap or leave unreferenced bytes',
  );
  /** f32::EPSILON and 1 - f32::EPSILON, both exact in f32. */
  const F32_EPSILON = 2 ** -23;
  const BELOW_ONE = Math.fround(1 - F32_EPSILON);
  /** The shared same-role hold weight: the third swap weight, 1 when absent. */
  const sharedOf = (sample) => Math.fround(sample.swap?.[2] ?? 1);
  /**
   * Independent of the Rust encoder: the swap's still endpoints and veil follow
   * Reveal::progress, step by step in f32 as Rust evaluates it. Dimmed shared
   * holds keep a pair of lit climbs off the still compositor.
   */
  function progressOf(sample) {
    if (!sample.swap) return sample.progress;
    if (sample.lower === sample.upper) return 0;
    const [lowerWeight, upperWeight] = sample.swap.slice(0, 2).map(Math.fround);
    const lit = [counts[sample.lower] > 0, counts[sample.upper] > 0];
    if (lit[0] && !lit[1]) return Math.fround(1 - lowerWeight);
    if (!lit[0] && lit[1]) return upperWeight;
    const progress = Math.fround(Math.fround(Math.fround(1 - lowerWeight) + upperWeight) * 0.5);
    if (sharedOf(sample) >= 1) return progress;
    return progress < F32_EPSILON ? F32_EPSILON : progress > BELOW_ONE ? BELOW_ONE : progress;
  }
  function uniforms(sample, tiled) {
    const output = Buffer.alloc(144),
      lower = sample.lower,
      upper = sample.upper,
      progress = progressOf(sample);
    const floats = [
      manifest.width,
      manifest.height,
      counts[lower],
      Number(manifest.glow),
      ...manifest.veil.map((channel) => channel / 255),
      ...['merge', 'seam', 'seamMix', 'seamSharpness', 'fringe', 'coreShare'].map((name) => manifest[name]),
      reaches[lower],
      // tuning2.w: the swap's shared-hold weight, only when the weighted compositor runs.
      sample.swap && progress > 0 && progress < 1 ? sharedOf(sample) : 0,
    ];
    floats.forEach((number, index) => output.writeFloatLE(number, index * 4));
    [
      NONE,
      progress <= 0 ? layers[lower] : progress >= 1 ? layers[upper] : layers[lower] | layers[upper],
      tiled ? packet.scenes[lower].tile_directory : 0,
      tiled ? packet.scenes[upper].tile_directory : 0,
    ].forEach((number, index) => output.writeUInt32LE(number, 64 + index * 4));
    [
      manifest.width,
      manifest.height,
      ...(sample.swap ? sample.swap.slice(0, 2) : [0, 0]),
      progress,
      0.22,
      sample.swap ? 1 : 0,
      sample.pulse,
      counts[upper],
      reaches[upper],
      1,
      Number(sample.mirrored),
    ].forEach((number, index) => output.writeFloatLE(number, 80 + index * 4));
    return output;
  }
  const currentIds = new Set(scenes[0].map((selected) => selected.hold)),
    nextIds = new Set(scenes[2].map((selected) => selected.hold));
  const shared = scenes[0].filter((selected) => nextIds.has(selected.hold));
  const proof = {
    regionsExact: regions,
    tileRowsExact: checkedTiles,
    fields: fieldChunks.size,
    canonicalRoles: roleChunks.size,
    currentOnly: [...currentIds].filter((id) => !nextIds.has(id)).length,
    nextOnly: [...nextIds].filter((id) => !currentIds.has(id)).length,
    sameCanonical: shared.filter((selected) => selected.role.identity === membershipMaps[2].get(selected.hold)).length,
    changedCanonical: shared.filter((selected) => selected.role.identity !== membershipMaps[2].get(selected.hold))
      .length,
  };
  check(
    proof.currentOnly === 2 && proof.nextOnly === 3 && proof.sameCanonical === 3 && proof.changedCanonical === 1,
    'Rich fixture has lost required role/union cases',
  );
  // Hold classes between the current (A) and next (B) climbs, from the fixture
  // and the full catalogue manifest alone. The swap's pixel checks use them
  // with the Rust stills, never with either shader.
  const holdBox = (id) => ({ bounds: holds.get(id).bounds, reach: holds.get(id).reach });
  const swapClasses = {
    width: manifest.width,
    height: manifest.height,
    // The bare veil, as the compositor quantizes it: what a hold at weight 0 leaves.
    veil: manifest.veil.map((channel) => Math.round(Math.min(Math.max(channel / 255, 0), 1) * 255)),
    currentOnly: [...currentIds].filter((id) => !nextIds.has(id)),
    nextOnly: [...nextIds].filter((id) => !currentIds.has(id)),
    shared: shared
      .filter((selected) => selected.role.identity === membershipMaps[2].get(selected.hold))
      .map((selected) => selected.hold),
    changed: shared
      .filter((selected) => selected.role.identity !== membershipMaps[2].get(selected.hold))
      .map((selected) => selected.hold),
    holds: Object.fromEntries([...new Set([...currentIds, ...nextIds])].map((id) => [id, holdBox(id)])),
  };
  return { oldDescriptors, expectedNewDescriptors, lut, uniforms, proof, swapClasses };
}
