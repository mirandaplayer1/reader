-- Reader: one row per (user, video) holding that user's highlights, notes, claims and cards.
-- Run once in the Supabase SQL editor.

create table if not exists public.reader_state (
  user_id  uuid   not null default auth.uid() references auth.users (id) on delete cascade,
  video_id text   not null,
  state    jsonb  not null,
  at       bigint not null,            -- client timestamp (ms) of the last edit; newest wins
  primary key (user_id, video_id)
);

alter table public.reader_state enable row level security;

drop policy if exists "own rows only" on public.reader_state;
create policy "own rows only" on public.reader_state
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- One row per (user, video): processing status, intermediate work, and the finished content
-- (chapters, transcript split into sentences, translations and analysis added chapter by chapter).
create table if not exists public.videos (
  user_id    uuid   not null default auth.uid() references auth.users (id) on delete cascade,
  video_id   text   not null,
  url        text   not null,
  title      text   not null default '',
  status     text   not null default 'queued',   -- queued | processing | ready | error
  progress   jsonb,
  error      text,
  work       jsonb,
  content    jsonb,
  lock_until timestamptz,
  fails      int    not null default 0,      -- failures in a row on the current step
  attempt    jsonb,                          -- the try in flight: when, which step, how old the worker was
  trail      jsonb,                          -- the last few failed tries and why, for explaining a failure afterwards
  list       text,                           -- name of the list this video is filed under, if any
  seq        int,                            -- order inside that list
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

alter table public.videos enable row level security;

drop policy if exists "own videos only" on public.videos;
create policy "own videos only" on public.videos
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Who may spend the Gemini key. The first real account to sign in becomes the owner; later sign-ups are refused.
create table if not exists public.members (
  email      text primary key,
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;
drop policy if exists "see own membership" on public.members;
create policy "see own membership" on public.members
  for select to authenticated
  using (email = (select auth.jwt() ->> 'email'));

create or replace function public.reader_access() returns boolean
language plpgsql security definer set search_path = '' as $$
declare e text := auth.jwt() ->> 'email';
begin
  if e is null then return false; end if;
  if exists (select 1 from public.members m where m.email = e) then return true; end if;
  if not exists (select 1 from public.members m where m.email not like '%@reader.invalid') then
    insert into public.members (email) values (e) on conflict do nothing;
    return true;
  end if;
  return false;
end $$;
revoke all on function public.reader_access() from public, anon;
grant execute on function public.reader_access() to authenticated;

-- Background processing: every minute, if anything is waiting, wake the ingest function so videos finish with
-- the page closed. The key below is the public anon key (the same one the web page ships with).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('reader-tick', '* * * * *', $job$
  select net.http_post(
    url := 'https://azgtjxznqdppistljerl.supabase.co/functions/v1/ingest',
    headers := jsonb_build_object('content-type', 'application/json', 'Authorization', 'Bearer <anon key>'),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000)
  where exists (select 1 from public.videos where status in ('queued', 'processing') or work->>'phase' in ('translate', 'analyse'));
$job$);

-- Writes an analysis that was produced outside the edge function (by Claude, see docs/claude-analysis.md) into one video.
-- Only the sections, their write-ups and the overview change; every turn, translation and sentence id is kept, so highlights and notes still line up.
-- Without a headline the overview is left as it is and only the sections are replaced.
create or replace function public.reader_apply_analysis(p_user uuid, p_video text, a jsonb)
returns jsonb language plpgsql set search_path to 'public' as $function$
declare c jsonb; turns jsonb; segs jsonb; chapters jsonb; first_t numeric; n_turns int; n_kept int; n_secs int; top jsonb;
begin
  select content into c from public.videos where user_id = p_user and video_id = p_video for update;
  if c is null or jsonb_typeof(c->'segs') <> 'array' then raise exception 'video % has no content', p_video; end if;
  if jsonb_typeof(a->'sections') <> 'array' then raise exception 'analysis is missing sections'; end if;
  select jsonb_agg(tu order by i, k), count(*) into turns, n_turns
    from jsonb_array_elements(c->'segs') with ordinality s(g, i), jsonb_array_elements(g->'turns') with ordinality t(tu, k);
  first_t := (turns->0->>'t')::numeric;
  with raw as (
    select x, (select (tu->>'t')::numeric from jsonb_array_elements(turns) tu
               order by abs((tu->>'t')::numeric - (x->>'t')::numeric), (tu->>'t')::numeric limit 1) as t
    from jsonb_array_elements(a->'sections') x where coalesce(btrim(x->>'title'), '') <> ''),
  d as (select distinct on (t) t, x from raw order by t),
  f as (select row_number() over (order by t) - 1 as i, case when row_number() over (order by t) = 1 then first_t else t end as t, x from d),
  o as (select i, t, x, lead(t) over (order by i) as nxt from f)
  select jsonb_agg(jsonb_build_object('id', 'c' || i, 't', t, 'title', btrim(x->>'title'), 'deep', true)
           || case when coalesce(btrim(x->>'body'), '') <> '' then jsonb_build_object('body', btrim(x->>'body'))
              else jsonb_build_object('role', coalesce(x->>'role', ''), 'points', coalesce(x->'points', '[]'::jsonb),
                'tables', coalesce((select jsonb_agg(jsonb_build_object('title', coalesce(tb->>'title', ''), 'headers', tb->'headers',
                             'rows', (select jsonb_agg(case when jsonb_typeof(r) = 'object' then r->'cells' else r end) from jsonb_array_elements(tb->'rows') r)))
                           from jsonb_array_elements(case when jsonb_typeof(x->'tables') = 'array' then x->'tables' else '[]'::jsonb end) tb
                           where jsonb_typeof(tb->'headers') = 'array' and jsonb_typeof(tb->'rows') = 'array'), '[]'::jsonb)) end
           || jsonb_build_object('turns', coalesce((select jsonb_agg(tu order by ord) from jsonb_array_elements(turns) with ordinality q(tu, ord)
                              where (tu->>'t')::numeric >= o.t and (o.nxt is null or (tu->>'t')::numeric < o.nxt)), '[]'::jsonb)) order by i),
         jsonb_agg(jsonb_build_object('t', t, 'en', '', 'zh', btrim(x->>'title'), 'sum', coalesce(x->>'role', ''), 'take', '', 'worth', 2) order by i),
         count(*)
    into segs, chapters, n_secs from o;
  if n_secs is null or n_secs < 1 then raise exception 'no usable sections'; end if;
  select coalesce(sum(jsonb_array_length(g->'turns')), 0) into n_kept from jsonb_array_elements(segs) g;
  if n_kept <> n_turns then raise exception 'turns would be lost: % of %', n_kept, n_turns; end if;
  top := case when coalesce(a->>'headline', '') = '' then '{}'::jsonb else jsonb_build_object('thesis', a->>'headline', 'tldr', '[]'::jsonb,
      'brief', jsonb_build_object('principle', coalesce(a->>'principle', ''), 'reminder', coalesce(a->>'reminder', ''), 'groups', coalesce(a->'groups', '[]'::jsonb),
        'check', jsonb_build_object('solid', coalesce(a->'check'->'solid', '[]'::jsonb), 'assumptions', coalesce(a->'check'->'assumptions', '[]'::jsonb),
          'evidence', coalesce(a->'check'->'evidence', '[]'::jsonb), 'contradictions', coalesce(a->'check'->'contradictions', '[]'::jsonb)))) end;
  update public.videos set
    content = c || top || jsonb_build_object('chapters', chapters, 'segs', segs),
    status = 'ready', work = jsonb_build_object('phase', 'ready', 'channel', coalesce(c->>'channel', ''), 'by', 'claude'),
    progress = '{"phase":"ready","done":1,"total":1}'::jsonb, fails = 0, error = null, lock_until = null, attempt = null, updated_at = now()
  where user_id = p_user and video_id = p_video;
  return jsonb_build_object('video', p_video, 'sections', n_secs, 'turns', n_turns);
end $function$;
revoke all on function public.reader_apply_analysis(uuid, text, jsonb) from public, anon, authenticated;
