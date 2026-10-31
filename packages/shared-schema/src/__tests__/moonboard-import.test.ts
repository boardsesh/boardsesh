import { describe, expect, it } from 'vitest';
import {
  classifyMoonBoardLogRow,
  decodeMoonBoardExportBytes,
  inspectMoonBoardExportCsv,
  parseMoonBoardCollectionCsv,
  parseMoonBoardExportCsv,
} from '../moonboard-import';

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

describe('inspectMoonBoardExportCsv', () => {
  it('locates a legacy logbook after profile metadata', () => {
    expect(inspectMoonBoardExportCsv(SAMPLE_CSV)).toMatchObject({
      kind: 'logbook',
      headerRowIndex: 7,
      headers: ['ProblemId', 'Grade', 'Tries', 'Attempts', 'Rating', 'Date'],
      columns: { problemId: 0, grade: 1, tries: 2, attempts: 3, rating: 4, date: 5 },
      rowCount: 5,
    });
  });

  it('recognizes standalone profile data without treating metadata as a table', () => {
    const csv = ['Firstname,Example', 'Username,example-setter', 'Email,example@example.test', 'AgreeTerms,TRUE'].join(
      '\n',
    );

    expect(inspectMoonBoardExportCsv(csv).kind).toBe('profile');
    expect(() => parseMoonBoardExportCsv(csv)).toThrow('missing_moonboard_log_header');
  });

  it.each([
    'Name,Grade,User Grade,Benchmark,User Rating,Active,Inserted\nExample,6C,6C,FALSE,4,TRUE,13/01/22 16:50',
    'Name,Grade,Active,Inserted,Updated,Deleted\nExample,7A,TRUE,10/05/23 16:08,14/03/24 10:34,',
  ])('recognizes named problem metadata as a collection, without inventing log fields', (csv) => {
    const inspection = inspectMoonBoardExportCsv(csv);

    expect(inspection.kind).toBe('collection');
    expect(inspection.columns).toMatchObject({ name: 0, grade: 1 });
    expect(inspection.columns.date).toBeUndefined();
    expect(inspection.columns.tries).toBeUndefined();
    expect(() => parseMoonBoardExportCsv(csv)).toThrow('missing_moonboard_log_header');
  });

  it('inspects unfamiliar headers after metadata and limits sample rows to five', () => {
    const csv = [
      'Firstname,Example',
      'Username,example-setter',
      '',
      'Route title,Difficulty,Outcome,Climbed on',
      ...Array.from({ length: 8 }, (_, index) => `Problem ${index + 1},6A,Flashed,01/01/24`),
    ].join('\n');

    expect(inspectMoonBoardExportCsv(csv)).toEqual({
      kind: 'unknown',
      headerRowIndex: 3,
      headers: ['Route title', 'Difficulty', 'Outcome', 'Climbed on'],
      columns: {},
      sampleRows: Array.from({ length: 5 }, (_, index) => [`Problem ${index + 1}`, '6A', 'Flashed', '01/01/24']),
      rowCount: 8,
    });
  });

  it('allows an explicit header row instead of interpreting a cover table', () => {
    const csv = ['Report,October', 'Route title,Difficulty', 'Example,7A'].join('\n');

    expect(inspectMoonBoardExportCsv(csv).headerRowIndex).toBe(0);
    expect(inspectMoonBoardExportCsv(csv, 1)).toMatchObject({
      headerRowIndex: 1,
      headers: ['Route title', 'Difficulty'],
      sampleRows: [['Example', '7A']],
      rowCount: 1,
    });
  });

  it.each([-1, 1.5, 10, Number.NaN])('rejects an invalid selected header index %s', (headerRowIndex) => {
    expect(() => inspectMoonBoardExportCsv('Name,Grade\nExample,7A', headerRowIndex)).toThrow('invalid_header_row');
  });

  it('handles empty files without offering an importable type', () => {
    expect(inspectMoonBoardExportCsv('')).toEqual({
      kind: 'unknown',
      headerRowIndex: 0,
      headers: [''],
      sampleRows: [],
      columns: {},
      rowCount: 0,
    });
  });
});

