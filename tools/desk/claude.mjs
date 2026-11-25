// Runs the Claude Code CLI on this machine as a plain text function, on the account the CLI is signed in with.
// Settings, hooks, tools and MCP servers are all switched off, and it runs in an empty folder, so nothing from a
// project or from the owner's personal setup (output styles, CLAUDE.md, hooks) leaks into the answer.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const HOME = process.env.READER_DESK_HOME || path.join(os.homedir(), '.config', 'reader-desk');
export const CACHE = process.env.READER_DESK_CACHE || path.join(os.homedir(), '.cache', 'reader-desk');

export function run(cmd, args, { input, timeoutMs = 0, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timer = null;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    p.on('error', reject);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    if (timeoutMs) timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} 超過 ${Math.round(timeoutMs / 60000)} 分鐘沒有完成`)); }, timeoutMs);
    p.stdin.on('error', () => {});
    p.stdin.end(input || '');
  });
}

export async function ask({ prompt, system, schema, model, timeoutMs = 20 * 60000 }) {
  const neutral = path.join(CACHE, 'neutral');
  fs.mkdirSync(neutral, { recursive: true });
  const args = ['-p', '--setting-sources', '', '--system-prompt', system, '--tools', '', '--strict-mcp-config',
    '--no-session-persistence', '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  const { code, out, err } = await run(process.env.READER_DESK_CLAUDE || 'claude', args, { input: prompt, timeoutMs, cwd: neutral });
  let j = null;
  try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch (_) { /* reported below */ }
  if (!j) throw new Error('Claude 沒有回應（' + code + '）：' + (err || out).trim().slice(-300));
  if (j.is_error) throw new Error('Claude 回報錯誤：' + String(j.result || j.subtype || '').slice(0, 300));
  if (!schema) return String(j.result || '');
  if (j.structured_output && typeof j.structured_output === 'object') return j.structured_output;
  const text = String(j.result || '');
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
  catch (_) { throw new Error('Claude 回的不是 JSON：' + text.slice(0, 200)); }
}
