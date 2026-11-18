// Edge function: one unit of ingest work per call, run as the signed-in user so row-level security applies.
//   { action: "start",  url }                -> registers the video
//   { action: "step",   video_id }           -> does the next unit (meta / one transcript chunk / outline)
//   { action: "deepen", video_id, chapter }  -> translates one batch or writes the analysis for a chapter
//   { action: "reprocess", video_id, mode }  -> "text" redoes chapters and summaries, "all" starts over
//   { action: "tick" }                       -> sent by the database every minute; advances waiting videos in the background
// Secrets: GEMINI_API_KEY (required), ANTHROPIC_API_KEY (optional, used for the text stages when present),
//          GEMINI_VIDEO_MODEL / GEMINI_TEXT_MODEL / CLAUDE_MODEL (optional overrides).
import { createClient } from "npm:@supabase/supabase-js@2";
import { deepenStep, ingestStep, parseVideoId, reprocessPatch } from "./pipeline.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const MAX_FAILS = 3;   // tries per step before the video is given up on; nothing retries after that until the owner asks
const ACTIVE = ["queued", "processing"];
// Waiting for background work: still being read, or readable with translation or chapter notes still to do.
const WAITING = "status.in.(queued,processing),work->>phase.in.(translate,analyse)";
const waiting = (r: any) => ACTIVE.includes(r.status) || ["translate", "analyse"].includes(r.work?.phase);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The platform stops a worker 150 seconds after it BOOTS, and one worker can serve several requests in a row.
// So what matters is how old the worker is, not how long this request has been running.
const BOOT = Date.now();
const WALL = 150_000, MARGIN = 8_000;
// Longest each kind of step is expected to take, in seconds. A step only starts on a worker with that much life left.
const NEED: Record<string, number> = { meta: 30, transcribe: 75, outline: 125, seams: 125, synth: 125, translate: 60, analyse: 60 };
const need = (phase: unknown) => (NEED[String(phase || "meta")] ?? 125) * 1000;
const fits = (phase: unknown) => Date.now() - BOOT + need(phase) + MARGIN <= WALL;
const KILLED = "這一步沒有回報就中斷了，多半是超過 150 秒的執行時間上限。";
// The last few tries of a video, newest last, so a failure can be explained after the fact.
const trail = (row: any, entry: Record<string, unknown>) => [...(Array.isArray(row.trail) ? row.trail : []), entry].slice(-12);
const mine = (q: any, row: any) => q.eq("user_id", row.user_id).eq("video_id", row.video_id);

