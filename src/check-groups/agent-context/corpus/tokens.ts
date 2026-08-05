// Token accounting port and the pinned reference estimator. Counts are
// reference estimates for comparison, never billing claims — every estimate
// carries `estimated: true` and the estimator id, and exact UTF-8 bytes ride
// alongside. heuristic-v1 = ceil(utf8Bytes / 4), measured against
// js-tiktoken@1.0.21 o200k_base on a nine-sample instruction/code/unicode
// corpus: mean signed error +0.7%, mean absolute 7.6%, worst −25% (dense
// JSON). Zero dependencies is the point (design doc, token accounting); the
// port exists so a consumer can inject a real tokenizer.
import type { TokenEstimate } from './model.ts';

export interface TokenEstimator {
  readonly id: string;
  estimate(text: string): TokenEstimate;
}

export const referenceEstimator: TokenEstimator = {
  id: 'heuristic-v1',
  estimate(text: string): TokenEstimate {
    const bytes = Buffer.byteLength(text, 'utf8');
    return { tokens: Math.ceil(bytes / 4), bytes, estimated: true, estimator: this.id };
  },
};
