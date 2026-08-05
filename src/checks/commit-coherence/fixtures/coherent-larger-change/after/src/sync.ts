import { fetchJson } from './http.ts';
import { defaultPolicy, type RetryPolicy } from './retry.ts';

export interface SyncResult {
  synced: string[];
  failed: string[];
}

export async function syncAll(ids: string[], policy: RetryPolicy = defaultPolicy): Promise<SyncResult> {
  const result: SyncResult = { synced: [], failed: [] };
  for (const id of ids) {
    try {
      await fetchJson(`/api/items/${id}`, policy);
      result.synced.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}
