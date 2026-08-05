export interface ReportRow {
  name: string;
  total: number;
}

export function renderReport(rows: ReportRow[]): string {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  console.log('DBG sorted', sorted);
  const lines = sorted.map((row) => `${row.name}: ${row.total}`);
  return lines.join('\n');
}
