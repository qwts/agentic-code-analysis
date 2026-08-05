import { fetchJson } from './http.ts';

export interface SyncResult {
  synced: string[];
  failed: string[];
}

export async function syncAll(ids: string[]): Promise<SyncResult> {
  const result: SyncResult = { synced: [], failed: [] };
  for (const id of ids) {
    try {
      await fetchJson(`/api/items/${id}`);
      result.synced.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}
