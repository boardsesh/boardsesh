import { describe, expect, it } from 'vitest';
import { classifyMoonBoardLogRow, decodeMoonBoardExportBytes, parseMoonBoardExportCsv } from '../moonboard-import';

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
      angles: [40],
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

  it("reads the name-based export with Moon's newer column order", () => {
    const csv = [
      'Name,Grade,Benchmark,Setup,Configuration,Tries,Attempts,Rating,Date Climbed,Comments',
      'An easy problem,6B+,TRUE,MoonBoard 2016,40° MoonBoard,Flashed,0,4,27/06/23,',
      '"Biggy smalls",6C,FALSE,MoonBoard 2024,25° MoonBoard,> 3 tries,5,5,07/07/23,"so, so sick"',
    ].join('\r\n');

    const result = parseMoonBoardExportCsv(csv);

    expect(result.data.logs).toEqual([
      {
        lineNumber: 2,
        name: 'An easy problem',
        setup: 'MoonBoard 2016',
        angle: 40,
        isBenchmark: true,
        grade: '6B+',
        tries: 'Flashed',
        attempts: 0,
        rating: 4,
        date: '27/06/23',
      },
      {
        lineNumber: 3,
        name: 'Biggy smalls',
        setup: 'MoonBoard 2024',
        angle: 25,
        isBenchmark: false,
        comment: 'so, so sick',
        grade: '6C',
        tries: '> 3 tries',
        attempts: 5,
        rating: 5,
        date: '07/07/23',
      },
    ]);
    expect(result.preview.angles).toEqual([25, 40]);
    expect(classifyMoonBoardLogRow(result.data.logs[1])).toEqual({ status: 'send', attemptCount: 5 });
  });

  it('matches columns by header name, whatever order they come in', () => {
    const csv = ['Date,Rating,Tries,Grade,Problem Id,Setter', '25/07/20,4,2nd try,6a+,309231,Ben Moon'].join('\n');

    expect(parseMoonBoardExportCsv(csv).data.logs).toEqual([
      {
        lineNumber: 2,
        problemId: 309231,
        setter: 'Ben Moon',
        grade: '6A+',
        tries: '2nd try',
        attempts: 0,
        rating: 4,
        date: '25/07/20',
      },
    ]);
  });

  it('reads the degree sign even when the encoding mangled it', () => {
    const csv = ['Name,Grade,Configuration,Tries,Date', 'Klingon Easy,6B+,25\uFFFD MoonBoard,Flashed,27/06/23'].join(
      '\n',
    );

    expect(parseMoonBoardExportCsv(csv).data.logs[0].angle).toBe(25);
  });

  it('rejects a log header that cannot identify the problem', () => {
    expect(() => parseMoonBoardExportCsv('Grade,Tries,Date\n6A,Flashed,01/01/24')).toThrow(
      'missing_moonboard_log_header',
    );
  });

  it('rejects rows with neither a problem id nor a name', () => {
    expect(() => parseMoonBoardExportCsv('Name,Grade,Tries,Date\n,6A,Flashed,01/01/24')).toThrow(
      'missing_problem_line_2',
    );
  });
});

describe('decodeMoonBoardExportBytes', () => {
  it('decodes UTF-8 exports as UTF-8', () => {
    expect(decodeMoonBoardExportBytes(new TextEncoder().encode('Björk,40° MoonBoard'))).toBe('Björk,40° MoonBoard');
  });

  it('falls back to Windows-1252 for Excel exports', () => {
    // "DON’T Björk 40°" as Excel writes it: ’ is 0x92, ö is 0xF6, ° is 0xB0.
    const bytes = Uint8Array.from([
      0x44, 0x4f, 0x4e, 0x92, 0x54, 0x20, 0x42, 0x6a, 0xf6, 0x72, 0x6b, 0x20, 0x34, 0x30, 0xb0,
    ]);

    expect(decodeMoonBoardExportBytes(bytes)).toBe('DON’T Björk 40°');
  });
});
