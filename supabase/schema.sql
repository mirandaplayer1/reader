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
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
