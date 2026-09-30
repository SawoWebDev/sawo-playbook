/** Splits one CSV line (RFC 4180 quoting: "a, b" and "" escapes). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Parses CSV with a header row into objects keyed by lower-cased, trimmed header names. */
export function parseCsvWithHeader(text: string): { row: number; values: Record<string, string> }[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim());
  if (headerIdx < 0) return [];
  const header = splitCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const out: { row: number; values: Record<string, string> }[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i]);
    const values: Record<string, string> = {};
    header.forEach((h, j) => {
      values[h] = (cells[j] ?? '').trim();
    });
    out.push({ row: i + 1, values });
  }
  return out;
}

/** Escapes a value for CSV export (also neutralises spreadsheet formula injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
