/**
 * quantizeTrack.ts — map MIDI tick-based note events onto a fixed step grid.
 *
 * Default resolution: 24 steps per quarter note  (= 16th-note triplet grid).
 *
 * Each step may carry:
 *   noteOns  — pitches whose note-on falls on this step
 *   noteOffs — pitches whose note-off falls on this step
 */

import type { TrackData, StepGrid } from './types.ts';

export const STEPS_PER_QN = 24;

export function quantizeTrack(
  track:           TrackData,
  ppq:             number,
  stepsPerQuarter = STEPS_PER_QN,
): StepGrid {
  const ticksPerStep = ppq / stepsPerQuarter;

  const noteOns:  Map<number, Set<number>> = new Map();
  const noteOffs: Map<number, Set<number>> = new Map();

  function addTo(map: Map<number, Set<number>>, step: number, pitch: number): void {
    let set = map.get(step);
    if (!set) { set = new Set(); map.set(step, set); }
    set.add(pitch);
  }

  let maxStep = 0;

  for (const note of track.notes) {
    const onStep  = Math.round(note.startTick / ticksPerStep);
    const offStep = Math.max(onStep + 1, Math.round(note.endTick / ticksPerStep));

    addTo(noteOns,  onStep,  note.pitch);
    addTo(noteOffs, offStep, note.pitch);

    if (offStep > maxStep) maxStep = offStep;
  }

  return { noteOns, noteOffs, totalSteps: maxStep + 1 };
}
