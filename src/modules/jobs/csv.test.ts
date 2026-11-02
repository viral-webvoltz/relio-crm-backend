import { describe, expect, it } from 'vitest';
import { CSV_BOM, CsvParseError, CsvTooManyRowsError, csvLine, parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('parses plain rows with LF, CRLF and CR', () => {
    expect(parseCsv('a,b\n1,2\r\n3,4\r5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });
  it('handles quotes, embedded commas, quotes and newlines', () => {
    expect(parseCsv('"a,b","he said ""hi""","line1\nline2"\n')).toEqual([['a,b', 'he said "hi"', 'line1\nline2']]);
  });
  it('strips a leading BOM, skips blank lines, keeps quoted empty fields', () => {
    expect(parseCsv(`${CSV_BOM}a,b\n\n1,\n""\n`)).toEqual([['a', 'b'], ['1', ''], ['']]);
  });
  it('throws on an unterminated quote and on too many rows', () => {
    expect(() => parseCsv('"abc')).toThrow(CsvParseError);
    expect(() => parseCsv('1\n2\n3', { maxRows: 2 })).toThrow(CsvTooManyRowsError);
    expect(parseCsv('1\n2', { maxRows: 2 })).toHaveLength(2);
  });
});

describe('csvLine', () => {
  it('quotes cells that need it and ends with CRLF', () => {
    expect(csvLine(['a', 'b,c', 'd"e', 'f\ng'])).toBe('a,"b,c","d""e","f\ng"\r\n');
  });
  it('writes null/undefined empty, dates as ISO, objects as JSON', () => {
    expect(csvLine([null, undefined, new Date('2026-01-01T00:00:00Z'), true, 5n])).toBe(',,2026-01-01T00:00:00.000Z,true,5\r\n');
    expect(csvLine([{ a: 1 }])).toBe('"{""a"":1}"\r\n');
  });
  it('neutralises formula-injection prefixes on strings only', () => {
    expect(csvLine(['=SUM(A1)', '+1', '-1', '@cmd'])).toBe("'=SUM(A1),'+1,'-1,'@cmd\r\n");
    expect(csvLine(['\tx'])).toBe("'\tx\r\n");
    expect(csvLine([-5, 'safe'])).toBe('-5,safe\r\n');
  });
  it('can disable neutralising', () => {
    expect(csvLine(['=1'], { neutralizeFormulas: false })).toBe('=1\r\n');
  });
  it('round-trips through parseCsv', () => {
    const row = ['a,b', 'q"uote', 'multi\nline', ''];
    expect(parseCsv(csvLine(row))).toEqual([row]);
  });
});
