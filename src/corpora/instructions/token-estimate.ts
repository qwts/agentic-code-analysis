// Token accounting: the estimator port's pinned production default and the
// estimate/summation helpers. Counts are estimates against a fixed offline
// reference encoding — never a claim about any host's real tokenizer
// (docs/references/instruction-conventions.md, 'Token estimation').

import { Tiktoken } from 'js-tiktoken';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import type { TokenEstimate } from './model.ts';
import type { TokenEstimator } from './ports.ts';

export const DEFAULT_ESTIMATOR_ID = 'js-tiktoken@1.0.21/o200k_base';

let encoding: Tiktoken | null = null;

/** Pinned reference estimator; the encoding is built once, lazily. */
export const defaultEstimator: TokenEstimator = {
  id: DEFAULT_ESTIMATOR_ID,
  estimate(text) {
    encoding ??= new Tiktoken(o200kBase);
    return encoding.encode(text).length;
  },
};

export function makeEstimate(estimator: TokenEstimator, text: string): TokenEstimate {
  return { count: estimator.estimate(text), estimated: true, estimator: estimator.id };
}

/** Sum of charged segments; refuses to mix estimator identities. */
export function sumEstimates(
  estimatorId: string,
  estimates: readonly TokenEstimate[],
): TokenEstimate {
  let count = 0;
  for (const estimate of estimates) {
    if (estimate.estimator !== estimatorId) {
      throw new Error(
        `cannot sum estimates from ${estimate.estimator} into a ${estimatorId} total`,
      );
    }
    count += estimate.count;
  }
  return { count, estimated: true, estimator: estimatorId };
}
