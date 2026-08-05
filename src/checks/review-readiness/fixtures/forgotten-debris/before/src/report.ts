export interface ReportRow {
  name: string;
  total: number;
}

export function renderReport(rows: ReportRow[]): string {
  const lines = rows.map((row) => `${row.name}: ${row.total}`);
  return lines.join('\n');
}
