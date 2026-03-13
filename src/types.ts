// types.ts — shared types for the MIDI segment extraction pipeline

/** Metadata extracted from a MIDI file header. */
export interface MidiFileInfo {
  path:        string;
  filename:    string;
  bpm:         number;
  numerator:   number;   // time signature numerator
  denominator: number;   // time signature denominator
  ppq:         number;   // pulses per quarter note
}

/** A single note event expressed in MIDI ticks. */
export interface NoteEvent {
  pitch:     number;   // MIDI note number 0–127
  startTick: number;
  endTick:   number;
}

/** One track from a parsed MIDI file, after active-track filtering. */
export interface TrackData {
  notes:      NoteEvent[];
  source:     string;    // basename of the originating file
  trackIndex: number;
}

/** Step-grid representation of a quantised MIDI track. */
export interface StepGrid {
  /** Step index → set of pitches with note-on at that step. */
  noteOns:    Map<number, Set<number>>;
  /** Step index → set of pitches with note-off at that step. */
  noteOffs:   Map<number, Set<number>>;
  totalSteps: number;
}

/** A segment record ready to be written to MIDI_SEGMENTS.db. */
export interface SegmentRecord {
  source:      string;
  startStep:   number;
  endStep:     number;
  tritLo:      number;
  tritHi:      number;
  forte:       string;
  octave:      number;
  bpm:         number;
  numerator:   number;
  denominator: number;
  steps:       number;
  /** Balanced-ternary integers as decimal strings (scale-relative trit positions). */
  sequence:    string[];
}

