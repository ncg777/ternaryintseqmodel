/**
 * ternaryEncoder.ts — encode a StepGrid into a balanced-ternary integer
 * sequence and provide an inverse decoder.
 *
 * Encoding convention (absolute MIDI pitch as trit index):
 *   trit position p = MIDI pitch p
 *   trit value  +1  = note-on  at that pitch this step
 *   trit value  −1  = note-off at that pitch this step
 *   trit value   0  = no event at that pitch this step
 *
 * step value = Σ  trit_value(p) × 3^p  for all p with events
 *
 * Values are stored as bigint internally; the pipeline converts to strings
 * before writing to MIDI_SEGMENTS.db.
 */

import type { StepGrid } from './types.ts';
import { toBalancedTernary } from './utils.ts';

/** Encode a quantised step grid into row of BigInt step values. */
export function encodeStepGrid(grid: StepGrid): bigint[] {
  const seq: bigint[] = [];

  for (let step = 0; step < grid.totalSteps; step++) {
    let val = 0n;
    const ons  = grid.noteOns.get(step);
    const offs = grid.noteOffs.get(step);
    if (ons)  for (const p of ons)  val += 3n ** BigInt(p);
    if (offs) for (const p of offs) val -= 3n ** BigInt(p);
    seq.push(val);
  }

  return seq;
}

/**
 * Decode a balanced-ternary step value into note-on / note-off pitch lists.
 * Trit positions correspond to absolute MIDI pitches.
 */
export function decodeStep(n: bigint): { noteOns: number[]; noteOffs: number[] } {
  if (n === 0n) return { noteOns: [], noteOffs: [] };

  const noteOns:  number[] = [];
  const noteOffs: number[] = [];
  const trits = toBalancedTernary(n);

  for (let i = 0; i < trits.length; i++) {
    if      (trits[i] ===  1) noteOns.push(i);
    else if (trits[i] === -1) noteOffs.push(i);
  }

  return { noteOns, noteOffs };
}
