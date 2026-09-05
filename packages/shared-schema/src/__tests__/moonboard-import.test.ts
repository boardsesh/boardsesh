// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vitest';
import { classifyMoonBoardLogRow, parseMoonBoardExportCsv } from '../moonboard-import';

const SAMPLE_CSV = `FirstName,Cathal,,,,
LastName,Tone,,,,
SetterName,cathaltone,,,,
UserName,cathaltone,,,,
City,Galway,,,,
Country,Ireland,,,,
,,,,,
ProblemId,Grade,Tries,Attempts,Rating,Date
309386,6A+,Flashed,0,4,25/07/20
309231,6A+,2nd try,0,4,25/07/20
580006,7A,Session Flash,0,5,13/02/26
580007,7A,Project,6,0,13/02/26
580008,7A,Fail,1,,13/02/26
`;

describe('parseMoonBoardExportCsv', () => {
  it('parses metadata, log rows, and preview counts from a MoonBoard export', () => {
    const result = parseMoonBoardExportCsv(SAMPLE_CSV);

    expect(result.data.user).toEqual({
      firstName: 'Cathal',
      lastName: 'Tone',
      setterName: 'cathaltone',
      username: 'cathaltone',
      city: 'Galway',
      country: 'Ireland',
    });
    expect(result.data.logs).toHaveLength(5);
    expect(result.data.logs[0]).toMatchObject({
      lineNumber: 9,
      problemId: 309386,
      grade: '6A+',
      tries: 'Flashed',
      attempts: 0,
      rating: 4,
      date: '25/07/20',
    });
    expect(result.preview).toEqual({
      username: 'cathaltone',
      rows: 5,
      sends: 3,
      flashes: 1,
      attempts: 2,
      projects: 1,
      fails: 1,
      angle: 40,
    });
  });

  it('classifies Session Flash as a send and projects as failed attempts', () => {
    const { logs } = parseMoonBoardExportCsv(SAMPLE_CSV).data;

    expect(classifyMoonBoardLogRow(logs[0])).toEqual({ status: 'flash', attemptCount: 1 });
    expect(classifyMoonBoardLogRow(logs[1])).toEqual({ status: 'send', attemptCount: 2 });
    expect(classifyMoonBoardLogRow(logs[2])).toEqual({ status: 'send', attemptCount: 1 });
    expect(classifyMoonBoardLogRow(logs[3])).toEqual({ status: 'attempt', attemptCount: 6 });
    expect(classifyMoonBoardLogRow(logs[4])).toEqual({ status: 'attempt', attemptCount: 1 });
  });

  it('rejects files without the MoonBoard log header', () => {
    expect(() => parseMoonBoardExportCsv('Problem,Grade\n1,6A')).toThrow('missing_moonboard_log_header');
  });
});
