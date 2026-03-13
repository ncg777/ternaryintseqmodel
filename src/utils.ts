/**
 * utils.ts — shared pure helpers for balanced-ternary analysis.
 */

/**
 * Convert an integer to balanced ternary.
 * Returns trits (−1, 0, 1) from least-significant to most-significant.
 * Matches the algorithm in sequencer.ts verbatim.
 */
export function toBalancedTernary(n: bigint): number[] {
  if (n === 0n) return [0];
  const trits: number[] = [];
  let v = n;
  while (v !== 0n) {
    let r = Number(((v % 3n) + 3n) % 3n); // normalise to 0, 1, or 2
    if (r === 2) {
      r = -1;
      v = (v + 1n) / 3n;
    } else {
      v = (v - BigInt(r)) / 3n;
    }
    trits.push(r);
  }
  return trits;
}

/**
 * Compact token for a BigInt step value, suitable for Markov modelling.
 *
 *   0n          →  "."            (rest / silence)
 *   non-zero    →  "3:1,7:-1"    (position:trit for non-zero trits, ascending)
 *
 * This is a lossless encoding of the set of note-on/note-off events at a step.
 */
export function tritFingerprint(n: bigint): string {
  if (n === 0n) return '.';
  const trits = toBalancedTernary(n);
  const parts: string[] = [];
  for (let i = 0; i < trits.length; i++) {
    if (trits[i] !== 0) parts.push(`${i}:${trits[i]}`);
  }
  return parts.length ? parts.join(',') : '.';
}

/**
 * Reconstruct a BigInt from a trit-fingerprint token (inverse of tritFingerprint).
 *   "."          → 0n
 *   "3:1,7:-1"   → 3^3 * 1 + 3^7 * (−1)
 */
export function fingerprintToInt(fp: string): bigint {
  if (fp === '.') return 0n;
  let val = 0n;
  for (const part of fp.split(',')) {
    const colon = part.indexOf(':');
    const pos   = BigInt(part.slice(0, colon));
    const trit  = BigInt(part.slice(colon + 1));
    let pow = 1n;
    for (let i = 0n; i < pos; i++) pow *= 3n;
    val += trit * pow;
  }
  return val;
}

/**
 * Shannon entropy (bits) of a raw count distribution.
 * Returns 0 for an empty or single-element distribution.
 */
export function entropy(counts: Map<string, number>): number {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts.values()) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}
