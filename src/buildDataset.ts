/**
 * buildDataset.ts — orchestrate the full MIDI → MIDI_SEGMENTS.db pipeline.
 *
 * Run:  npm run build-dataset
 *
 * Pipeline
 * ────────
 *   Stage 1  scanMidi        — recursively walk D:/Temp/MIDI
 *   Stage 2  parseMidiFile   — parse with @tonejs/midi, apply track filter
 *   Stage 3  quantizeTrack   — convert ticks → 24-step-per-QN step grid
 *   Stage 4  encodeStepGrid  — balanced-ternary bigint sequence
 *   Stage 5  detectBoundaries — entropy / periodicity boundary detection
 *   Stage 6  alignSegment    — refine each segment start ±16 steps
 *   Stage 7  analyzePitches  — Forte resolution + scale-relative remapping
 *   Stage 8  fixNoteOffs     — ensure every note-on has a matching note-off in the loop
 *   Stage 9  createWriter    — batch insert into MIDI_SEGMENTS.db
 *
 * Segment acceptance criteria:
 *   • length in steps : 16 – 512 (after trim)
 *   • density         : ≥ 5 % non-zero steps (after trim)
 *   • forte           : not '0-1.00' (degenerate / no pitch content)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, unlinkSync } from 'fs';
import { PCS12 } from 'ultra-mega-enumerator';

import { scanMidi }          from './scanMidi.ts';
import { parseMidiFile }     from './parseMidi.ts';
import { quantizeTrack, STEPS_PER_QN } from './quantizeTrack.ts';
import { encodeStepGrid }    from './ternaryEncoder.ts';
import { detectBoundaries }  from './segmentDetector.ts';
import { alignSegment }      from './segmentAligner.ts';
import { analyzePitches }    from './pitchAnalyzer.ts';
import { createWriter }      from './segmentWriter.ts';
import { toBalancedTernary } from './utils.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const MIDI_DIR  = 'D:/Temp/MIDI';
const DB_PATH   = path.join(ROOT, 'MIDI_SEGMENTS.db');

// ── Segment parameters ────────────────────────────────────────────────────────
const MIN_SEG     = 16;
const MAX_SEG     = 512;
const MIN_DENSITY = 0.05;

// ── Common helpers ────────────────────────────────────────────────────────────

function trimSilence(seq: bigint[]): { trimmed: bigint[]; leadOffset: number } {
  let start = 0;
  while (start < seq.length && seq[start] === 0n) start++;
  let end = seq.length;
  while (end > start && seq[end - 1] === 0n) end--;
  return { trimmed: seq.slice(start, end), leadOffset: start };
}

function nonZeroFraction(seq: bigint[]): number {
  if (seq.length === 0) return 0;
  let nz = 0;
  for (const v of seq) if (v !== 0n) nz++;
  return nz / seq.length;
}

// ── Note-off repair helpers ───────────────────────────────────────────────────

function parseTritMap(stepStr: string): Map<number, number> {
  const trits = toBalancedTernary(BigInt(stepStr));
  const map = new Map<number, number>();
  for (let i = 0; i < trits.length; i++) {
    if (trits[i] !== 0) map.set(i, trits[i]);
  }
  return map;
}

function encodeTrits(trits: Map<number, number>): string {
  if (trits.size === 0) return '0';
  let val = 0n;
  for (const [pos, trit] of trits) {
    if (trit === 0) continue;
    val += BigInt(trit) * (3n ** BigInt(pos));
  }
  return val.toString();
}

/** Returns trit positions that are still sounding (note-on without note-off) at the end. */
function getSoundingAtEnd(sequence: string[]): Set<number> {
  const sounding = new Set<number>();
  for (const stepStr of sequence) {
    if (stepStr === '0') continue;
    const trits = toBalancedTernary(BigInt(stepStr));
    for (let pos = 0; pos < trits.length; pos++) {
      if      (trits[pos] ===  1) sounding.add(pos);
      else if (trits[pos] === -1) sounding.delete(pos);
    }
  }
  return sounding;
}

/** Merge note-offs for all `sounding` positions into one step string. */
function mergeNoteOffs(stepStr: string, sounding: Set<number>): string {
  if (sounding.size === 0) return stepStr;
  const tritMap = parseTritMap(stepStr);
  let changed = false;
  for (const pos of sounding) {
    const current = tritMap.get(pos) ?? 0;
    if (current === -1) continue;          // already off
    if (current === 1) {
      tritMap.delete(pos);                 // note-on + note-off coalesce to 0
    } else {
      tritMap.set(pos, -1);               // insert explicit note-off
    }
    changed = true;
  }
  return changed ? encodeTrits(tritMap) : stepStr;
}

