/**
 * parseMidi.ts — parse a MIDI file and return filtered track data.
 *
 * Uses @tonejs/midi which exposes tick-accurate note data.
 * Applies the active-track filter defined in the Dataset Rebuild Plan:
 *   • minimum 16 notes per track
 *   • density ≥ 0.01 (note-on steps / total steps, approximate)
 *   • more than one unique pitch (not a single-pitch drone)
 *   • skip channel 9 (General MIDI percussion)
 */

import { readFileSync } from 'fs';
import path from 'path';
import ToneMidi from '@tonejs/midi';
const { Midi } = ToneMidi as unknown as { Midi: typeof import('@tonejs/midi').Midi };
import type { MidiFileInfo, NoteEvent, TrackData } from './types.ts';

const MIN_NOTES    = 16;
const MIN_DENSITY  = 0.01;
const STEPS_PER_QN = 24;   // used only for density estimation

export function parseMidiFile(
  filePath: string,
): { fileInfo: MidiFileInfo; tracks: TrackData[] } | null {
  let midi: Midi;
  try {
    midi = new Midi(readFileSync(filePath));
  } catch {
    return null;
  }

  const bpm = midi.header.tempos.length > 0
    ? midi.header.tempos[0].bpm
    : 120;

  const tsSig = midi.header.timeSignatures.length > 0
    ? midi.header.timeSignatures[0].timeSignature
    : ([4, 4] as [number, number]);

  const ppq = midi.header.ppq;

  const fileInfo: MidiFileInfo = {
    path:        filePath,
    filename:    path.basename(filePath),
    bpm,
    numerator:   tsSig[0],
    denominator: tsSig[1],
    ppq,
  };

  const tracks: TrackData[] = [];

  for (let ti = 0; ti < midi.tracks.length; ti++) {
    const track = midi.tracks[ti];

    if (!track.notes.length) continue;
    if (track.channel === 9) continue;   // skip percussion

    const notes: NoteEvent[] = track.notes.map(n => ({
      pitch:     n.midi,
      startTick: n.ticks,
      endTick:   n.ticks + n.durationTicks,
    }));

    if (notes.length < MIN_NOTES) continue;

    const pitchSet = new Set(notes.map(n => n.pitch));
    if (pitchSet.size === 1) continue;   // single repeating pitch

    // Approximate density: unique note-on steps / total steps at 24 spq
    const ticksPerStep = ppq / STEPS_PER_QN;
    const lastTick = Math.max(...notes.map(n => n.endTick));
    const totalSteps = Math.max(1, Math.round(lastTick / ticksPerStep));
    const noteOnSteps = new Set(notes.map(n => Math.round(n.startTick / ticksPerStep))).size;
    if (noteOnSteps / totalSteps < MIN_DENSITY) continue;

    tracks.push({ notes, source: path.basename(filePath), trackIndex: ti });
  }

  return tracks.length > 0 ? { fileInfo, tracks } : null;
}
