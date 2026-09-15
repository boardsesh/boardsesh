import { describe, expect, it } from 'vitest';

import { selectRfDetrOutputs, toSessionPath } from '../onnx-outputs';

describe('toSessionPath', () => {
  it('strips the file:// scheme ONNX Runtime does not accept on iOS', () => {
    expect(toSessionPath('file:///var/mobile/Containers/Data/cache/model-int8.onnx')).toBe(
      '/var/mobile/Containers/Data/cache/model-int8.onnx',
    );
  });

  it('decodes percent-escapes expo-file-system puts in a uri', () => {
    expect(toSessionPath('file:///data/user/0/Application%20Support/model.onnx')).toBe(
      '/data/user/0/Application Support/model.onnx',
    );
  });

  it('leaves a bare path alone', () => {
    expect(toSessionPath('/data/user/0/cache/model.onnx')).toBe('/data/user/0/cache/model.onnx');
  });
});

describe('selectRfDetrOutputs', () => {
  const boxes = { data: new Float32Array(8), dims: [1, 2, 4] };
  const logits = { data: new Float32Array(2), dims: [1, 2, 1] };

  it('picks the tensors by shape, whatever the exporter named them', () => {
    // The names here are deliberately wrong-way-round: RF-DETR's exporter does
    // not name outputs consistently and the manifest allows null, so anything
    // that keys on a name is a bug waiting for the next export.
    const selected = selectRfDetrOutputs({ logits: boxes, boxes: logits }, 1);

    expect(selected).toEqual({
      boxes: boxes.data,
      boxesShape: [1, 2, 4],
      logits: logits.data,
      logitsShape: [1, 2, 1],
    });
  });

  it('honours a class count other than one', () => {
    const multiclass = { data: new Float32Array(6), dims: [1, 2, 3] };

    const selected = selectRfDetrOutputs({ a: boxes, b: multiclass }, 3);

    expect(selected?.logitsShape).toEqual([1, 2, 3]);
  });

  it('takes the first tensor as boxes when a four-class model makes both shapes ambiguous', () => {
    // classes === 4 is the one shape where "last dimension 4" describes both
    // tensors. No shipped config has it (every configs.json entry is the single
    // `hold` class), but the tie-break must be the emission order RF-DETR uses —
    // boxes first — rather than whatever a future refactor leaves it as.
    const first = { data: new Float32Array(8), dims: [1, 2, 4] };
    const second = { data: new Float32Array(8), dims: [1, 2, 4] };

    const selected = selectRfDetrOutputs({ first, second }, 4);

    expect({ boxes: selected?.boxes === first.data, logits: selected?.logits === second.data }).toEqual({
      boxes: true,
      logits: true,
    });
  });

  it('returns null when the boxes tensor is missing', () => {
    expect(selectRfDetrOutputs({ logits }, 1)).toBeNull();
  });

  it('returns null when the logits tensor is missing', () => {
    expect(selectRfDetrOutputs({ boxes }, 1)).toBeNull();
  });

  it('returns null for an empty result rather than pretending it saw nothing', () => {
    expect(selectRfDetrOutputs({}, 1)).toBeNull();
  });
});
