export interface ReportRow {
  name: string;
  total: number;
}

/** Rows render highest-total first so the biggest contributors lead. */
export function renderReport(rows: ReportRow[]): string {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const lines = sorted.map((row) => `${row.name}: ${row.total}`);
  return lines.join('\n');
}
