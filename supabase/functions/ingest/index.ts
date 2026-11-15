// Edge function: one unit of ingest work per call, run as the signed-in user so row-level security applies.
//   { action: "start",  url }                -> registers the video
//   { action: "step",   video_id }           -> does the next unit (meta / one transcript chunk / outline)
//   { action: "deepen", video_id, chapter }  -> translates one batch or writes the analysis for a chapter
//   { action: "reprocess", video_id, mode }  -> "text" redoes chapters and summaries, "all" starts over
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
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
      prompts: {} as Record<string, string>,
    };
    // Optional wording overrides, editable in the Supabase table editor without a deploy.
    try {
      const { data: st } = await sb.from("settings").select("value").eq("key", "prompts").maybeSingle();
      if (st && st.value && typeof st.value === "object") deps.prompts = st.value;
    } catch (_) { /* defaults apply */ }

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
      const { error } = await sb.from("videos").update({ ...patch, lock_until: null, updated_at: new Date().toISOString() }).eq("video_id", vid);
      if (error) throw error;
      return json(summary({ ...row, ...patch }));
    }

    // One worker at a time per video: a second tab or a retry waits instead of doing the same chunk twice.
    const now = Date.now();
    if (row.lock_until && new Date(row.lock_until).getTime() > now) return json({ ...summary(row), busy: true });
    await sb.from("videos").update({ lock_until: new Date(now + 150_000).toISOString() }).eq("video_id", vid);

    try {
      if (body.action === "step") {
        if (row.status === "ready") { await sb.from("videos").update({ lock_until: null }).eq("video_id", vid); return json(summary(row)); }
        const patch = await ingestStep(row, deps);
        const next = { ...row, ...patch, lock_until: null, updated_at: new Date().toISOString() };
        const { error } = await sb.from("videos").update({ ...patch, lock_until: null, updated_at: next.updated_at }).eq("video_id", vid);
        if (error) throw error;
        return json(summary(next));
      }
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
