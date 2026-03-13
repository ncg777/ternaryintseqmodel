/**
 * scanMidi.ts — async generator that recursively walks a directory and
 * yields absolute paths for every .mid / .midi file found.
 */

import { readdir } from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';

const MIDI_EXTS = new Set(['.mid', '.midi']);

export async function* scanMidi(dir: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      yield* scanMidi(full);
    } else if (MIDI_EXTS.has(path.extname(entry).toLowerCase())) {
      yield full;
    }
  }
}
