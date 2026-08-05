export interface Report {
  title: string;
  rows: string[];
}

export function renderReport(report: Report): string {
  return [report.title, ...report.rows.map((row) => `- ${row}`)].join('\n');
}
