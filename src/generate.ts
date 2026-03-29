/**
 * generate.ts — ambient song generator.
 *
 * Selects random segments from MIDI_SEGMENTS.db, applies transformations
 * (time-stretch, pitch-flip, center-alignment, vertical split), assembles
 * them into a timeline of MIDI note events, and encodes a Standard MIDI
 * File (SMF Type 0, channel 1).
 */

import Database from 'better-sqlite3';
import { PCS12 } from 'ultra-mega-enumerator';
import { toBalancedTernary } from './utils.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GenerateParams {
  forte?:          string;   // user-chosen forte, or omit for random
  outputForte?:    string;   // forte to snap output notes to (same k as forte)
  durationSeconds: number;   // target duration in seconds [30, 36000]
  bpm?:            number;   // override BPM (40-200); omit for random ambient range
  maxVoices?:      number;   // max simultaneous segment voices (1-15, default 3)
}

export interface GenerateResult {
  midi:       Buffer;
  bpm:        number;
  forte:      string;        // resulting forte of the assembled piece
  segments:   number;        // how many segment placements were used
}

interface SegRow {
  id:          number;
  source:      string;
  start_step:  number;
  end_step:    number;
  trit_lo:     number;
  trit_hi:     number;
  forte:       string;
  octave:      number;
  bpm:         number;
  numerator:   number;
  denominator: number;
  steps:       number;
  sequence:    string;
  note_count:  number;
  phase:       number;
}

interface NoteEvent {
  tick:    number;
  note:    number;   // MIDI note 0-127
  type:    'on' | 'off';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Build a full MIDI-pitch scale from a forte string. */
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
  scale.sort((a, b) => a - b);
  return scale;
}

/**
 * Build a virtual scale that maps each index position of a segment's own
 * scale to the corresponding note in a (potentially larger) target scale.
 * Returns null if the segment's forte is not a pitch-class subset of the target.
 */
function buildRemappedScale(
  segForte: string,
  targetForte: string,
  targetScale: number[],
): number[] | null {
  const segPcs = PCS12.parseForte(segForte)?.asSequence() as number[] | undefined;
  const targetPcs = PCS12.parseForte(targetForte)?.asSequence() as number[] | undefined;
  if (!segPcs || !targetPcs) return null;

  const segK = segPcs.length;
  const targetK = targetPcs.length;

  // Check that segment PCs are a subset of target PCs
  const targetPcsSet = new Set(targetPcs);
  if (!segPcs.every(pc => targetPcsSet.has(pc))) return null;

  // Map each segment PC to its index in the target PCs
  const pcIdxInTarget = segPcs.map(pc => targetPcs.indexOf(pc));

  // Build remapped scale: same number of entries per octave as segK,
  // but each entry comes from the target scale at the mapped position
  const remapped: number[] = [];
  for (let oct = 0; oct <= 10; oct++) {
    for (let i = 0; i < segK; i++) {
      const targetIdx = oct * targetK + pcIdxInTarget[i];
      if (targetIdx < targetScale.length) {
        remapped.push(targetScale[targetIdx]);
      }
    }
  }

  return remapped;
}

/** Forte cardinality. */
function forteK(forte: string): number {
  const p = PCS12.parseForte(forte);
  return p ? p.getK() : 0;
}

/** Decode a segment's sequence into {step, note, type} events using its own scale.
 * The sequence is rotated so decoding begins at `startStep` (the stored phase).
 * This ensures wrap-around note-offs inserted by `fixNoteOffs` are included
 * at the end of the decoded timeline and that the decoded length equals the
 * original sequence length.  Ticks are normalised to start at 0.
 */
