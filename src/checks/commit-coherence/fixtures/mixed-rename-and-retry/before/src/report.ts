export interface Report {
  title: string;
  rows: string[];
}

export function formatReport(report: Report): string {
  return [report.title, ...report.rows.map((row) => `- ${row}`)].join('\n');
}
