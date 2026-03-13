/**
 * pitchAnalyzer.ts — derive harmonic metadata from a raw segment and
 * produce a scale-relative encoding compatible with MIDI_SEGMENTS.db.
 *
 * Input:  bigint[] where trit position p = absolute MIDI pitch p
 *
 * Steps:
 *   1. Collect pitch classes (trit positions with +1 trits, mod 12).
 *   2. Resolve to a Forte pitch-class set via ultra-mega-enumerator PCS12.
 *   3. Build the Forte's full MIDI scale (pitch classes × octaves 0–10).
 *   4. Find the lowest scale index used → determines the segment's octave.
 *   5. Remap every trit position from absolute MIDI pitch to a scale-relative
 *      index (trit_new = scale_index - octave * k).
 *   6. Compute tritLo / tritHi from the remapped positions.
 *
 * Output: a scale-relative sequence stored in MIDI_SEGMENTS.db together with
 * forte, octave, tritLo, tritHi — exactly the fields expected by generate.ts
 * and the browser playback engine.
 */

import { PCS12 } from 'ultra-mega-enumerator';
import { toBalancedTernary } from './utils.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildScale(forte: string): number[] {
  const p = PCS12.parseForte(forte);
  if (!p) return [];
  const pitchClasses = p.asSequence() as number[];
  const scale: number[] = [];
  for (const pc of pitchClasses) {
    for (let oct = 0; oct <= 10; oct++) {
      const midi = pc + 12 * oct;
      if (midi < 128) scale.push(midi);
    }
  }
  return scale.sort((a, b) => a - b);
}

function encodeTrits(trits: Map<number, number>): string {
  if (trits.size === 0) return '0';
  let val = 0n;
  for (const [pos, trit] of trits) {
    if (trit !== 0) val += BigInt(trit) * (3n ** BigInt(pos));
  }
  return val.toString();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface PitchAnalysisResult {
  sequence: string[];
  forte:    string;
  octave:   number;
  tritLo:   number;
  tritHi:   number;
}

/**
 * Analyse a raw segment (absolute-MIDI-pitch trit indices) and return a
 * scale-relative encoding compatible with MIDI_SEGMENTS.db.
 */
export function analyzePitches(rawSequence: bigint[]): PitchAnalysisResult {
  // 1. Collect pitch classes from note-on trits (+1)
  const pitchClasses = new Set<number>();
  for (const n of rawSequence) {
    if (n === 0n) continue;
    const trits = toBalancedTernary(n);
    for (let i = 0; i < trits.length; i++) {
      if (trits[i] === 1) pitchClasses.add(i % 12);
    }
  }

  // 2. Resolve to Forte
  let forte: string;
  try {
    forte = pitchClasses.size === 0 ? '0-1.00' : new PCS12(pitchClasses).toString();
  } catch {
    forte = '12-1.00';
  }

  if (forte === '0-1.00') {
    return {
      sequence: rawSequence.map(() => '0'),
      forte:    '0-1.00',
      octave:   0,
      tritLo:   0,
      tritHi:   0,
    };
  }

  // 3. Build scale and reverse lookup
  const segPcs   = PCS12.parseForte(forte);
  const segScale = buildScale(forte);

  if (!segPcs || segScale.length === 0) {
    return {
      sequence: rawSequence.map(() => '0'),
      forte:    '0-1.00',
      octave:   0,
      tritLo:   0,
      tritHi:   0,
    };
  }

  const segK = segPcs.getK();

  // absolute MIDI pitch → index into segScale
  const noteToIdx = new Map<number, number>();
  for (let i = 0; i < segScale.length; i++) noteToIdx.set(segScale[i], i);

  // 4. Find minimum scale index to determine the playback octave
  let minSegIdx = Infinity;
  for (const n of rawSequence) {
    if (n === 0n) continue;
    const trits = toBalancedTernary(n);
    for (let i = 0; i < trits.length; i++) {
      if (trits[i] === 0) continue;
      const idx = noteToIdx.get(i);
      if (idx !== undefined && idx < minSegIdx) minSegIdx = idx;
    }
  }
  if (minSegIdx === Infinity) minSegIdx = 0;

  const octave  = Math.floor(minSegIdx / segK);
  const baseIdx = octave * segK;

  // 5. Remap trit positions: absolute MIDI pitch → scale-relative index
  let tritLo = Infinity, tritHi = -Infinity;
  const newSequence: string[] = [];

  for (const n of rawSequence) {
    if (n === 0n) { newSequence.push('0'); continue; }

    const trits    = toBalancedTernary(n);
    const newTrits = new Map<number, number>();

    for (let i = 0; i < trits.length; i++) {
      if (trits[i] === 0) continue;
      const scaleIdx = noteToIdx.get(i);
      if (scaleIdx === undefined) continue;          // pitch not in scale
      const newPos = scaleIdx - baseIdx;
      if (newPos < 0) continue;                      // below this octave block
      newTrits.set(newPos, trits[i]);
      if (newPos < tritLo) tritLo = newPos;
      if (newPos > tritHi) tritHi = newPos;
    }

    newSequence.push(encodeTrits(newTrits));
  }

  return {
    sequence: newSequence,
    forte,
    octave,
    tritLo: tritLo === Infinity  ? 0 : tritLo,
    tritHi: tritHi === -Infinity ? 0 : tritHi,
  };
}
