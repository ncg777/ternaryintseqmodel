/**
 * server.ts — HTTP server backed by MIDI_SEGMENTS.db.
 *
 * Run:  npm run serve
 *       then open http://localhost:3000
 *
 * Endpoints
 * ─────────
 *   GET  /                                   → index.html
 *   GET  /api/count                          → { total: N }
 *   GET  /api/segments[?forte&source&q&      → paginated segment metadata
 *                       minSteps&maxSteps&
 *                       minBpm&maxBpm&
 *                       page&limit]
 *   GET  /api/segment?id=N                   → full segment (includes sequence)
 *   GET  /api/sources                        → [{ source, count }]
 *   GET  /api/fortes                         → [{ forte, count }]
 *   GET  /api/scale?forte=X                  → { pitchClasses, k }
 *   GET  /api/export-midi?id=N               → .mid file download
 *   GET  /api/generate-options               → { fortes: [...] }
 *   POST /api/generate                       → ambient .mid download
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { PCS12 } from 'ultra-mega-enumerator';
import { generate, getGenerateOptions } from './generate.ts';
import { toBalancedTernary } from './utils.ts';

// Lazy-init PCS12 on first /api/scale request
let pcs12Ready: Promise<void> | null = null;
function ensurePcs12(): Promise<void> {
  if (!pcs12Ready) pcs12Ready = PCS12.init();
  return pcs12Ready;
}

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const DB_PATH    = path.join(ROOT, 'MIDI_SEGMENTS.db');
const HTML_PATH  = path.join(ROOT, 'index.html');
const PORT       = 3000;
const DEF_LIMIT  = 100;
const MAX_LIMIT  = 500;

// ── Open database ─────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  console.error('Run  npm run build-dataset  first.');
  process.exit(1);
}

console.log(`Opening ${DB_PATH} …`);
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');
db.pragma('mmap_size = 2147483648'); // up to 2 GiB memory-mapped I/O
db.pragma('cache_size = -32768');    // 32 MiB page cache

// ── Prepared statements ───────────────────────────────────────────────────────

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
}
type SegMetaRow = Omit<SegRow, 'sequence'>;

const stmtCount = db.prepare<[], { total: number }>(
  'SELECT COUNT(*) AS total FROM segments'
);

// ── Dynamic-filter query builder ──────────────────────────────────────────────
// Builds SQL on the fly so only active filters appear in the WHERE clause.
// The (:p IS NULL OR col = :p) pattern prevents SQLite from using column
// indexes, causing a full table scan on every filtered request.

interface FilterOpts {
  forte:    string | null;
  source:   string | null;
  q:        string | null;
  minSteps: number | null;
  maxSteps: number | null;
  minBpm:   number | null;
  maxBpm:   number | null;
}

const SEL_META = 'SELECT id, source, start_step, end_step, trit_lo, trit_hi, forte, octave, bpm, numerator, denominator, steps';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stmtCache = new Map<string, any>();
function getCachedStmt(sql: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let s: any = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

function buildFilterQuery(
  fp: FilterOpts, select: string, tail: string,
): { sql: string; params: Record<string, string | number> } {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (fp.forte)             { where.push('forte  = :forte');                             params.forte    = fp.forte; }
  if (fp.source)            { where.push('source = :source');                            params.source   = fp.source; }
  if (fp.q)                 { where.push("LOWER(source) LIKE '%' || LOWER(:q) || '%'"); params.q        = fp.q; }
  if (fp.minSteps !== null) { where.push('steps >= :minSteps');                          params.minSteps = fp.minSteps; }
  if (fp.maxSteps !== null) { where.push('steps <= :maxSteps');                          params.maxSteps = fp.maxSteps; }
  if (fp.minBpm   !== null) { where.push('bpm   >= :minBpm');                            params.minBpm   = fp.minBpm; }
  if (fp.maxBpm   !== null) { where.push('bpm   <= :maxBpm');                            params.maxBpm   = fp.maxBpm; }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { sql: `${select} FROM segments ${w}${tail ? ' ' + tail : ''}`, params };
}

const stmtById = db.prepare<{ id: number }, SegRow>(`
  SELECT id, source, start_step, end_step, trit_lo, trit_hi,
         forte, octave, bpm, numerator, denominator, steps, sequence
  FROM   segments
  WHERE  id = :id
`);

const stmtSources = db.prepare<[], { source: string; count: number }>(
  'SELECT source, COUNT(*) AS count FROM segments GROUP BY source ORDER BY source'
);

const stmtFortes = db.prepare<[], { forte: string; count: number }>(
  'SELECT forte, COUNT(*) AS count FROM segments GROUP BY forte ORDER BY count DESC'
);

// ── Lazy startup caches (computed on first request; DB is read-only so values never change) ────
// Running these aggregate queries at startup blocked the process for several seconds on large DBs.

let _cachedCount:   number | null = null;
let _cachedSources: string | null = null;
let _cachedFortes:  string | null = null;

function cachedCount(): number {
  if (_cachedCount === null) {
    _cachedCount = stmtCount.get()?.total ?? 0;
    console.log(`  loaded count: ${_cachedCount.toLocaleString()} segments`);
  }
  return _cachedCount;
}
function cachedSources(): string {
  if (_cachedSources === null) {
    _cachedSources = JSON.stringify(stmtSources.all());
    console.log(`  loaded sources: ${JSON.parse(_cachedSources).length}`);
  }
  return _cachedSources;
}
function cachedFortes(): string {
  if (_cachedFortes === null) {
    _cachedFortes = JSON.stringify(stmtFortes.all());
    console.log(`  loaded fortes: ${JSON.parse(_cachedFortes).length}`);
  }
  return _cachedFortes;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function segMetaToJson(row: SegMetaRow) {
  return {
    id:          row.id,
    source:      row.source,
    startStep:   row.start_step,
    endStep:     row.end_step,
    tritLo:      row.trit_lo,
    tritHi:      row.trit_hi,
    forte:       row.forte,
    octave:      row.octave,
    bpm:         row.bpm,
    numerator:   row.numerator,
    denominator: row.denominator,
    steps:       row.steps,
  };
}

function segFullToJson(row: SegRow) {
  return { ...segMetaToJson(row), sequence: JSON.parse(row.sequence) as string[] };
}

function send(res: http.ServerResponse, status: number, body: string, ct = 'text/plain', maxAge = 0): void {
  const headers: Record<string, string> = { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' };
  if (maxAge > 0) headers['Cache-Control'] = `public, max-age=${maxAge}`;
  res.writeHead(status, headers);
  res.end(body);
}

function sendJSON(res: http.ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data), 'application/json');
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const out: Record<string, string> = {};
  for (const part of url.slice(idx + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = decodeURIComponent(part.slice(0, eq));
    const v = decodeURIComponent(part.slice(eq + 1));
    if (k) out[k] = v;
  }
  return out;
}

// ── MIDI export helpers ───────────────────────────────────────────────────────

function writeVarLen(value: number): number[] {
  if (value < 0) value = 0;
  const bytes: number[] = [];
  bytes.push(value & 0x7F);
  value >>= 7;
  while (value > 0) { bytes.push((value & 0x7F) | 0x80); value >>= 7; }
  return bytes.reverse();
}
function writeU16BE(v: number): number[] { return [(v >> 8) & 0xFF, v & 0xFF]; }
function writeU32BE(v: number): number[] {
  return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
}

interface MidiEvt { tick: number; note: number; type: 'on' | 'off' }

function encodeMidi(
  events: MidiEvt[], bpm: number,
  numerator: number, denominator: number,
  ppq = 480,
): Buffer {
  const track: number[] = [];
  const uspq = Math.round(60_000_000 / bpm);
  track.push(0x00, 0xFF, 0x51, 0x03,
    (uspq >> 16) & 0xFF, (uspq >> 8) & 0xFF, uspq & 0xFF);
  const log2d = Math.round(Math.log2(denominator));
  track.push(0x00, 0xFF, 0x58, 0x04, numerator, log2d, 24, 8);

  const sorted = [...events].sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.type !== b.type) return a.type === 'off' ? -1 : 1;
    return a.note - b.note;
  });

  const ticksPerStep = ppq / 4;
  let prevTick = 0;
  for (const ev of sorted) {
    const delta = Math.max(0, (ev.tick - prevTick) * ticksPerStep);
    track.push(...writeVarLen(delta));
    track.push(ev.type === 'on' ? 0x90 : 0x80, ev.note & 0x7F, ev.type === 'on' ? 80 : 0);
    prevTick = ev.tick;
  }
  track.push(0x00, 0xFF, 0x2F, 0x00);

  return Buffer.from([
    ...Buffer.from('MThd'), ...writeU32BE(6),
    ...writeU16BE(0), ...writeU16BE(1), ...writeU16BE(ppq),
    ...Buffer.from('MTrk'), ...writeU32BE(track.length),
    ...track,
  ]);
}

/** Decode a scale-relative segment into MIDI note events. */
function segmentToMidiEvents(
  sequence: string[], forte: string, octave: number,
): MidiEvt[] {
  const pcs = PCS12.parseForte(forte);
  if (!pcs) return [];
  const pitchClasses = pcs.asSequence() as number[];
  const k  = pcs.getK();

  const scale: number[] = [];
  for (const pc of pitchClasses) {
    for (let oct = 0; oct <= 10; oct++) {
      const midi = pc + 12 * oct;
      if (midi < 128) scale.push(midi);
    }
  }
  scale.sort((a, b) => a - b);

  const baseIdx = octave * k;
  const events: MidiEvt[] = [];

  for (let step = 0; step < sequence.length; step++) {
    if (sequence[step] === '0') continue;
    const trits = toBalancedTernary(BigInt(sequence[step]));
    for (let t = 0; t < trits.length; t++) {
      if (trits[t] === 0) continue;
      const scaleIdx = baseIdx + t;
      if (scaleIdx < 0 || scaleIdx >= scale.length) continue;
      events.push({ tick: step, note: scale[scaleIdx], type: trits[t] === 1 ? 'on' : 'off' });
    }
  }

  // Tie off any still-sounding notes
  const sounding = new Set<number>();
  for (const ev of events) {
    if (ev.type === 'on') sounding.add(ev.note);
    else sounding.delete(ev.note);
  }
  for (const note of sounding) events.push({ tick: sequence.length, note, type: 'off' });

  return events;
}

