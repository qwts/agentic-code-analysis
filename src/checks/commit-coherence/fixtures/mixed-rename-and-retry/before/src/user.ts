import { fetchJson } from './http.ts';
import { formatReport, type Report } from './report.ts';

export async function userReport(id: string): Promise<string> {
  const user = (await fetchJson(`/api/users/${id}`)) as { name: string; logins: string[] };
  const report: Report = { title: user.name, rows: user.logins };
  return formatReport(report);
}