function decodeSegment(
  sequence: string[],
  scale: number[],
  baseIdx: number,
  startStep = 0,
): { events: NoteEvent[]; minNote: number; maxNote: number; noteOnCount: number } {
  const events: NoteEvent[] = [];
  let minNote = 127, maxNote = 0, noteOnCount = 0;
  const sounding = new Set<number>();

  const N = sequence.length;
  if (N === 0) return { events, minNote: 60, maxNote: 60, noteOnCount: 0 };

  // Build a rotated view of the sequence that starts at `startStep`.
  // rotated[i] === sequence[(startStep + i) % N]
  for (let r = 0; r < N; r++) {
    const stepIdx = (startStep + r) % N;
    const raw = sequence[stepIdx];
    if (raw === '0') {
      sounding.size; // no-op to keep consistent flow
      continue;
    }
    const trits = toBalancedTernary(BigInt(raw));
    for (let t = 0; t < trits.length; t++) {
      if (trits[t] === 0) continue;
      const scaleIdx = baseIdx + t;
      if (scaleIdx < 0 || scaleIdx >= scale.length) continue;
      const midiNote = scale[scaleIdx];
      if (trits[t] === 1) {
        events.push({ tick: r, note: midiNote, type: 'on' });
        noteOnCount++;
        sounding.add(midiNote);
        if (midiNote < minNote) minNote = midiNote;
        if (midiNote > maxNote) maxNote = midiNote;
      } else {
        events.push({ tick: r, note: midiNote, type: 'off' });
        sounding.delete(midiNote);
      }
    }
  }

  // Append explicit note-offs for any notes still sounding (safety).
  // These will occur at tick == N (i.e., just after the decoded sequence).
  if (sounding.size > 0) {
    const endTick = N;
    for (const note of sounding) {
      events.push({ tick: endTick, note, type: 'off' });
    }
  }

  if (noteOnCount === 0) { minNote = 60; maxNote = 60; }
  return { events, minNote, maxNote, noteOnCount };
}

// ── Transformations ───────────────────────────────────────────────────────────

/** Time-stretch: multiply all tick values by factor. */
function stretchEvents(events: NoteEvent[], factor: number, origSteps: number): { events: NoteEvent[]; steps: number } {
  return {
    events: events.map(e => ({ ...e, tick: e.tick * factor })),
    steps: origSteps * factor,
  };
}

/** Pitch-flip around center. */
function flipEvents(events: NoteEvent[], center: number): NoteEvent[] {
  return events.map(e => ({
    ...e,
    note: clamp(Math.round(2 * center - e.note), 0, 127),
  }));
}

/** Shift all notes by semitones. */
function shiftEvents(events: NoteEvent[], semitones: number): NoteEvent[] {
  return events.map(e => ({
    ...e,
    note: clamp(e.note + semitones, 0, 127),
  }));
}

/**
 * Snap a MIDI note to the nearest note in a sorted scale array.
 * Guarantees the result stays within the chosen forte's pitch classes.
 */
function snapNote(note: number, scale: number[]): number {
  if (scale.length === 0) return note;
  let lo = 0, hi = scale.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scale[mid] < note) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first scale entry >= note; check lo-1 as well
  if (lo > 0 && Math.abs(scale[lo - 1] - note) <= Math.abs(scale[lo] - note)) {
    return scale[lo - 1];
  }
  return scale[lo];
}

/** Filter events to only notes below center. */
function takeLow(events: NoteEvent[], center: number): NoteEvent[] {
  return events.filter(e => e.note < center);
}

/** Filter events to only notes at or above center. */
function takeHigh(events: NoteEvent[], center: number): NoteEvent[] {
  return events.filter(e => e.note >= center);
}

/**
 * Strum chords: when multiple note-ons share the same tick, spread them
 * over successive steps so they arpeggiate gently instead of hitting all
 * at once.  Note-offs are shifted by the same amount to preserve duration.
 * Each chord has a 50% chance of being strummed; if strummed, the gap
 * between successive notes is chosen randomly between 1 and 8 steps.
 * Strum direction alternates between low→high and high→low.
 */
function strumChords(events: NoteEvent[]): NoteEvent[] {
  // Group note-on events by tick
  const onsByTick = new Map<number, NoteEvent[]>();
  for (const e of events) {
    if (e.type !== 'on') continue;
    let group = onsByTick.get(e.tick);
    if (!group) { group = []; onsByTick.set(e.tick, group); }
    group.push(e);
  }

  // Build a per-event tick offset for each strummed note-on
  const offsets = new Map<NoteEvent, number>();
  let strumUp = Math.random() < 0.5;

  for (const [, group] of onsByTick) {
    if (group.length < 2) continue;
    // 80% chance to strum this chord at all
    if (Math.random() < 0.2) continue;
    // Random step spacing 1–8 for this chord
    const strumStep = randInt(1, 8);
    // Sort by pitch; alternate direction for variety
    group.sort((a, b) => strumUp ? a.note - b.note : b.note - a.note);
    strumUp = !strumUp;
    for (let i = 0; i < group.length; i++) {
      offsets.set(group[i], i * strumStep);
    }
  }

  // Apply offsets. For note-offs, match the offset that was applied to the
  // corresponding note-on (tracked per pitch).
  const noteOnOffset = new Map<number, number>(); // note → pending offset
  const result: NoteEvent[] = [];

  for (const e of events) {
    const onOff = offsets.get(e);
    if (e.type === 'on') {
      const off = onOff ?? 0;
      if (off > 0) noteOnOffset.set(e.note, off);
      result.push({ ...e, tick: e.tick + off });
    } else {
      // note-off: apply the same offset its note-on received
      const off = noteOnOffset.get(e.note) ?? 0;
      if (off > 0) noteOnOffset.delete(e.note);
      result.push({ ...e, tick: e.tick + off });
    }
  }

  return result;
}