// ── Route handler ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url   = req.url ?? '/';
  const path_ = url.split('?')[0];

  // Static HTML
  if (path_ === '/' || path_ === '/index.html') {
    if (!fs.existsSync(HTML_PATH)) { send(res, 404, 'index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(HTML_PATH).pipe(res);
    return;
  }

  // Total count (cached)
  if (path_ === '/api/count') {
    send(res, 200, JSON.stringify({ total: cachedCount() }), 'application/json', 300);
    return;
  }

  // Paginated segment list
  if (path_ === '/api/segments') {
    const p        = parseQuery(url);
    const forte    = p.forte  || null;
    const source   = p.source || null;
    const q        = p.q      || null;
    const minSteps = p.minSteps ? Number(p.minSteps) : null;
    const maxSteps = p.maxSteps ? Number(p.maxSteps) : null;
    const minBpm   = p.minBpm   ? Number(p.minBpm)   : null;
    const maxBpm   = p.maxBpm   ? Number(p.maxBpm)   : null;
    const page     = Math.max(0, Number(p.page)  || 0);
    const limit    = Math.min(MAX_LIMIT, Math.max(1, Number(p.limit) || DEF_LIMIT));
    const offset   = page * limit;
    const fp: FilterOpts   = { forte, source, q, minSteps, maxSteps, minBpm, maxBpm };
    const isUnfiltered     = !forte && !source && !q && minSteps === null && maxSteps === null && minBpm === null && maxBpm === null;
    const { sql: dataSql,  params: dataParams  } = buildFilterQuery(fp, SEL_META, 'ORDER BY id LIMIT :limit OFFSET :offset');
    const { sql: countSql, params: countParams } = buildFilterQuery(fp, 'SELECT COUNT(*) AS total', '');
    const rows  = getCachedStmt(dataSql).all({ ...dataParams, limit, offset }) as SegMetaRow[];
    const total = isUnfiltered ? cachedCount() : (getCachedStmt(countSql).get(countParams) as { total: number } | undefined)?.total ?? 0;
    sendJSON(res, 200, { total, page, limit, items: rows.map(segMetaToJson) });
    return;
  }

  // Full segment by id
  if (path_ === '/api/segment') {
    const { id } = parseQuery(url);
    if (!id) { sendJSON(res, 400, { error: 'id required' }); return; }
    const row = stmtById.get({ id: Number(id) });
    if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
    sendJSON(res, 200, segFullToJson(row));
    return;
  }

  // Source list (cached)
  if (path_ === '/api/sources') {
    send(res, 200, cachedSources(), 'application/json', 300);
    return;
  }

  // Forte list (cached)
  if (path_ === '/api/fortes') {
    send(res, 200, cachedFortes(), 'application/json', 300);
    return;
  }

  // Scale info for a forte
  if (path_ === '/api/scale') {
    const { forte } = parseQuery(url);
    if (!forte) { sendJSON(res, 400, { error: 'forte required' }); return; }
    ensurePcs12().then(() => {
      try {
        const pcs12 = PCS12.parseForte(forte);
        if (!pcs12) { sendJSON(res, 404, { error: `Unknown forte: ${forte}` }); return; }
        sendJSON(res, 200, { pitchClasses: pcs12.asSequence(), k: pcs12.getK() });
      } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    }).catch(e => sendJSON(res, 500, { error: String(e) }));
    return;
  }

  // Export segment as .mid
  if (path_ === '/api/export-midi') {
    const { id } = parseQuery(url);
    if (!id) { sendJSON(res, 400, { error: 'id required' }); return; }
    const row = stmtById.get({ id: Number(id) });
    if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
    ensurePcs12().then(() => {
      try {
        const sequence = JSON.parse(row.sequence) as string[];
        const events   = segmentToMidiEvents(sequence, row.forte, row.octave);
        const midi     = encodeMidi(events, row.bpm, row.numerator, row.denominator);
        const safeName = row.source.replace(/[^A-Za-z0-9._-]/g, '_');
        res.writeHead(200, {
          'Content-Type':        'audio/midi',
          'Content-Disposition': `attachment; filename="seg-${row.id}-${safeName}.mid"`,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(midi);
      } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    }).catch(e => sendJSON(res, 500, { error: String(e) }));
    return;
  }

  // Generate options
  if (path_ === '/api/generate-options') {
    getGenerateOptions(db).then(data => {
      sendJSON(res, 200, data);
    }).catch(e => sendJSON(res, 500, { error: String(e) }));
    return;
  }

  // Generate ambient song (POST)
  if (path_ === '/api/generate' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: { forte?: string; outputForte?: string; durationSeconds?: number; bpm?: number; maxVoices?: number };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJSON(res, 400, { error: 'Invalid JSON body' }); return;
      }
      const dur = Number(body.durationSeconds);
      if (!Number.isFinite(dur) || dur < 30 || dur > 36000) {
        sendJSON(res, 400, { error: 'durationSeconds must be between 30 and 36000' }); return;
      }
      const reqBpm = body.bpm != null ? Number(body.bpm) : undefined;
      if (reqBpm !== undefined && (!Number.isFinite(reqBpm) || reqBpm < 40 || reqBpm > 200)) {
        sendJSON(res, 400, { error: 'bpm must be between 40 and 200' }); return;
      }
      const reqMaxVoices = body.maxVoices != null ? Number(body.maxVoices) : undefined;
      if (reqMaxVoices !== undefined && (!Number.isInteger(reqMaxVoices) || reqMaxVoices < 1 || reqMaxVoices > 15)) {
        sendJSON(res, 400, { error: 'maxVoices must be between 1 and 15' }); return;
      }
      generate(db, {
        forte: body.forte, outputForte: body.outputForte,
        durationSeconds: dur, bpm: reqBpm, maxVoices: reqMaxVoices,
      }).then(result => {
        const safeName = result.forte.replace(/[^A-Za-z0-9._-]/g, '_');
        res.writeHead(200, {
          'Content-Type':        'audio/midi',
          'Content-Disposition': `attachment; filename="ambient-${safeName}-${Date.now()}.mid"`,
          'X-Result-Forte':      result.forte,
          'X-Result-BPM':        String(result.bpm),
          'X-Result-Segments':   String(result.segments),
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Result-Forte, X-Result-BPM, X-Result-Segments',
        });
        res.end(result.midi);
      }).catch(e => sendJSON(res, 500, { error: String(e) }));
    });
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  send(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`\nServer ready → http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

