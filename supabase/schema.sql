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