// ── MIDI File Encoding ────────────────────────────────────────────────────────

const PPQ = 480;
const TICKS_PER_STEP = PPQ / 4; // 16th-note resolution = 120 ticks

function writeVarLen(value: number): number[] {
  if (value < 0) value = 0;
  const bytes: number[] = [];
  bytes.push(value & 0x7F);
  value >>= 7;
  while (value > 0) {
    bytes.push((value & 0x7F) | 0x80);
    value >>= 7;
  }
  bytes.reverse();
  return bytes;
}

function writeUint16BE(v: number): number[] {
  return [(v >> 8) & 0xFF, v & 0xFF];
}

function writeUint32BE(v: number): number[] {
  return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
}

function encodeMidi(events: NoteEvent[], bpm: number, numerator: number, denominator: number): Buffer {
  const track: number[] = [];

  // Tempo meta-event: FF 51 03 <24-bit microseconds-per-quarter>
  const uspq = Math.round(60_000_000 / bpm);
  track.push(0x00); // delta=0
  track.push(0xFF, 0x51, 0x03);
  track.push((uspq >> 16) & 0xFF, (uspq >> 8) & 0xFF, uspq & 0xFF);

  // Time signature meta-event: FF 58 04 nn dd 24 08
  const log2denom = Math.round(Math.log2(denominator));
  track.push(0x00); // delta=0
  track.push(0xFF, 0x58, 0x04, numerator, log2denom, 24, 8);

  // Sort events: by tick, note-offs before note-ons at same tick
  const sorted = [...events].sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.type !== b.type) return a.type === 'off' ? -1 : 1;
    return a.note - b.note;
  });

  let prevTick = 0;
  for (const ev of sorted) {
    const deltaTicks = Math.max(0, (ev.tick - prevTick) * TICKS_PER_STEP);
    track.push(...writeVarLen(deltaTicks));
    if (ev.type === 'on') {
      track.push(0x90, ev.note & 0x7F, 80); // channel 1, velocity 80
    } else {
      track.push(0x80, ev.note & 0x7F, 0);  // channel 1, velocity 0
    }
    prevTick = ev.tick;
  }

  // End-of-track
  track.push(0x00, 0xFF, 0x2F, 0x00);

  // Assemble file
  const header = [
    ...Buffer.from('MThd'),
    ...writeUint32BE(6),        // header length
    ...writeUint16BE(0),        // format 0
    ...writeUint16BE(1),        // 1 track
    ...writeUint16BE(PPQ),      // ticks per quarter
  ];

  const trackHeader = [
    ...Buffer.from('MTrk'),
    ...writeUint32BE(track.length),
  ];

  return Buffer.from([...header, ...trackHeader, ...track]);
}

// ── Generation Pipeline ───────────────────────────────────────────────────────