// One worker at a time per video. Atomic: only one caller gets the row back.
async function claim(db: any, row: any) {
  const now = new Date();
  const { data } = await mine(db.from("videos").update({ lock_until: new Date(now.getTime() + 150_000).toISOString() }), row)
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`).select("video_id");
  return !!(data && data.length);
}

// Does the next unit and saves it. Every try is counted BEFORE the work starts, so a try that is killed half-way
// (time limit, crash) still counts: a step can cost at most MAX_FAILS model calls, then the video is marked failed.
async function runStep(db: any, row: any, deps: any) {
  const tries = (row.fails || 0) + 1, phase = row.work?.phase || "meta", began = Date.now();
  // A try that was opened and never closed died without a word: record that, it is the only trace it leaves.
  if (row.attempt) row.trail = trail(row, { at: row.attempt.at, phase: row.attempt.phase, worker_age_s: row.attempt.worker_age_s, error: KILLED });
  // A video that is already readable stays readable: giving up only stops the background work.
  const stop = (msg: string) => row.status === "ready"
    ? { work: { ...row.work, phase: "ready" }, progress: { phase: "ready", done: 1, total: 1 }, fails: 0, lock_until: null, attempt: null, trail: row.trail || [] }
    : { status: "error", error: msg, lock_until: null, attempt: null, trail: row.trail || [] };
  if (tries > MAX_FAILS) {
    const last = Array.isArray(row.trail) && row.trail.length ? row.trail[row.trail.length - 1].error : "";
    const msg = row.error || `同一段連續 ${MAX_FAILS} 次沒有完成，已停止。${last ? "最後一次：" + last : ""}`;
    console.error(JSON.stringify({ video: row.video_id, phase, gave_up: msg }));
    await mine(db.from("videos").update(stop(msg)), row);
    return { error: msg, dead: true, http: 502 };
  }
  const attempt = { at: new Date().toISOString(), phase, worker_age_s: Math.round((began - BOOT) / 1000) };
  await mine(db.from("videos").update({ fails: tries, attempt, trail: row.trail || [] }), row);
  try {
    const patch = await ingestStep(row, deps);
    const updated_at = new Date().toISOString();
    const { error } = await mine(db.from("videos").update({ ...patch, fails: 0, lock_until: null, attempt: null, updated_at }), row);
    if (error) throw error;
    return { row: { ...row, ...patch, fails: 0, lock_until: null, attempt: null, updated_at } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as any)?.message || e);
    const limited = (e as any)?.status === 429;
    const dead = tries >= MAX_FAILS;
    row.trail = trail(row, { ...attempt, took_s: Math.round((Date.now() - began) / 1000), error: msg });
    console.error(JSON.stringify({ video: row.video_id, ...attempt, took_s: Math.round((Date.now() - began) / 1000), tries, error: msg }));
    const upd = dead ? stop(`連續 ${MAX_FAILS} 次失敗，已停止：${msg}`)
      : { lock_until: new Date(Date.now() + (limited ? 60_000 : 20_000 * tries)).toISOString(), attempt: null, trail: row.trail };
    await mine(db.from("videos").update(upd), row);
    return { error: msg, dead, http: limited ? 429 : 502 };
  }
}

// Called every minute by the database (see schema.sql). Works on whatever is waiting for as long as this worker
// has life left, so videos finish with the page closed. Takes no input and only advances work a signed-in owner queued.
function tick(deps: any) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return (async () => {
    while (fits("meta")) {
      const { data: rows } = await db.from("videos").select("user_id,video_id,lock_until,phase:work->>phase").or(WAITING).order("updated_at").limit(50);
      if (!rows || !rows.length) return;
      const free = rows.filter((r: any) => !r.lock_until || new Date(r.lock_until).getTime() < Date.now());
      // The longest step this worker can still finish goes first, so a long step is never starved by short ones.
      const pick = free.filter((r: any) => fits(r.phase)).sort((a: any, b: any) => need(b.phase) - need(a.phase))[0];
      if (!pick) { if (free.length) return; await sleep(4000); continue; }   // work is waiting but needs a younger worker: leave it to the next one
      if (!(await claim(db, pick))) { await sleep(1000); continue; }
      const { data: row } = await mine(db.from("videos").select("*"), pick).maybeSingle();
      if (!row || !waiting(row) || !fits(row.work?.phase)) { await mine(db.from("videos").update({ lock_until: null }), pick); if (row && waiting(row)) return; continue; }
      await runStep(db, row, deps);
    }
  })();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const peek = await req.clone().json().catch(() => ({}));
    if (peek.action === "tick") {
      const geminiKey = Deno.env.get("GEMINI_API_KEY");
      if (!geminiKey) return json({ error: "no key" }, 500);
      const m = Deno.env.get("GEMINI_VIDEO_MODEL") || "gemini-3.8-flash";
      const job = tick({ fetch, geminiKey, videoModel: m, textModel: Deno.env.get("GEMINI_TEXT_MODEL") || m,
        anthropicKey: Deno.env.get("ANTHROPIC_API_KEY") || "", claudeModel: Deno.env.get("CLAUDE_MODEL") || "" });
      (globalThis as any).EdgeRuntime?.waitUntil(job);
      return json({ ok: true }, 202);
    }
    const auth = req.headers.get("Authorization") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "請先登入。" }, 401);
    // Only the owner may spend the Gemini key (see reader_access in schema.sql).
    const { data: allowed } = await sb.rpc("reader_access");
    if (!allowed) return json({ error: "這個帳號沒有使用權限。" }, 403);

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) return json({ error: "後端還沒有設定 GEMINI_API_KEY。" }, 500);
    const body = await req.json().catch(() => ({}));
    const pick = (v: unknown) => (typeof v === "string" && /^[a-z0-9.\-]{3,60}$/.test(v) ? v : "");
    const deps = {
      fetch,
      geminiKey,
      videoModel: pick(body.video_model) || Deno.env.get("GEMINI_VIDEO_MODEL") || "gemini-3.8-flash",
      textModel: pick(body.text_model) || Deno.env.get("GEMINI_TEXT_MODEL") || Deno.env.get("GEMINI_VIDEO_MODEL") || "gemini-3.8-flash",
      anthropicKey: Deno.env.get("ANTHROPIC_API_KEY") || "",
      claudeModel: Deno.env.get("CLAUDE_MODEL") || "",
    };

    const summary = (r: any) => ({ video_id: r.video_id, title: r.title, status: r.status, progress: r.progress, error: r.error });

    if (body.action === "diag") {
      // Which Gemini models this key can use; helps pick GEMINI_VIDEO_MODEL without exposing the key.
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": geminiKey } });
      const j = await r.json().catch(() => ({}));
      return json({ status: r.status, error: j.error?.message, videoModel: deps.videoModel, textModel: deps.textModel, claude: !!deps.anthropicKey,
        models: (j.models || []).filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m: any) => m.name) });
    }

    if (body.action === "start") {
      const vid = parseVideoId(body.url);
      if (!vid) return json({ error: "這不是 YouTube 影片網址。" }, 400);
      const { data: existing } = await sb.from("videos").select("video_id,title,status,progress,error").eq("video_id", vid).maybeSingle();
      if (existing && existing.status !== "error") return json(summary(existing));
      if (existing) {   // a failed video picks up where it stopped
        const again = { status: "processing", error: null, fails: 0, lock_until: null };
        const { error } = await sb.from("videos").update(again).eq("video_id", vid);
        if (error) throw error;
        return json(summary({ ...existing, ...again }));
      }
      const row = { user_id: user.id, video_id: vid, url: String(body.url).slice(0, 500), title: "", status: "queued", work: {}, progress: { phase: "meta", done: 0, total: null }, error: null, content: null };
      const { error } = await sb.from("videos").upsert(row);
      if (error) throw error;
      return json(summary(row));
    }

    const vid = String(body.video_id || "");
    const { data: row, error: loadErr } = await sb.from("videos").select("*").eq("video_id", vid).maybeSingle();
    if (loadErr) throw loadErr;
    if (!row) return json({ error: "找不到這支影片。" }, 404);

    if (body.action === "reprocess") {
      const patch = reprocessPatch(row, body.mode === "all" ? "all" : "text");
      const { error } = await sb.from("videos").update({ ...patch, fails: 0, lock_until: null, updated_at: new Date().toISOString() }).eq("video_id", vid);
      if (error) throw error;
      return json(summary({ ...row, ...patch }));
    }

    if (body.action === "step" && row.status === "ready") return json(summary(row));
    if (body.action === "step" && !fits(row.work?.phase)) return json({ ...summary(row), busy: true });
    if (!(await claim(sb, row))) return json({ ...summary(row), busy: true });
    {   // the background job may have saved a step since the row was read
      const { data: fresh } = await sb.from("videos").select("*").eq("video_id", vid).maybeSingle();
      if (fresh) Object.assign(row, fresh);
    }

    if (body.action === "step") {
      if (row.status === "error") {   // retry asked for by the owner
        Object.assign(row, { status: "processing", error: null, fails: 0 });
        await sb.from("videos").update({ status: "processing", error: null, fails: 0 }).eq("video_id", vid);
      }
      const out = await runStep(sb, row, deps);
      if (out.row) return json(summary(out.row));
      return json({ video_id: vid, error: out.error, retryable: !out.dead, status: out.dead ? "error" : row.status }, out.http);
    }

    try {
      if (body.action === "deepen") {
        if (row.status !== "ready") return json({ error: "影片還在處理中。" }, 409);
        const out = await deepenStep(row, Number(body.chapter), deps);
        const upd: Record<string, unknown> = { lock_until: null, updated_at: new Date().toISOString() };
        if (out.content) upd.content = out.content;
        const { error } = await sb.from("videos").update(upd).eq("video_id", vid);
        if (error) throw error;
        return json({ video_id: vid, done: out.done, progress: out.progress || null });
      }
      await sb.from("videos").update({ lock_until: null }).eq("video_id", vid);
      return json({ error: "未知的動作。" }, 400);
    } catch (e) {
      // Keep everything done so far; the client retries this same unit.
      await sb.from("videos").update({ lock_until: null }).eq("video_id", vid);
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as any)?.status === 429 ? 429 : 502;
      return json({ video_id: vid, error: msg, retryable: true }, status);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
