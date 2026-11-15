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

const MAX_FAILS = 5;
const ACTIVE = ["queued", "processing"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mine = (q: any, row: any) => q.eq("user_id", row.user_id).eq("video_id", row.video_id);

// One worker at a time per video. Atomic: only one caller gets the row back.
async function claim(db: any, row: any) {
  const now = new Date();
  const { data } = await mine(db.from("videos").update({ lock_until: new Date(now.getTime() + 150_000).toISOString() }), row)
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`).select("video_id");
  return !!(data && data.length);
}

// Does the next unit and saves it. A failure keeps everything done so far, holds the video back for a while
// (the lock doubles as the retry delay) and marks it failed after MAX_FAILS in a row.
async function runStep(db: any, row: any, deps: any) {
  try {
    const patch = await ingestStep(row, deps);
    const updated_at = new Date().toISOString();
    const { error } = await mine(db.from("videos").update({ ...patch, fails: 0, lock_until: null, updated_at }), row);
    if (error) throw error;
    return { row: { ...row, ...patch, fails: 0, lock_until: null, updated_at } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as any)?.message || e);
    const limited = (e as any)?.status === 429;
    const fails = (row.fails || 0) + 1, dead = fails >= MAX_FAILS;
    const upd = dead ? { status: "error", error: msg, fails, lock_until: null }
      : { fails, lock_until: new Date(Date.now() + (limited ? 60_000 : 15_000 * fails)).toISOString() };
    await mine(db.from("videos").update(upd), row);
    return { error: msg, dead, http: limited ? 429 : 502 };
  }
}

// Called every minute by the database (see schema.sql). Works on whatever is waiting for about 45 seconds,
// so videos finish with the page closed. Takes no input and only advances work a signed-in owner queued.
function tick(deps: any) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const started = Date.now();
  return (async () => {
    while (Date.now() - started < 45_000) {
      const { data: rows } = await db.from("videos").select("user_id,video_id,lock_until").in("status", ACTIVE).order("updated_at").limit(50);
      if (!rows || !rows.length) return;
      const free = rows.find((r: any) => !r.lock_until || new Date(r.lock_until).getTime() < Date.now());
      if (!free || !(await claim(db, free))) { await sleep(4000); continue; }
      const { data: row } = await mine(db.from("videos").select("*"), free).maybeSingle();
      if (!row || !ACTIVE.includes(row.status)) { await mine(db.from("videos").update({ lock_until: null }), free); continue; }
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
    if (!(await claim(sb, row))) return json({ ...summary(row), busy: true });

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
