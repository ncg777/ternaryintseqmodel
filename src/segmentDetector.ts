/**
 * segmentDetector.ts — detect structural boundaries in a balanced-ternary
 * sequence using sliding-window metrics.
 *
 * Three signals drive boundary detection:
 *   1. Symbol entropy    — Shannon entropy of the distribution of step values.
 *   2. Difference entropy — entropy of the first-difference sequence.
 *   3. Periodicity score — mean autocorrelation at several musical lags.
 *
 * Adjacent-window deltas are scored; peaks above the 80th-percentile become
 * boundary candidates.  Nearby candidates (within 16 steps) are merged.
 */

import { entropy } from './utils.ts';

function windowEntropy(window: bigint[]): number {
  const counts = new Map<string, number>();
  for (const v of window) {
    const key = v.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entropy(counts);
}

function diffEntropy(window: bigint[]): number {
  if (window.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 1; i < window.length; i++) {
    const d = (window[i] - window[i - 1]).toString();
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return entropy(counts);
}

function periodicityScore(window: bigint[]): number {
  const lags = [4, 8, 12, 16, 24, 32];
  const n = window.length;
  let total = 0, count = 0;
  for (const lag of lags) {
    if (lag >= n) continue;
    let matches = 0;
    for (let i = 0; i < n - lag; i++) {
      if (window[i] === window[i + lag]) matches++;
    }
    total += matches / (n - lag);
    count++;
  }
  return count > 0 ? total / count : 0;
}

/**
 * Detect structural boundaries in a balanced-ternary sequence.
 * Returns a sorted array of step indices that includes 0 and sequence.length.
 */
export function detectBoundaries(
  sequence:   bigint[],
  windowSize = 64,
  stride     = 8,
): number[] {
  const n = sequence.length;

  if (n < windowSize * 2) {
    return [0, n];
  }

  const windowStarts:  number[] = [];
  const entropies:     number[] = [];
  const diffEntropies: number[] = [];
  const periodicities: number[] = [];

  for (let start = 0; start + windowSize <= n; start += stride) {
    const w = sequence.slice(start, start + windowSize);
    windowStarts.push(start);
    entropies.push(windowEntropy(w));
    diffEntropies.push(diffEntropy(w));
    periodicities.push(periodicityScore(w));
  }

  if (windowStarts.length < 2) return [0, n];

  // Score each boundary between adjacent windows
  const scores: number[] = [];
  for (let i = 0; i < windowStarts.length - 1; i++) {
    const dH   = Math.abs(entropies[i + 1]     - entropies[i]);
    const dD   = Math.abs(diffEntropies[i + 1] - diffEntropies[i]);
    const dP   = Math.max(0, periodicities[i]  - periodicities[i + 1]);
    scores.push(dH + dD + dP);
  }

  // Threshold = 80th-percentile of score distribution
  const sorted    = [...scores].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.80)] ?? 0;

  const rawBoundaries: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] >= threshold && scores[i] > 0) {
      rawBoundaries.push(windowStarts[i + 1]);
    }
  }

  // Merge candidates within 16 steps
  rawBoundaries.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const b of rawBoundaries) {
    if (merged.length === 0 || b - merged[merged.length - 1] >= 16) {
      merged.push(b);
    }
  }

  const result = new Set([0, n, ...merged]);
  return [...result].sort((a, b) => a - b);
}
