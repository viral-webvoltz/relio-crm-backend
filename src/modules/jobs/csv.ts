// Minimal RFC 4180 CSV reader/writer (no dependency): quoted fields, embedded commas/quotes/newlines, CRLF/LF/CR, leading BOM.

export class CsvParseError extends Error {}
export class CsvTooManyRowsError extends CsvParseError {}

export const CSV_BOM = String.fromCharCode(0xfeff);

export function parseCsv(input: string, { maxRows = Infinity }: { maxRows?: number } = {}): string[][] {
  const text = input.startsWith(CSV_BOM) ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = () => {
    // Blank lines are not records.
    const blank = row.length === 0 && field === '' && !fieldWasQuoted;
    endField();
    if (!blank) rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new CsvTooManyRowsError(`CSV has more than ${maxRows} rows`);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === ',') endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (inQuotes) throw new CsvParseError('Unterminated quoted field');
  if (field !== '' || row.length > 0 || fieldWasQuoted) endRow();
  return rows;
}

const needsQuoting = /[",\r\n]/;
// Spreadsheet formula injection: cells that start with these are evaluated by Excel/Sheets.
const formulaStart = /^[=+\-@\t\r]/;

// Only real strings are neutralised, so numbers like -5 stay numeric.
export function csvLine(cells: readonly unknown[], { neutralizeFormulas = true }: { neutralizeFormulas?: boolean } = {}): string {
  return (
    cells
      .map((value) => {
        const cell = cellText(value);
        const safe = neutralizeFormulas && typeof value === 'string' && formulaStart.test(cell) ? `'${cell}` : cell;
        return needsQuoting.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
      })
      .join(',') + '\r\n'
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}
