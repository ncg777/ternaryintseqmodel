import Database from 'better-sqlite3';

const db = new Database('MIDI_SEGMENTS.db', { readonly: true });
const forte = process.argv[2] || '2-5.03';

console.log(`Fetching 100 ids for ${forte}...`);
let start = performance.now();
db.prepare('SELECT id FROM segments WHERE forte = ? LIMIT 100').all(forte);
console.log(`  ${(performance.now() - start).toFixed(1)}ms`);

console.log(`Fetching 100 full rows for ${forte}...`);
start = performance.now();
db.prepare('SELECT id, source, start_step, end_step, trit_lo, trit_hi, forte, octave, bpm, numerator, denominator, steps, sequence, note_count, phase FROM segments WHERE forte = ? LIMIT 100').all(forte);
console.log(`  ${(performance.now() - start).toFixed(1)}ms`);

console.log(`Fetching 300 full rows for ${forte}...`);
start = performance.now();
db.prepare('SELECT id, source, start_step, end_step, trit_lo, trit_hi, forte, octave, bpm, numerator, denominator, steps, sequence, note_count, phase FROM segments WHERE forte = ? LIMIT 300').all(forte);
console.log(`  ${(performance.now() - start).toFixed(1)}ms`);

console.log(`Fetching 1000 full rows for ${forte}...`);
start = performance.now();
db.prepare('SELECT id, source, start_step, end_step, trit_lo, trit_hi, forte, octave, bpm, numerator, denominator, steps, sequence, note_count, phase FROM segments WHERE forte = ? LIMIT 1000').all(forte);
console.log(`  ${(performance.now() - start).toFixed(1)}ms`);