/**
 * Ensure every note-on in the segment has a matching note-off so the
 * segment loops cleanly.  Note-offs are merged into the step immediately
 * before the first non-zero step (circularly), keeping dead space tidy.
 */
function fixNoteOffs(sequence: string[]): string[] {
  if (sequence.length === 0) return sequence;
  const sounding = getSoundingAtEnd(sequence);
  if (sounding.size === 0) return sequence;
  const firstNZ   = sequence.findIndex(s => s !== '0');
  const targetIdx = firstNZ <= 0
    ? sequence.length - 1
    : firstNZ - 1;
  const result = sequence.slice();
  result[targetIdx] = mergeNoteOffs(result[targetIdx], sounding);
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Initialising PCS12 …');
  await PCS12.init();
  console.log('PCS12 ready.\n');

  // Start fresh — remove any previous build
  if (existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Removed existing ${DB_PATH}`);
  }

  const writer    = createWriter(DB_PATH);
  const startTime = Date.now();

  let filesProcessed  = 0;
  let filesSkipped    = 0;
  let tracksProcessed = 0;

  for await (const filePath of scanMidi(MIDI_DIR)) {
    let result;
    try {
      result = parseMidiFile(filePath);
    } catch {
      filesSkipped++;
      continue;
    }

    if (!result) { filesSkipped++; continue; }
    const { fileInfo, tracks } = result;

    for (const track of tracks) {
      tracksProcessed++;

      let grid, sequence, boundaries;
      try {
        grid       = quantizeTrack(track, fileInfo.ppq);
        sequence   = encodeStepGrid(grid);
        boundaries = detectBoundaries(sequence);
      } catch {
        continue;
      }

      // Bar length in steps used for padding segments to clean bar boundaries
      const stepsPerBar = Math.max(4, Math.min(192,
        Math.round(fileInfo.numerator * (4 / fileInfo.denominator) * STEPS_PER_QN)
      ));

      for (let bi = 0; bi < boundaries.length - 1; bi++) {
        const rawStart = boundaries[bi];
        const rawEnd   = boundaries[bi + 1];
        const rawLen   = rawEnd - rawStart;

        if (rawLen < MIN_SEG || rawLen > MAX_SEG) continue;

        const offset    = alignSegment(sequence, rawStart, rawEnd);
        const alnStart  = Math.max(0, rawStart + offset);
        const raw       = sequence.slice(alnStart, rawEnd);
        const { trimmed, leadOffset } = trimSilence(raw);

        if (trimmed.length < MIN_SEG || trimmed.length > MAX_SEG) continue;
        if (nonZeroFraction(trimmed) < MIN_DENSITY) continue;

        // Pad to next whole bar boundary (capped at MAX_SEG)
        const padLen = Math.min(MAX_SEG,
          Math.ceil(trimmed.length / stepsPerBar) * stepsPerBar
        );

        const padded: bigint[] = padLen > trimmed.length
          ? [...trimmed, ...new Array(padLen - trimmed.length).fill(0n)]
          : trimmed;

        let analysis;
        try {
          analysis = analyzePitches(padded);
        } catch {
          continue;
        }

        if (analysis.forte === '0-1.00') continue;  // no pitch content

        const fixedSeq = fixNoteOffs(analysis.sequence);
        const absStart = alnStart + leadOffset;
        const absEnd   = absStart + fixedSeq.length;

        writer.add({
          source:      fileInfo.filename,
          startStep:   absStart,
          endStep:     absEnd,
          tritLo:      analysis.tritLo,
          tritHi:      analysis.tritHi,
          forte:       analysis.forte,
          octave:      analysis.octave,
          bpm:         fileInfo.bpm,
          numerator:   fileInfo.numerator,
          denominator: fileInfo.denominator,
          steps:       fixedSeq.length,
          sequence:    fixedSeq,
        });
      }
    }

    filesProcessed++;

    if (filesProcessed % 50 === 0 || filesProcessed <= 5) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      process.stdout.write(
        `\r  ${filesProcessed} files | ` +
        `${tracksProcessed} tracks | ` +
        `${writer.count} segs | ${elapsed}s`
      );
    }
  }

  writer.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\nDone in ${elapsed}s.`);
  console.log(`  Files processed : ${filesProcessed}`);
  console.log(`  Files skipped   : ${filesSkipped}`);
  console.log(`  Tracks accepted : ${tracksProcessed}`);
  console.log(`  Segments written: ${writer.count}`);
  console.log(`\n  → ${DB_PATH}`);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
