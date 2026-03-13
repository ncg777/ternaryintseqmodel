/**
 * segmentAligner.ts — nudge a segment start to the nearest natural phrase
 * boundary by trying small offsets and scoring each candidate position.
 *
 * Scoring heuristic: positions where the opening steps contain note-on events
 * feel like natural phrase starts.  A small bias toward the zero offset
 * prevents unnecessary shifts when scores are similar.
 */

import { toBalancedTernary } from './utils.ts';

/**
 * Find the best alignment offset for a segment window [start, end) within
 * `sequence`.
 *
 * @returns offset to add to `start` (may be negative).
 */
export function alignSegment(
  sequence: bigint[],
  start:    number,
  end:      number,
  maxShift = 16,
): number {
  const minLen = 16;
  let bestOffset = 0;
  let bestScore  = -Infinity;

  for (let offset = -maxShift; offset <= maxShift; offset++) {
    const candidate = start + offset;
    if (candidate < 0 || end - candidate < minLen) continue;

    // Count note-on events in the first 4 steps at this candidate start
    let score = 0;
    const look = Math.min(4, end - candidate);
    for (let s = 0; s < look; s++) {
      const v = sequence[candidate + s];
      if (!v || v === 0n) continue;
      const trits = toBalancedTernary(v);
      for (const t of trits) if (t === 1) score++;
    }

    // Small bias toward zero offset to avoid unnecessary shifts
    const biased = score - Math.abs(offset) * 0.1;
    if (biased > bestScore) {
      bestScore  = biased;
      bestOffset = offset;
    }
  }

  return bestOffset;
}
