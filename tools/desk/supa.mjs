// Talks to Supabase as the signed-in owner, with the public anon key from src/config.json. Row-level security
// applies, so this can only ever see and change her own rows. No service key is used or needed.
// The session (a refresh token) is kept outside the repo, readable only by this user.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HOME } from './claude.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config.json'), 'utf8'));
const FILE = path.join(HOME, 'session.json');
const base = { apikey: CFG.supabaseAnonKey, 'content-type': 'application/json' };

function save(j) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const s = { refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { id: j.user.id, email: j.user.email } };
  fs.writeFileSync(FILE, JSON.stringify(s), { mode: 0o600 });
  return s;
}
async function auth(grant, body) {
  const r = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: base, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.msg || j.error || '登入失敗（' + r.status + '）');
  return save(j);
}
export const login = (email, password) => auth('password', { email, password });
export const loggedIn = () => fs.existsSync(FILE);
export async function session() {
  if (!loggedIn()) throw new Error('桌機還沒登入 Reader。請先執行：node tools/desk/login.mjs');
  const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return s.expires_at - 120000 > Date.now() ? s : auth('refresh_token', { refresh_token: s.refresh_token });
}

// PostgREST. `query` is an object of filters; values are written the way the API wants them (eq.x, in.(a,b), …).
export async function rest(method, query, body) {
  const s = await session();
  const qs = Object.entries(query || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`${CFG.supabaseUrl}/rest/v1/videos?${qs}`, {
    method, headers: { ...base, Authorization: 'Bearer ' + s.access_token, Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error('資料庫：' + ((j && (j.message || j.error)) || r.status));
  return j || [];
}

export const db = {
  waiting: () => rest('GET', { select: 'video_id,url,title,status,fails,lock_until,phase:work->>phase', or: '(status.eq.desk,work->>phase.eq.desk-translate)', order: 'updated_at' }),
  row: async (vid) => (await rest('GET', { select: '*', video_id: 'eq.' + vid }))[0] || null,
  save: (vid, patch) => rest('PATCH', { video_id: 'eq.' + vid }, { ...patch, updated_at: new Date().toISOString() }),
  // One worker at a time per video: only a caller that finds the lock free gets the row back.
  claim: async (vid, minutes = 30) => {
    const now = new Date();
    const got = await rest('PATCH', { video_id: 'eq.' + vid, or: `(lock_until.is.null,lock_until.lt."${now.toISOString()}")` },
      { lock_until: new Date(now.getTime() + minutes * 60000).toISOString() });
    return got.length > 0;
  },
};
