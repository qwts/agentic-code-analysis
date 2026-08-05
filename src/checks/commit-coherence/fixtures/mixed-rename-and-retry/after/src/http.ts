const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 250;

export async function fetchJson(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
      return await response.json();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, attempt * BACKOFF_MS));
    }
  }
  throw lastError;
}
