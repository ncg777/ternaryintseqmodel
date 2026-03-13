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
 *   Stage 8  createWriter    — batch insert into MIDI_SEGMENTS.db
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

        const absStart = alnStart + leadOffset;
        const absEnd   = absStart + analysis.sequence.length;

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
          steps:       analysis.sequence.length,
          sequence:    analysis.sequence,
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
