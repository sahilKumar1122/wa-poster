import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const MSG_FILE = path.join(DIR, 'messages.json');
const LOG_FILE = path.join(DIR, 'sent-log.jsonl');
const SCHED_FILE = path.join(DIR, 'schedules.json');
const IMG_DIR = path.join(DIR, 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });
const IMG_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

let jobs = fs.existsSync(SCHED_FILE) ? JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8')) : [];
for (const j of jobs) if (j.status === 'running') j.status = 'missed'; // server died mid-run
// Optional login: set WA_POSTER_PASSWORD to require it. Unset = no login (server only listens on 127.0.0.1).
const PASSWORD = process.env.WA_POSTER_PASSWORD || '';
const sha = x => crypto.createHash('sha256').update(x).digest();
const TOKEN = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('wa-poster-session-v1').digest('hex') : null;
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const loggedIn = req => !TOKEN || (req.headers.cookie || '').split(/;\s*/).some(c => c.startsWith('wa_session=') && safeEq(c.slice(11), TOKEN));
const state = { status: 'starting', qr: null, groups: [], sending: false, events: [] };
const clients = new Set();
let sock;

const emit = (type, data = {}) => {
  const ev = { type, t: Date.now(), ...data };
  if (type !== 'state') state.events.push(ev);
  state.events = state.events.slice(-200);
  for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
};
const snapshot = () => ({ auth: !!TOKEN, type: 'state', status: state.status, qr: state.qr, groups: state.groups, sending: state.sending, schedules: jobs });
const pushState = () => emit('state', snapshot());

async function loadGroups() {
  const all = await sock.groupFetchAllParticipating();
  state.groups = Object.values(all)
    .map(g => ({ id: g.id, name: g.subject, size: g.participants?.length ?? 0, isCommunity: !!g.isCommunity, isAnnounce: !!g.announce, parent: g.linkedParent || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  pushState();
}

async function connect() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(path.join(DIR, 'auth'));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth, logger: pino({ level: 'silent' }), browser: ['Mac OS', 'Chrome', '120'], syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { state.status = 'qr'; state.qr = await QRCode.toDataURL(qr, { width: 280 }); pushState(); }
    if (connection === 'open') {
      state.status = 'connected'; state.qr = null;
      try { await loadGroups(); } catch (e) { emit('error', { msg: 'group fetch failed: ' + e.message }); }
      pushState();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      state.status = 'disconnected'; state.groups = []; pushState();
      if (code === DisconnectReason.loggedOut) { fs.rmSync(path.join(DIR, 'auth'), { recursive: true, force: true }); }
      setTimeout(connect, 2000);
    }
  });
}

