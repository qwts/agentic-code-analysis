import { defaultPolicy, withRetry, type RetryPolicy } from './retry.ts';

export async function fetchJson(url: string, policy: RetryPolicy = defaultPolicy): Promise<unknown> {
  return withRetry(policy, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    return response.json();
  });
}

export async function fetchText(url: string, policy: RetryPolicy = defaultPolicy): Promise<string> {
  return withRetry(policy, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    return response.text();
  });
}
