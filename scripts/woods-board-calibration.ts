/**
 * Measured mounting grid on the lossless Woods app v1.6 artwork (#4971).
 *
 * Positions are mounting slots, not connected-component centroids. Empty slots
 * exist beside and underneath large holds. Moving those slots onto nearby art
 * changes their meaning and cuts one physical hold into several silhouettes.
 *
 * Rows are top to bottom; each character is one baseHoldLocation (1 = a real
 * hold, 0 = empty). Ownership was checked against the photographed holds, with
 * eroded-component contact sheets resolving touching pieces. Catalog usage is
 * a cross-check only: 8x10's real holds 25, 112 and 131 have no catalog ascents.
 * The 16-column final 12x12 row is inset half a sparse-column pitch.
 *
 * The image hash prevents silently reusing this calibration after recropping
 * the source. Coordinates are board-art pixels before normalization.
 */
export type WoodsArtCalibration = {
  width: number;
  height: number;
  firstColumn: number;
  columnPitch: number;
  denseColumns: number;
  imageSha256: string;
  rowY: readonly number[];
  occupiedRows: readonly string[];
};

export const WOODS_ART_CALIBRATION: Record<'8x10' | '12x12', WoodsArtCalibration> = {
  '8x10': {
    width: 720,
    height: 1000,
    firstColumn: 42,
    columnPitch: 31.25,
    denseColumns: 21,
    imageSha256: 'ce33e72b60580ea4de2e5f49af5aa8e1ddbeb019ed4ad7e88d89b58f874e7f91',
    rowY: [
      34, 93.75, 125.0, 156.25, 187.5, 218.75, 250.0, 281.25, 312.5, 343.75, 375.0, 406.25, 437.5, 468.75, 500.0,
      531.25, 562.5, 593.75, 625.0, 656.25, 687.5, 718.75, 781.25, 843.75, 906.25,
    ],
    occupiedRows: [
      '11111111111',
      '101011111010111110101',
      '110110101111101011011',
      '111111111111111111111',
      '101111111101111111101',
      '011111111111111111110',
      '110111101111101111011',
      '011111011010110111110',
      '111111111111111111111',
      '111010111111111010111',
      '111111011101110111111',
      '111011111111111110111',
      '111111111111111111111',
      '101111011111110111101',
      '010111111111111111010',
      '111111110111011111111',
      '101010111111111010101',
      '010101011101110101010',
      '001010110010011010100',
      '110010101000101010011',
      '000101010111010101000',
      '101010101010101010101',
      '11111111111',
      '11111111111',
      '11111111111',
    ],
  },
  '12x12': {
    width: 1225,
    height: 1400,
    firstColumn: 45.8,
    columnPitch: 35,
    denseColumns: 33,
    imageSha256: '73cf172b8a3e17d895cd3bc035d371c31c612c3e563209643c9afad4eec94551',
    rowY: [
      35, 105, 175, 245, 280, 315, 350, 385, 420, 455, 490, 525, 560, 595, 630, 665, 700, 735, 770, 805, 840, 875, 910,
      945, 980, 1015, 1085, 1155, 1225, 1295, 1330,
    ],
    occupiedRows: [
      '11111111111111111',
      '11111111111111111',
      '11111111111111111',
      '101111011111110111011111110111101',
      '011111101101111101111101101111110',
      '101011101011111010111110101110101',
      '110101110110101111101011011101011',
      '111011111101010111010101111110111',
      '101111101111111101111111101111101',
      '110110111111011111110111111011011',
      '101101110111101111101111011101101',
      '110111101111011010110111101111011',
      '111110010111111111111111010011111',
      '111111111010111111111010111111111',
      '110111110111011111110111011111011',
      '101101011010111101111010110101101',
      '110101111111111010111111111101011',
      '011111101111011111110111101111110',
      '111101011111101111101111110101111',
      '101111101011110111011110101111101',
      '111111111111111111111111111111111',
      '101001011111011101110111110100101',
      '110111101110110010011011101111011',
      '101011111101011111110101111110101',
      '010100101110111101111011101001010',
      '101111111101111010111101111111101',
      '11111111111111111',
      '11111111111111111',
      '11111111111111111',
      '11111111111111111',
      '1111111111111111',
    ],
  },
};
