import Database from 'better-sqlite3';
import { PCS12 } from 'ultra-mega-enumerator';
import { generate } from './generate.ts';

const DB_PATH = 'MIDI_SEGMENTS.db';

console.log('Opening DB...');
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

console.log('Initializing PCS12...');
await PCS12.init();

console.log('Starting generation...');
const start = performance.now();
const result = await generate(db, { durationSeconds: 30, maxVoices: 1 });
const elapsed = performance.now() - start;
console.log(`Generated ${result.segments} segments in ${elapsed.toFixed(1)}ms`);
console.log(`Forte: ${result.forte}, BPM: ${result.bpm}, MIDI size: ${result.midi.length} bytes`);
