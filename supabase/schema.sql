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
