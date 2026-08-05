// Reference/change intersection and the per-document evidence bundle: which
// extracted references touch a changed referent, and exactly what the judge
// is allowed to see for them. Bounded by design — hard caps on referent
// count and evidence bytes overflow explicitly (check design, "Operational
// bounds"), never truncate silently.
import type { ChangeIndex, Referent, ReferentStatus } from './change-index.ts';
import { tokenMatches, type RawReference } from './references.ts';

export const MAX_REFERENTS = 12;
export const MAX_EVIDENCE_BYTES = 128 * 1024;

export interface ReferenceRecord {
  /** Stable ordinal id (`r1`…) after sorting; the judge cites these. */
  id: string;
  kind: RawReference['kind'];
  literal: string;
  line: number;
  referentPath: string;
  status: ReferentStatus;
  renamedTo?: string;
}

export interface SelectedReferent {
  path: string;
  status: ReferentStatus;
  renamedTo?: string;
  /** Absent for deleted referents — the explicit absent marker. */
  content?: string;
}

export interface EvidenceBundle {
  references: ReferenceRecord[];
  referents: SelectedReferent[];
  /** Set when a hard cap tripped: the run degrades to an explicit warn. */
  overflow?: string;
  /** Referents that exist but could not be read: insufficient evidence. */
  unreadable: string[];
}

/** Token kinds match against head or base text — a base-only match is how a
 * removed name becomes a `referent-gone` candidate. */
function referentsFor(reference: RawReference, index: ChangeIndex): Referent[] {
  if (reference.kind === 'path') {
    const referent = index.get(reference.resolvedPath!);
    return referent ? [referent] : [];
  }
  const matches: Referent[] = [];
  for (const referent of index.values()) {
    const text = `${referent.head ?? ''}\n${referent.base ?? ''}`;
    if (tokenMatches(text, reference.kind, reference.literal)) matches.push(referent);
  }
  return matches;
}

export function buildEvidence(raws: RawReference[], index: ChangeIndex): EvidenceBundle {
  const records = new Map<string, Omit<ReferenceRecord, 'id'>>();
  for (const raw of raws) {
    for (const referent of referentsFor(raw, index)) {
      const key = `${raw.kind}\0${raw.literal}\0${referent.path}`;
      if (records.has(key)) continue;
      records.set(key, {
        kind: raw.kind,
        literal: raw.literal,
        line: raw.line,
        referentPath: referent.path,
        status: referent.status,
        ...(referent.renamedTo !== undefined ? { renamedTo: referent.renamedTo } : {}),
      });
    }
  }
  const sorted = [...records.values()].sort(
    (a, b) => a.referentPath.localeCompare(b.referentPath) || a.kind.localeCompare(b.kind) || a.literal.localeCompare(b.literal),
  );
  const references = sorted.map((record, i) => ({ id: `r${i + 1}`, ...record }));

  const referents: SelectedReferent[] = [];
  const unreadable: string[] = [];
  for (const path of [...new Set(references.map((r) => r.referentPath))].sort()) {
    const referent = index.get(path)!;
    if (referent.unreadable) unreadable.push(path);
    referents.push({
      path,
      status: referent.status,
      ...(referent.renamedTo !== undefined ? { renamedTo: referent.renamedTo } : {}),
      ...(referent.head !== undefined ? { content: referent.head } : {}),
    });
  }
  const bundle: EvidenceBundle = { references, referents, unreadable };
  if (referents.length > MAX_REFERENTS) {
    bundle.overflow = `${referents.length} selected referents exceed the cap of ${MAX_REFERENTS}`;
  } else {
    const bytes = referents.reduce((sum, r) => sum + Buffer.byteLength(r.content ?? '', 'utf8'), 0);
    if (bytes > MAX_EVIDENCE_BYTES) bundle.overflow = `${bytes} bytes of referent evidence exceed the cap of ${MAX_EVIDENCE_BYTES}`;
  }
  return bundle;
}
