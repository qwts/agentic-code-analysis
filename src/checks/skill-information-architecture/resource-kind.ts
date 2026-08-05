// Pinned check-local opaque-resource classifier. The corpus intentionally
// reads bounded bytes as UTF-8; this layer prevents binary mojibake from
// becoming judge evidence or a token-cost claim.
const OPAQUE_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.bmp', '.doc', '.docx', '.gif', '.gz', '.ico',
  '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.pdf', '.png', '.ppt', '.pptx',
  '.tar', '.webm', '.webp', '.xls', '.xlsx', '.zip',
]);

export const RESOURCE_CLASSIFIER_VERSION = 'skill-resource-kind-v1';

export function isOpaqueResource(path: string, content: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot !== -1 && OPAQUE_EXTENSIONS.has(path.slice(dot).toLowerCase())) return true;
  const sample = content.slice(0, 8192);
  if (sample.includes('\0') || sample.includes('\uFFFD')) return true;
  let controls = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code < 32 && char !== '\n' && char !== '\r' && char !== '\t' && char !== '\f') controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}