const saveJobs = () => { fs.writeFileSync(SCHED_FILE, JSON.stringify(jobs.slice(-50), null, 2)); pushState(); };
const readJson = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readRaw = (req, max = 16 * 1024 * 1024) => new Promise((ok, no) => {
  const chunks = []; let n = 0;
  req.on('data', d => { n += d.length; if (n > max) { no(new Error('too large')); req.destroy(); } else chunks.push(d); });
  req.on('end', () => ok(Buffer.concat(chunks)));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXAMPLE_FILE = path.join(DIR, 'messages.example.json');
const readMessages = () => {
  const f = fs.existsSync(MSG_FILE) ? MSG_FILE : EXAMPLE_FILE;
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
};

// Per-group variation so copies aren't byte-identical: swap look-alike emojis + one invisible char between words.
const EMOJI_SETS = [['📈', '📊'], ['🚨', '⚠️', '🔔'], ['🔥', '⚡', '✨'], ['🙌', '👏'], ['❤️', '💚', '🧡'], ['💻', '🖥️'], ['⏰', '⏳'], ['🔴', '🟥']];
const pick = a => a[Math.floor(Math.random() * a.length)];
function vary(text) {
  for (const set of EMOJI_SETS) {
    const present = set.find(e => text.includes(e));
    if (present) text = text.split(present).join(pick(set));
  }
  const spots = [...text.matchAll(/[A-Za-z] (?=[a-z])/g)];
  if (spots.length) {
    const i = pick(spots).index + 2;
    text = text.slice(0, i) + '​' + text.slice(i);
  }
  return text;
}

// Sequential send with random delay between groups. dryRun logs only.
async function runSend({ text, groupIds, dryRun, minDelay, maxDelay, varyText, image }) {
  const img = image ? fs.readFileSync(path.join(IMG_DIR, path.basename(image))) : null;
  state.sending = true; pushState();
  const seen = new Set();
  for (let i = 0; i < groupIds.length; i++) {
    const id = groupIds[i];
    const name = state.groups.find(g => g.id === id)?.name || id;
    emit('progress', { id, name, status: 'sending', i, total: groupIds.length });
    try {
      let out = text;
      if (varyText) { for (let k = 0; k < 20 && (out === text || seen.has(out)); k++) out = vary(text); seen.add(out); }
      if (!dryRun) await sock.sendMessage(id, img ? { image: img, caption: out } : { text: out });
      fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), group: name, id, dryRun, image: image || null, text: out }) + '\n');
      emit('progress', { id, name, status: dryRun ? 'dry-ok' : 'sent', i, total: groupIds.length });
    } catch (e) {
      emit('progress', { id, name, status: 'failed', error: e.message, i, total: groupIds.length });
    }
    if (i < groupIds.length - 1) {
      const wait = Math.round((minDelay + Math.random() * (maxDelay - minDelay)) * 1000);
      emit('progress', { id, name, status: 'waiting', waitMs: wait });
      await sleep(dryRun ? Math.min(wait, 1500) : wait);
    }
  }
  state.sending = false; emit('done'); pushState();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/login') {
    if (!TOKEN) { res.writeHead(302, { location: '/' }); return res.end(); }
    if (req.method === 'POST') {
      const { password = '' } = await readJson(req);
      if (safeEq(String(password), PASSWORD)) {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `wa_session=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
        return res.end('{"ok":true}');
      }
      await sleep(1000); return send(res, 401, { error: 'wrong password' });
    }
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(DIR, 'login.html')));
  }
  if (url.pathname === '/logout') { res.writeHead(302, { location: '/login', 'set-cookie': 'wa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); return res.end(); }
  if (!loggedIn(req)) {
    if (url.pathname === '/') { res.writeHead(302, { location: '/login' }); return res.end(); }
    return send(res, 401, { error: 'login required' });
  }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(DIR, 'index.html'))); }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    for (const ev of state.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (url.pathname.startsWith('/images/')) {
    const f = path.join(IMG_DIR, path.basename(url.pathname));
    if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': IMG_TYPES[path.extname(f).slice(1)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(f));
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const ext = (url.searchParams.get('ext') || '').toLowerCase();
    if (!IMG_TYPES[ext]) return send(res, 400, { error: 'only jpg, png, webp' });
    try {
      const file = `${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(IMG_DIR, file), await readRaw(req));
      return send(res, 200, { file });
    } catch (e) { return send(res, 413, { error: e.message }); }
  }
  if (url.pathname === '/api/messages' && req.method === 'GET') return send(res, 200, readMessages());
  if (url.pathname === '/api/messages' && req.method === 'POST') {
    fs.writeFileSync(MSG_FILE, JSON.stringify(await readJson(req), null, 2)); return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/refresh-groups' && req.method === 'POST') {
    try { await loadGroups(); return send(res, 200, { ok: true }); } catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/schedules' && req.method === 'POST') {
    const b = await readJson(req);
    const at = Date.parse(b.runAt);
    if (!b.text?.trim() || !b.groupIds?.length || !at) return send(res, 400, { error: 'text, groupIds, runAt required' });
    if (at < Date.now() - 60000) return send(res, 400, { error: 'time is in the past' });
    if (b.image && !fs.existsSync(path.join(IMG_DIR, path.basename(b.image)))) return send(res, 400, { error: 'image file missing' });
    const job = { id: Date.now().toString(36), label: b.label || b.text.slice(0, 30), text: b.text, groupIds: b.groupIds, image: b.image || null,
      vary: b.vary !== false, dryRun: !!b.dryRun, minDelay: b.minDelay ?? 15, maxDelay: b.maxDelay ?? 25, runAt: new Date(at).toISOString(), status: 'scheduled' };
    jobs.push(job); saveJobs(); return send(res, 200, job);
  }
  if (url.pathname === '/api/schedules/cancel' && req.method === 'POST') {
    const { id } = await readJson(req);
    const j = jobs.find(x => x.id === id);
    if (!j || j.status !== 'scheduled') return send(res, 400, { error: 'not cancellable' });
    j.status = 'cancelled'; saveJobs(); return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    const b = await readJson(req);
    if (state.sending) return send(res, 409, { error: 'already sending' });
    if (!b.text?.trim() || !b.groupIds?.length) return send(res, 400, { error: 'text and groupIds required' });
    if (b.image && !fs.existsSync(path.join(IMG_DIR, path.basename(b.image)))) return send(res, 400, { error: 'image file missing' });
    if (!b.dryRun && state.status !== 'connected') return send(res, 400, { error: 'WhatsApp not connected' });
    runSend({ text: b.text, groupIds: b.groupIds, dryRun: !!b.dryRun, minDelay: b.minDelay ?? 15, maxDelay: b.maxDelay ?? 25, varyText: b.vary !== false, image: b.image || null });
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`WA Poster UI: http://localhost:${PORT}`));

// Fire due jobs one at a time. A job more than 20 min overdue (server was off/offline) is marked missed, never sent late.
setInterval(() => {
  const now = Date.now();
  for (const j of jobs) {
    if (j.status !== 'scheduled' || Date.parse(j.runAt) > now) continue;
    if (now - Date.parse(j.runAt) > 20 * 60000) { j.status = 'missed'; saveJobs(); continue; }
    if (state.sending || (!j.dryRun && state.status !== 'connected')) continue;
    j.status = 'running'; saveJobs();
    runSend({ ...j, varyText: j.vary }).then(() => { j.status = 'done'; saveJobs(); }, () => { j.status = 'failed'; saveJobs(); });
    break;
  }
}, 5000);

connect();