export async function generate(
  segsDb: InstanceType<typeof Database>,
  params: GenerateParams,
): Promise<GenerateResult> {

  await PCS12.init();

  const durationSeconds = clamp(params.durationSeconds, 30, 36000);

  // ── 1. Choose target forte ──────────────────────────────────────────────

  let targetForte: string;
  if (params.forte) {
    const p = PCS12.parseForte(params.forte);
    if (!p) throw new Error(`Unknown forte: ${params.forte}`);
    targetForte = params.forte;
  } else {
    // Pick a random forte weighted by segment count, cardinality ∈ [3, 8].
    // Use the pre-computed forte counts from the DB index to avoid a full GROUP BY scan.
    const rows = segsDb.prepare(
      `SELECT forte, COUNT(*) AS cnt FROM segments GROUP BY forte`
    ).all() as { forte: string; cnt: number }[];

    const eligible = rows.filter(r => {
      const k = parseInt(r.forte.split('-')[0], 10) || 0;
      return k >= 3 && k <= 8;
    });
    if (eligible.length === 0) throw new Error('No suitable segments found');

    const totalWeight = eligible.reduce((s, r) => s + r.cnt, 0);
    let pick = Math.random() * totalWeight;
    targetForte = eligible[0].forte;
    for (const r of eligible) {
      pick -= r.cnt;
      if (pick <= 0) { targetForte = r.forte; break; }
    }
  }

  const targetK = forteK(targetForte);
  const targetPcs = PCS12.parseForte(targetForte)!.asSequence() as number[];
  const targetPcsSet = new Set(targetPcs);

  // Resolve output forte — must have the same k as the source forte.
  let outputForteName = targetForte;
  if (params.outputForte && params.outputForte !== targetForte) {
    const op = PCS12.parseForte(params.outputForte);
    if (!op) throw new Error(`Unknown output forte: ${params.outputForte}`);
    const outputK = forteK(params.outputForte);
    if (outputK !== targetK)
      throw new Error(`Output forte k=${outputK} does not match source forte k=${targetK}`);
    outputForteName = params.outputForte;
  }

  // ── 2. Select candidate segments ────────────────────────────────────────

  // When output forte differs from source forte, accept segments whose pitch
  // classes are a subset of *either* scale so both populations are represented.
  const outputPcsSet: Set<number> =
    outputForteName === targetForte
      ? targetPcsSet
      : new Set(PCS12.parseForte(outputForteName)!.asSequence() as number[]);

  // Pre-compute compatible forte strings using the forte index so the main
  // query hits only a small fraction of the table instead of all 16M rows.
  const distinctFortesInDb = segsDb.prepare(
    `SELECT DISTINCT forte FROM segments WHERE forte NOT LIKE '1-%'`
  ).all() as { forte: string }[];

  const compatibleFortes = distinctFortesInDb
    .filter(({ forte }) => {
      const pcs = PCS12.parseForte(forte);
      if (!pcs) return false;
      const k = (pcs as unknown as { getK(): number }).getK();
      if (k < 2 || k > 8) return false;
      const pcArr = pcs.asSequence() as number[];
      return pcArr.every((pc: number) => targetPcsSet.has(pc))
          || pcArr.every((pc: number) => outputPcsSet.has(pc));
    })
    .map(r => r.forte);

  if (compatibleFortes.length === 0)
    throw new Error(`No compatible segments found for forte ${targetForte}`);

  // Query only rows with compatible fortes — much faster with idx_seg_forte.
  // ORDER BY RANDOM() is avoided: it forces a full-table sort (O(N log N)) across
  // all matching rows.  Instead we fetch without ordering (SQLite streams via the
  // forte index) then shuffle in JS, which is O(N) and orders of magnitude faster.
  const ph = compatibleFortes.map(() => '?').join(',');
  const candidates = segsDb.prepare(`
    SELECT id, source, start_step, end_step, trit_lo, trit_hi,
           forte, octave, bpm, numerator, denominator, steps, sequence,
           note_count, COALESCE(phase, 0) AS phase
    FROM segments
    WHERE note_count >= 12
      AND forte IN (${ph})
    LIMIT 5000
  `).all(compatibleFortes) as SegRow[];

  if (candidates.length === 0)
    throw new Error(`No compatible segments found for forte ${targetForte}`);

  // Shuffle here so the median-cluster pick isn't always the same IDs.
  shuffle(candidates);

  // Use stored note_count for pool ranking (avoids re-parsing every sequence)
  const withCounts = candidates.map(seg => ({ seg, noteOns: seg.note_count }));

  // Sort by note-on count, take a cluster around the median
  withCounts.sort((a, b) => a.noteOns - b.noteOns);
  const medianIdx = Math.floor(withCounts.length / 2);
  const poolSize = Math.min(withCounts.length, 30);
  const halfPool = Math.floor(poolSize / 2);
  const start = clamp(medianIdx - halfPool, 0, withCounts.length - poolSize);
  const pool = withCounts.slice(start, start + poolSize).map(w => w.seg);
  shuffle(pool);

  // ── 3. Choose ambient BPM and compute target steps ──────────────────────

  const bpm = params.bpm ? clamp(params.bpm, 40, 200) : randInt(40, 72);
  const maxVoices = params.maxVoices ? clamp(params.maxVoices, 1, 15) : 3;
  const denominator = 4;
  const numerator = 4;
  const stepDuration = 60.0 / (bpm * denominator); // seconds per step
  const targetSteps = Math.ceil(durationSeconds / stepDuration);
  const maxSteps = Math.ceil(targetSteps * 1.1); // allow 10% overshoot

  // ── 4. Assemble timeline (multi-voice) ──────────────────────────────────

  const timeline: NoteEvent[] = [];
  let globalCenter = 60;
  let segPlacementCount = 0;
  let poolIdx = 0;

  function nextSeg(): SegRow {
    if (poolIdx >= pool.length) { shuffle(pool); poolIdx = 0; }
    return pool[poolIdx++];
  }

  // Pre-build the target scale for decoding remapped segments
  const targetScale = buildScale(targetForte);
  // Output scale: notes are snapped to this after assembly
  const outputScale = buildScale(outputForteName);

  // Each voice is an independent layer that holds a segment starting at
  // voiceStart and lasting voiceDuration steps.
  interface Voice {
    start:    number;  // step the segment begins at
    duration: number;  // stretched length in steps
  }
  const voices: Voice[] = [];

  // Decide how many voices are active at each scheduling point.  The
  // target count drifts randomly for continuity but never exceeds maxVoices.
  let currentVoiceTarget = randInt(1, maxVoices);
  let cursor = 0; // global step cursor

  while (cursor < targetSteps) {
    // Occasionally drift the voice-count target for variety
    if (Math.random() < 0.25) {
      currentVoiceTarget = clamp(currentVoiceTarget + randInt(-1, 1), 1, maxVoices);
    }

    // Expire finished voices
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].start + voices[i].duration <= cursor) voices.splice(i, 1);
    }

    // Add voices until we reach the current target (or maxVoices)
    while (voices.length < currentVoiceTarget && voices.length < maxVoices) {
      const useVerticalSplit = Math.random() < 0.3 && pool.length >= 2;

      if (useVerticalSplit) {
        const segA = nextSeg();
        const segB = nextSeg();
        const seqA = JSON.parse(segA.sequence) as string[];
        const seqB = JSON.parse(segB.sequence) as string[];
        const scaleA = buildRemappedScale(segA.forte, outputForteName, outputScale)
                    ?? buildRemappedScale(segA.forte, targetForte, targetScale)
                    ?? buildScale(segA.forte);
        const scaleB = buildRemappedScale(segB.forte, outputForteName, outputScale)
                    ?? buildRemappedScale(segB.forte, targetForte, targetScale)
                    ?? buildScale(segB.forte);
        const baseA = segA.octave * forteK(segA.forte);
        const baseB = segB.octave * forteK(segB.forte);

        const decA = decodeSegment(seqA, scaleA, baseA, segA.phase);
        const decB = decodeSegment(seqB, scaleB, baseB, segB.phase);
        if (decA.noteOnCount === 0 && decB.noteOnCount === 0) break;

        const stretch = randInt(2, 6);
        const strA = stretchEvents(decA.events, stretch, seqA.length);
        const strB = stretchEvents(decB.events, stretch, seqB.length);

        const centerA = (decA.minNote + decA.maxNote) / 2;
        const centerB = (decB.minNote + decB.maxNote) / 2;

        const eventsA = shiftEvents(strA.events, Math.round(globalCenter - centerA));
        const eventsB = shiftEvents(strB.events, Math.round(globalCenter - centerB));

        const lowA = takeLow(eventsA, globalCenter);
        const highB = takeHigh(eventsB, globalCenter);
        const combined = strumChords([...lowA, ...highB]);
        const duration = Math.min(strA.steps, strB.steps);

        for (const e of combined) {
          timeline.push({ ...e, tick: e.tick + cursor });
        }
        voices.push({ start: cursor, duration });
        segPlacementCount += 2;
      } else {
        const seg = nextSeg();
        const seq = JSON.parse(seg.sequence) as string[];
        const scale = buildRemappedScale(seg.forte, outputForteName, outputScale)
                    ?? buildRemappedScale(seg.forte, targetForte, targetScale)
                    ?? buildScale(seg.forte);
        const base = seg.octave * forteK(seg.forte);

        const dec = decodeSegment(seq, scale, base, seg.phase);
        if (dec.noteOnCount === 0) break;

        const stretch = randInt(2, 6);
        const str = stretchEvents(dec.events, stretch, seq.length);

        let events = str.events;
        const center = (dec.minNote + dec.maxNote) / 2;
        if (Math.random() < 0.3) {
          events = flipEvents(events, center);
        }
        events = shiftEvents(events, Math.round(globalCenter - center));
        events = strumChords(events);

        for (const e of events) {
          timeline.push({ ...e, tick: e.tick + cursor });
        }
        voices.push({ start: cursor, duration: str.steps });
        segPlacementCount++;
      }
    }

    // Advance cursor to the next voice ending (or a fraction of the shortest
    // remaining voice, whichever comes first) so new voices can be introduced.
    if (voices.length === 0) {
      // No voices could be placed — advance a fixed step to avoid an infinite loop
      cursor += 64;
    } else {
      const earliest = Math.min(...voices.map(v => v.start + v.duration));
      // Jump to the earliest ending, but at least 1 step forward
      cursor = Math.max(cursor + 1, earliest);
    }

    // Drift global center
    globalCenter = clamp(globalCenter + randInt(-2, 2), 48, 72);

    // Safety: don't overshoot too much
    if (cursor >= maxSteps) break;
  }

  // Snap every note to the output scale — guarantees the result forte
  // is exactly the selected output scale's pitch-class set.
  for (const ev of timeline) {
    ev.note = snapNote(ev.note, outputScale);
  }

  // ── 5. Post-process: ensure all notes end ───────────────────────────────

  const sounding = new Set<number>();
  // Sort by tick then type (on first so we track correctly)
  timeline.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.type !== b.type) return a.type === 'on' ? -1 : 1;
    return a.note - b.note;
  });

  for (const ev of timeline) {
    if (ev.type === 'on') sounding.add(ev.note);
    else sounding.delete(ev.note);
  }

  const endTick = cursor;
  for (const note of sounding) {
    timeline.push({ tick: endTick, note, type: 'off' });
  }

  // The result forte is the output scale — snapping guarantees all notes
  // belong to it, so we report outputForteName rather than recomputing from used PCs.
  const resultForte = outputForteName;

  // ── 6. Encode MIDI ─────────────────────────────────────────────────────

  const midi = encodeMidi(timeline, bpm, numerator, denominator);

  return {
    midi,
    bpm,
    forte: resultForte,
    segments: segPlacementCount,
  };
}