describe('MoonBoard column mapping', () => {
  const mappedCsv = [
    'Report,October',
    'Route title,Difficulty,Outcome,Climbed on,Spare',
    'Example,6a,Flashed,01/01/24,8',
  ].join('\n');
  const options = { headerRowIndex: 1, columns: { name: 0, grade: 1, tries: 2, date: 3 } };

  it('maps unfamiliar logbook headers and retains source record numbers', () => {
    const result = parseMoonBoardExportCsv(mappedCsv, options);

    expect(result.data.logs).toEqual([
      { lineNumber: 3, name: 'Example', grade: '6A', tries: 'Flashed', date: '01/01/24', attempts: 0, rating: null },
    ]);
    expect(result.preview).toMatchObject({ rows: 1, sends: 1, flashes: 1 });
  });

  it('uses the automatic header when only mappings are supplied', () => {
    const csv = 'Route title,Difficulty,Outcome,Climbed on\nExample,6A,Flashed,01/01/24';

    expect(parseMoonBoardExportCsv(csv, { columns: options.columns }).data.logs[0].name).toBe('Example');
  });

  it('lets a selected recognizable header retain automatic column aliases', () => {
    const csv = 'Report,October\nName,Grade,Tries,Date\nExample,6A,Flashed,01/01/24';

    expect(parseMoonBoardExportCsv(csv, { headerRowIndex: 1 }).data.logs[0].lineNumber).toBe(3);
  });

  it.each([-1, 1.5, 5, Number.NaN])('rejects an invalid mapped column index %s', (name) => {
    expect(() => parseMoonBoardExportCsv(mappedCsv, { ...options, columns: { ...options.columns, name } })).toThrow(
      'invalid_name_column',
    );
  });

  it('rejects assigning the same source column twice', () => {
    expect(() => parseMoonBoardExportCsv(mappedCsv, { ...options, columns: { ...options.columns, date: 2 } })).toThrow(
      'duplicate_date_column',
    );
  });

  it('identifies a missing required mapping instead of restoring it automatically', () => {
    expect(() =>
      parseMoonBoardExportCsv('Name,Grade,Tries,Date\nExample,6A,Flashed,01/01/24', {
        columns: { name: 0, tries: 2, date: 3 },
      }),
    ).toThrow('missing_grade_column');
    expect(() => parseMoonBoardExportCsv(mappedCsv, { ...options, columns: { grade: 1, tries: 2, date: 3 } })).toThrow(
      'missing_problem_column',
    );
  });

  it('keeps row validation and existing outcome labels when fields are manually mapped', () => {
    expect(() => parseMoonBoardExportCsv(mappedCsv.replace('Flashed', 'Sent'), options)).toThrow(
      'unsupported_tries_line_3',
    );
    expect(() => parseMoonBoardExportCsv(mappedCsv.replace('Example,6a', 'Example,'), options)).toThrow(
      'missing_grade_line_3',
    );
  });
});

describe('parseMoonBoardCollectionCsv', () => {
  it('reads the problem-metadata shape without manufacturing dates, outcomes, or holds', () => {
    const csv = [
      'Name,Grade,User Grade,Benchmark,User Rating,Active,Inserted',
      'Example,6c,6C,FALSE,4,TRUE,13/01/22 16:50',
    ].join('\n');

    expect(parseMoonBoardCollectionCsv(csv)).toEqual({
      rows: [{ lineNumber: 2, name: 'Example', grade: '6C' }],
      excluded: 0,
    });
  });

  it('preserves record order and duplicates for catalogue resolution', () => {
    const csv = 'Name,Grade\nSecond,7A\nFirst,6C\nSecond,7A';

    expect(parseMoonBoardCollectionCsv(csv).rows).toEqual([
      { lineNumber: 2, name: 'Second', grade: '7A' },
      { lineNumber: 3, name: 'First', grade: '6C' },
      { lineNumber: 4, name: 'Second', grade: '7A' },
    ]);
  });

  it('excludes inactive and deleted records while retaining source row numbers', () => {
    const csv = [
      'Name,Grade,Active,Inserted,Updated,Deleted',
      'Inactive,6C,FALSE,13/01/22 16:50,,',
      'Deleted,7A,TRUE,,,14/03/24 10:34',
      '',
      'Kept,7B,TRUE,,,',
    ].join('\n');

    expect(parseMoonBoardCollectionCsv(csv)).toEqual({
      rows: [{ lineNumber: 5, name: 'Kept', grade: '7B' }],
      excluded: 2,
    });
    expect(parseMoonBoardCollectionCsv(csv, undefined, true)).toEqual({
      rows: [
        { lineNumber: 2, name: 'Inactive', grade: '6C' },
        { lineNumber: 5, name: 'Kept', grade: '7B' },
      ],
      excluded: 1,
    });
  });

  it('does not interpret false or null deletion markers as deleted records', () => {
    const csv = [
      'Name,Grade,Deleted',
      'False flag,6A,FALSE',
      'Zero flag,6B,0',
      'Null marker,6C,null',
      'Unset,7A,-',
    ].join('\n');

    expect(parseMoonBoardCollectionCsv(csv).rows).toHaveLength(4);
  });

  it('handles BOMs, quoted commas, escaped quotes, and multiline names', () => {
    const csv = '\uFEFFName,Grade,Setter\r\n"A, ""quoted""\nproblem",6C,Example Setter\r\n';

    expect(parseMoonBoardCollectionCsv(csv).rows).toEqual([
      { lineNumber: 2, name: 'A, "quoted"\nproblem', grade: '6C', setter: 'Example Setter' },
    ]);
  });

  it('reads Windows-1252 problem names through the shared decoder', () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode('Name,Grade\nCaf'), 0xe9, 0x2c, 0x36, 0x43]);

    expect(parseMoonBoardCollectionCsv(decodeMoonBoardExportBytes(bytes)).rows[0].name).toBe('Café');
  });

  it('maps unfamiliar collection columns and optional setter information', () => {
    const csv = 'Report,October\nDifficulty,Route title,Author\n7a,Example,Some Setter';

    expect(parseMoonBoardCollectionCsv(csv, { headerRowIndex: 1, columns: { grade: 0, name: 1, setter: 2 } })).toEqual({
      rows: [{ lineNumber: 3, name: 'Example', grade: '7A', setter: 'Some Setter' }],
      excluded: 0,
    });
  });

  it('blocks collection imports without both required columns or row values', () => {
    expect(() => parseMoonBoardCollectionCsv('Name,Inserted\nExample,01/01/24')).toThrow('missing_grade_column');
    expect(() => parseMoonBoardCollectionCsv('Name,Grade\n,6C')).toThrow('missing_name_line_2');
    expect(() => parseMoonBoardCollectionCsv('Name,Grade\nExample,')).toThrow('missing_grade_line_2');
  });
});