// ── Generate options helper ───────────────────────────────────────────────────

export interface ForteOption {
  forte: string;
  count: number;
  k:     number;
}

export async function getGenerateOptions(
  segsDb: InstanceType<typeof Database>,
): Promise<{ fortes: ForteOption[] }> {
  await PCS12.init();

  const rows = segsDb.prepare(`
    SELECT forte, COUNT(*) AS cnt FROM segments WHERE note_count >= 12 AND forte NOT LIKE '1-%' GROUP BY forte ORDER BY cnt DESC
  `).all() as { forte: string; cnt: number }[];

  const fortes: ForteOption[] = [];
  for (const r of rows) {
    const k = forteK(r.forte);
    if (k >= 3 && k <= 8) {
      fortes.push({ forte: r.forte, count: r.cnt, k });
    }
  }

  /** Parse "k-setNum[AB]", "k-setNum[AB].transpose" → { setNum, transpose } */
  function parseForteNum(forte: string): { setNum: number; transpose: number } {
    const dash = forte.indexOf('-');
    const rest = forte.slice(dash + 1);          // e.g. "35.11", "11A", "23"
    const dot  = rest.indexOf('.');
    const left = dot >= 0 ? rest.slice(0, dot) : rest;
    const setNum   = parseInt(left.replace(/[AB]$/i, '')) || 0;
    const transpose = dot >= 0 ? (parseInt(rest.slice(dot + 1)) || 0) : 0;
    return { setNum, transpose };
  }

  fortes.sort((a, b) => {
    if (a.k !== b.k) return a.k - b.k;
    const pa = parseForteNum(a.forte);
    const pb = parseForteNum(b.forte);
    if (pa.setNum !== pb.setNum) return pa.setNum - pb.setNum;
    return pa.transpose - pb.transpose;
  });
  return { fortes };
}
