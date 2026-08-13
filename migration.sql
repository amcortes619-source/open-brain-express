-- ============================================================================
-- OPEN BRAIN — EXPRESS SCHEMA
-- Run this ONE TIME in the Supabase SQL Editor.
-- Supabase.com -> your project -> SQL Editor -> New query -> paste -> Run.
--
-- This creates everything at once: the thoughts table, login-protected access,
-- semantic + keyword search fused together, chunked retrieval for long
-- captures, and the connection graph.
--
-- SAFE TO RUN ON AN EXISTING BRAIN, ANY NUMBER OF TIMES. If you already built
-- one following the seven-level course, or you are re-running this after an
-- update, this adds only what is missing and does not touch a single thought
-- you have saved. See section 5 for the one extra step you will need after
-- your first run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. EXTENSIONS
-- pgvector lets Postgres store "embeddings" — the numeric fingerprint of a
-- thought's meaning — and compare them. This is what makes search understand
-- meaning instead of just matching words.
-- ---------------------------------------------------------------------------
create extension if not exists vector;


-- ---------------------------------------------------------------------------
-- 2. THOUGHTS TABLE
-- One row per captured thought, whatever the source.
-- user_id ties each row to the person who saved it. That column is what makes
-- the security policies further down actually work.
-- ---------------------------------------------------------------------------
-- Written so it is safe to run on a brand new project OR on a brain you already
-- built following the seven-level course. If the table already exists, only the
-- missing pieces get added and nothing you have saved is touched.
create table if not exists thoughts (
  id          uuid primary key default gen_random_uuid(),
  content     text not null,
  created_at  timestamptz not null default now()
);

-- Add every column individually rather than assuming the table is new. On a
-- fresh project these all get created; on an existing brain, only whatever is
-- missing does.
alter table thoughts add column if not exists user_id     uuid references auth.users(id) on delete cascade;
alter table thoughts add column if not exists source      text not null default 'text';
alter table thoughts add column if not exists tags        text[] default '{}';
alter table thoughts add column if not exists category    text;
alter table thoughts add column if not exists summary     text;
alter table thoughts add column if not exists embedding   vector(1536);
alter table thoughts add column if not exists enriched_at timestamptz;
alter table thoughts add column if not exists metadata    jsonb default '{}'::jsonb;

-- NOTE ON user_id: it is deliberately nullable here, not "not null".
--
-- If you are upgrading an existing brain, your old thoughts have no owner yet —
-- they were saved before there was any such thing as logging in. Forcing the
-- column to be non-null would refuse to add it at all, and the whole script
-- would fail.
--
-- Section 5 below shows you how to claim those old thoughts once you have
-- created your login. Until you do that, they will not appear in the app: the
-- security rules only return rows that belong to you, and rows with no owner
-- belong to nobody. THEY ARE NOT DELETED. They are sitting in the table waiting
-- to be claimed, and you can see them any time in the Supabase Table Editor.

create index if not exists idx_thoughts_user       on thoughts(user_id);
create index if not exists idx_thoughts_created    on thoughts(created_at desc);
create index if not exists idx_thoughts_source     on thoughts(source);

-- HNSW index: makes "find the most similar thoughts" fast even with thousands
-- of rows. Without it every search compares against every single row.
create index if not exists idx_thoughts_embedding
  on thoughts using hnsw (embedding vector_cosine_ops);


-- ---------------------------------------------------------------------------
-- 2b. DEDUPLICATION — one thought, one row, even if it gets captured twice.
--
-- WHAT THIS PREVENTS: paste the same article link twice, or have Telegram
-- redeliver a message after a slow reply, and a plain insert would silently
-- create two identical rows. A check-before-insert cannot fix this properly —
-- it is a race between the check and the insert that application code cannot
-- win. A unique index can: the database itself refuses the second copy and
-- turns it into an update instead.
--
-- content_hash is the content's plain identity — always md5(content), full stop.
-- Kept SEPARATE from dedup_key below: content_hash never changes meaning, so it is
-- what you would group by later to ask "what's actually duplicated in here?" (a
-- reporting question), whereas dedup_key is the ENFORCEMENT column and can be
-- deliberately overridden. GENERATED ALWAYS AS ... STORED means it is always in
-- sync with content — no backfill job, and no way for it to drift.
alter table thoughts
  add column if not exists content_hash text generated always as (md5(content)) stored;

create index if not exists idx_thoughts_content_hash on thoughts (content_hash);

-- dedup_key defaults to md5(content), set by the trigger below so callers
-- never have to compute it themselves. It is a SEPARATE column from content_hash
-- (rather than putting the unique index directly on content_hash) so that a
-- deliberate second copy (the same text saved on purpose, annotated differently)
-- stays possible — supply your own dedup_key and it will never collide with the
-- auto-derived one.
-- ---------------------------------------------------------------------------
alter table thoughts add column if not exists dedup_key text;

create or replace function thoughts_set_dedup_key()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    if new.dedup_key is null then
      new.dedup_key := md5(new.content);
    end if;
  elsif TG_OP = 'UPDATE' and new.content is distinct from old.content then
    -- Follow the content, but only if the key was auto-derived. A caller-supplied
    -- key is left alone: overwriting it would silently re-enable collapsing on a
    -- row that opted out.
    if old.dedup_key = md5(old.content) then
      new.dedup_key := md5(new.content);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_thoughts_set_dedup_key on thoughts;
create trigger trg_thoughts_set_dedup_key
  before insert or update of content on thoughts
  for each row execute function thoughts_set_dedup_key();

-- Backfill existing rows so the unique index below can be created without
-- rejecting anything already there.
update thoughts set dedup_key = md5(content) where dedup_key is null;

-- NULLS NOT DISTINCT (Postgres 15+, which Supabase runs) so two unowned rows
-- (user_id null, pre-claim) still collide with each other on identical content,
-- rather than every null being treated as unique.
create unique index if not exists idx_thoughts_dedup_key
  on thoughts (dedup_key, user_id) nulls not distinct;

-- Full-text index alongside the meaning-based one. Vector search alone misses
-- exact terms it was never taught to associate with anything — an account
-- number, an unusual name, an env var. 'simple' keeps every token verbatim;
-- 'english' additionally stems ("grant" also matches "grants"). Concatenating
-- both into one tsvector means a search can hit on either.
alter table thoughts
  add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(content, '')) || to_tsvector('simple', coalesce(content, ''))
  ) stored;

create index if not exists idx_thoughts_content_tsv on thoughts using gin (content_tsv);


-- ---------------------------------------------------------------------------
-- 3. THOUGHT LINKS — the graph
-- Each row is a connection between two thoughts that mean similar things.
-- Created automatically whenever a thought is saved.
-- ---------------------------------------------------------------------------
create table if not exists thought_links (
  id                uuid primary key default gen_random_uuid(),
  source_thought_id uuid not null references thoughts(id) on delete cascade,
  target_thought_id uuid not null references thoughts(id) on delete cascade,
  similarity_score  float not null,
  created_at        timestamptz not null default now()
);

-- Same upgrade-safe approach as the thoughts table above
alter table thought_links add column if not exists user_id   uuid references auth.users(id) on delete cascade;
alter table thought_links add column if not exists link_type text not null default 'semantic';

-- Block the same link being stored twice in the same direction (A->B)
create unique index if not exists idx_links_pair
  on thought_links(source_thought_id, target_thought_id);

-- Block the same link stored backwards (if A->B exists, refuse B->A).
-- LEAST/GREATEST sorts the two ids into a consistent order first, so both
-- directions collapse to the same index entry. Without this you get double
-- the edges and confusing results — this was learned the hard way.
create unique index if not exists idx_links_canonical
  on thought_links (
    least(source_thought_id::text, target_thought_id::text),
    greatest(source_thought_id::text, target_thought_id::text)
  );

create index if not exists idx_links_source on thought_links(source_thought_id);
create index if not exists idx_links_target on thought_links(target_thought_id);
create index if not exists idx_links_user   on thought_links(user_id);

-- A thought can never link to itself
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'no_self_links'
  ) then
    alter table thought_links
      add constraint no_self_links
      check (source_thought_id != target_thought_id);
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 3b. THOUGHT SOURCES — the full text behind a summary.
--
-- capture-url and capture-youtube each hand a document (an article, a
-- transcript) to the AI and save the SUMMARY as the thought's content. Left
-- there, anything the summariser dropped is gone for good — a 6,000-word
-- article becomes a 200-word summary and the rest is unrecoverable. This
-- table keeps the full text too, so it stays searchable even though the
-- thought itself only shows the short version.
--
-- No embedding column here on purpose: a single vector over tens of
-- thousands of characters would be dominated by the document's overall gist
-- and could not find a specific buried detail. The source text is made
-- searchable through thought_chunks instead (next section).
--
-- RLS is enabled with NO policies, matching thought_chunks below: only your
-- edge functions (using the service role key) ever read or write this table.
-- It holds nothing your browser needs to see directly.
-- ---------------------------------------------------------------------------
create table if not exists thought_sources (
  id          uuid primary key default gen_random_uuid(),
  thought_id  uuid not null references thoughts(id) on delete cascade,
  source_text text not null,
  source_kind text not null,   -- 'web' | 'youtube_transcript' | 'youtube_description'
  char_count  int  not null,
  truncated   boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint thought_sources_one_per_thought unique (thought_id)
);

create index if not exists idx_sources_thought on thought_sources(thought_id);

alter table thought_sources enable row level security;


-- ---------------------------------------------------------------------------
-- 4. SECURITY — this is the part that matters
--
-- Row Level Security means the database itself refuses to hand out rows that
-- do not belong to the person asking. Policies below grant access ONLY to
-- logged-in users, and ONLY to their own rows.
--
-- Note what is NOT here: no policy granting anything to "anon". A visitor who
-- is not logged in gets nothing, even if they have your app's public key.
--
-- Your edge functions (Telegram bot, MCP server, enrichment) use the service
-- role key, which bypasses RLS entirely. That is intentional and correct —
-- that key lives only in Supabase secrets and never reaches a browser.
-- ---------------------------------------------------------------------------
alter table thoughts      enable row level security;
alter table thought_links enable row level security;

-- If you are upgrading a brain built with the seven-level course, it had a rule
-- that let ANYONE with your public key read, change and delete everything.
-- Remove it. These names cover both versions of that rule.
drop policy if exists "allow_all" on thoughts;
drop policy if exists "temporary_open_access" on thoughts;
drop policy if exists "own_thoughts" on thoughts;
drop policy if exists "allow_all" on thought_links;

drop policy if exists "own_thoughts_select" on thoughts;
create policy "own_thoughts_select" on thoughts
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own_thoughts_insert" on thoughts;
create policy "own_thoughts_insert" on thoughts
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own_thoughts_update" on thoughts;
create policy "own_thoughts_update" on thoughts
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own_thoughts_delete" on thoughts;
create policy "own_thoughts_delete" on thoughts
  for delete to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own_links_select" on thought_links;
create policy "own_links_select" on thought_links
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own_links_insert" on thought_links;
create policy "own_links_insert" on thought_links
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own_links_delete" on thought_links;
create policy "own_links_delete" on thought_links
  for delete to authenticated
  using (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 5. UPGRADING? CLAIM YOUR EXISTING THOUGHTS
--
-- SKIP THIS ENTIRELY if this is a brand new brain. It only matters if you had
-- thoughts saved before you had a login.
--
-- Those old thoughts have no owner. The security rules above only return rows
-- that belong to you, so right now they will not show up in the app. They are
-- NOT lost — check the Table Editor and you will see them all sitting there.
--
-- To claim them:
--
--   STEP 1: open your app and create your login first. You cannot own anything
--           until an account exists.
--
--   STEP 2: come back here and run the two statements below.
--
-- Check how many are waiting:
--
--   select count(*) from thoughts where user_id is null;
--
-- Then claim them. Replace the email with the one you just signed up with:
--
--   update thoughts
--   set user_id = (select id from auth.users where email = 'you@example.com')
--   where user_id is null;
--
--   update thought_links
--   set user_id = (select id from auth.users where email = 'you@example.com')
--   where user_id is null;
--
-- Refresh the app and everything you ever saved is back — now protected by your
-- login instead of open to anyone who found the address.
--
-- Old thoughts will have no tags, category or meaning-fingerprint, because they
-- were saved before any of that existed. They are still searchable by keyword.
-- To bring them fully up to date, ask Claude Code: "backfill enrichment and
-- embeddings for my thoughts that don't have them yet."
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 6. WHAT THIS COSTS YOU
--
-- Every time your brain tags a thought or works out its meaning, it makes a
-- small paid request to an AI. Each one is a fraction of a cent. This table
-- records them so the number stops being a promise somebody made you and
-- becomes something you can look at.
--
-- Nothing here can break a save: if writing one of these rows fails, the
-- thought is already stored and the failure is ignored.
-- ---------------------------------------------------------------------------
create table if not exists llm_usage (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  kind              text not null default 'chat',   -- chat | embedding
  model             text,
  source            text,                            -- which function spent it
  prompt_tokens     integer default 0,
  completion_tokens integer default 0,
  cost_usd          numeric(12,8) default 0,
  created_at        timestamptz not null default now()
);

create index if not exists idx_usage_user_time on llm_usage(user_id, created_at desc);

alter table llm_usage enable row level security;

drop policy if exists "own_usage_select" on llm_usage;
create policy "own_usage_select" on llm_usage
  for select to authenticated
  using (auth.uid() = user_id);

-- Spending so far this calendar month, plus an all-time figure.
create or replace function my_spend()
returns table (
  month_usd    numeric,
  month_calls  bigint,
  total_usd    numeric,
  total_calls  bigint
)
language plpgsql
stable
as $$
begin
  -- Runs as the caller, so row level security applies and they can only ever
  -- sum their own rows. The explicit user_id filter below is belt and braces.
  return query
    select
      coalesce(sum(u.cost_usd) filter (
        where u.created_at >= date_trunc('month', now())), 0)::numeric,
      count(*) filter (
        where u.created_at >= date_trunc('month', now()))::bigint,
      coalesce(sum(u.cost_usd), 0)::numeric,
      count(*)::bigint
    from llm_usage u
    where u.user_id = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------------
-- 7. THOUGHT CHUNKS — retrieval inside long captures.
--
-- ONE vector per thought could not answer "which PART of that document said
-- X". A 6,000-word article's summary embeds fine as a whole, but a single
-- vector over that much text is dominated by its overall gist — a specific
-- detail buried in paragraph twelve is not what makes that vector look like
-- the query "what did it say about X".
--
-- thoughts keeps its own whole-content embedding: that is the document-level
-- signal, and it is what makes chunking ADDITIVE rather than a replacement.
-- thought_chunks holds per-section vectors, for both a thought's own content
-- ('summary') and, when one exists, its full source text ('source'). Search
-- scores a thought as the best of its own vector and any of its chunks, so a
-- broad query still matches the document as a whole, a narrow query matches
-- via the chunk that actually contains the detail, and a short thought with
-- no chunks behaves exactly as if chunking did not exist.
--
-- RLS is on with NO policies. Chunks are verbatim substrings of a thought's
-- content and must be no more exposed than the parent — only your edge
-- functions (service role) ever touch this table.
-- ---------------------------------------------------------------------------
create table if not exists thought_chunks (
  id          uuid primary key default gen_random_uuid(),
  thought_id  uuid not null references thoughts(id) on delete cascade,
  origin      text not null default 'summary',   -- 'summary' | 'source'
  chunk_index int  not null,
  content     text not null,
  -- Offsets locate the chunk inside its origin text, so a match could be
  -- highlighted in place. These are JavaScript string indices (UTF-16 code
  -- units), not Postgres codepoint offsets — treat `content` above as the
  -- authoritative copy of the chunk text, not these offsets.
  char_start  int  not null,
  char_end    int  not null,
  embedding   vector(1536),
  created_at  timestamptz not null default now(),
  constraint thought_chunks_unique_index unique (thought_id, origin, chunk_index),
  constraint thought_chunks_range_valid check (char_end > char_start)
);

create index if not exists idx_chunks_thought on thought_chunks(thought_id);

create index if not exists idx_chunks_embedding
  on thought_chunks using hnsw (embedding vector_cosine_ops);

alter table thought_chunks
  add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(content, '')) || to_tsvector('simple', coalesce(content, ''))
  ) stored;

create index if not exists idx_chunks_content_tsv on thought_chunks using gin (content_tsv);

alter table thought_chunks enable row level security;

-- Backfill bookkeeping. Every write path chunks inline (enrich-thought, capture-url,
-- capture-youtube), so under normal use this view stays empty — it only fills up for
-- thoughts that existed BEFORE chunking did, which is exactly what backfill-brain (the
-- upgrade tool) drains. The length threshold must match CHUNK_MIN_CONTENT in
-- _shared/chunking.ts; it is duplicated here as a literal because a SQL view cannot import
-- a TypeScript constant.
create or replace view public.thoughts_needing_chunks as
  select t.id, length(t.content) as chars, t.source, t.created_at
  from thoughts t
  where length(t.content) > 2000
    and not exists (
      select 1 from thought_chunks c where c.thought_id = t.id and c.origin = 'summary'
    )
  order by length(t.content) desc;


-- ---------------------------------------------------------------------------
-- 8. HYBRID SEARCH — meaning-based and keyword search, fused into one ranking.
--
-- WHY BOTH ARMS: vector search understands paraphrase ("car trouble" finds a
-- thought about "the Honda breaking down") but is unreliable on exact terms
-- it never learned to associate with anything — a person's name, an account
-- number, an unusual word. Keyword search is the opposite: exact terms,
-- unreliably ranked. Fusing them gets both.
--
-- FUSION METHOD: Reciprocal Rank Fusion (RRF), k = 60. It combines the two
-- arms by RANK rather than by score, which sidesteps having to calibrate two
-- incomparable scales — cosine similarity (0.30-0.80) against ts_rank (an
-- unbounded, corpus-dependent number). k=60 is the constant from the original
-- RRF paper; it damps the gap between adjacent top ranks so one arm cannot
-- dominate purely by placing first.
--
-- KEYWORD ARM SCALED BY SELECTIVITY: equal weights alone under-rank an exact
-- term hit — a keyword rank 1 and a vector rank 1 produce the same RRF term,
-- so an exact match merely ties the best semantic guess and then has no
-- similarity score to win the tiebreak with. Rather than a flat boost (which
-- would also inflate the keyword arm on ordinary prose queries where its top
-- hit is just whichever thought repeats a common word most), the boost scales
-- with how SELECTIVE the match is — how rare the matched term is across this
-- user's own thoughts. A term that appears in 1 thought out of 200 asserts
-- itself; a term in a third of the brain barely moves.
--
-- PER-DOCUMENT CAP: a long capture with many chunks could otherwise fill
-- every result slot with fragments of the same document. At most
-- max_per_document (default 2) results may come from the same source
-- (grouped by the url / video_id in metadata — captures with neither, like
-- text and voice notes, are never capped).
--
-- Dropped by NAME, not by signature, before being recreated. Naming a
-- specific signature is how a Postgres function ends up with two silent
-- overloads after a return-type change — the DROP matches nothing, the
-- CREATE adds a new arity, and every call then fails with "function ... is
-- not unique". Dropping by name is safe to re-run and immune to future
-- signature changes.
-- ---------------------------------------------------------------------------
do $drop$
declare sig text;
begin
  for sig in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname in ('search_thoughts_semantic', 'search_thoughts_keyword', 'search_thoughts_hybrid')
      and n.nspname = 'public'
  loop
    execute 'drop function ' || sig;
  end loop;
end
$drop$;

create function search_thoughts_hybrid(
  p_user_id        uuid,
  query_text       text,
  query_embedding  vector(1536) default null,
  match_threshold  float default 0.3,
  match_count      int   default 10,
  max_per_document int   default 2,
  vector_weight    float default 1.0,
  keyword_weight   float default 1.0,
  rrf_k            int   default 60,
  keyword_selectivity_boost float default 2.0
)
returns table (
  id            uuid,
  content       text,
  source        text,
  category      text,
  tags          text[],
  created_at    timestamptz,
  similarity    float,
  matched_chunk text,
  chunk_origin  text,
  match_source  text,     -- 'thought' | 'chunk'
  fusion_score  float
)
language sql stable as $$
  with
  visible as (
    select t.id, t.content, t.source, t.category, t.tags, t.created_at,
           t.embedding, t.content_tsv,
           -- Grouping key for the per-document cap. Null for anything without one of
           -- these metadata keys, which is what exempts text/voice notes from the cap.
           -- 'filename' matters as much as 'url' and 'video_id' here: it is what the
           -- PDF capture path (index.html) writes, and a long OCR'd book is exactly the
           -- kind of document that floods a result list if its cap group is missed.
           coalesce(t.metadata->>'url', t.metadata->>'video_id', t.metadata->>'filename') as source_document
    from thoughts t
    where t.user_id = p_user_id
  ),

  -- ── vector arm ──
  document_hits as (
    select v.id as thought_id,
           1 - (v.embedding <=> query_embedding) as sim,
           null::text as chunk_text, null::text as chunk_origin
    from visible v
    where query_embedding is not null
      and v.embedding is not null
      and 1 - (v.embedding <=> query_embedding) > match_threshold
  ),
  chunk_hits as (
    select c.thought_id,
           1 - (c.embedding <=> query_embedding) as sim,
           c.content as chunk_text, c.origin as chunk_origin
    from thought_chunks c
    join visible v on v.id = c.thought_id
    where query_embedding is not null
      and c.embedding is not null
      and 1 - (c.embedding <=> query_embedding) > match_threshold
  ),
  vec_best as (
    select distinct on (u.thought_id) u.thought_id, u.sim, u.chunk_text, u.chunk_origin
    from (select * from document_hits union all select * from chunk_hits) u
    order by u.thought_id, u.sim desc
  ),
  vec_ranked as (
    select vb.*, row_number() over (order by vb.sim desc)::int as vrank
    from vec_best vb
  ),

  -- ── keyword arm ──
  kq as (
    select case
      when query_text is null or btrim(query_text) = '' then null::tsquery
      else websearch_to_tsquery('english', query_text) || websearch_to_tsquery('simple', query_text)
    end as q
  ),
  kw_doc as (
    select v.id as thought_id, ts_rank(v.content_tsv, kq.q) as krank,
           null::text as chunk_text, null::text as chunk_origin
    from visible v cross join kq
    where kq.q is not null and v.content_tsv @@ kq.q
  ),
  kw_chunk as (
    select c.thought_id, ts_rank(c.content_tsv, kq.q) as krank,
           c.content as chunk_text, c.origin as chunk_origin
    from thought_chunks c
    join visible v on v.id = c.thought_id
    cross join kq
    where kq.q is not null and c.content_tsv @@ kq.q
  ),
  kw_best as (
    select distinct on (u.thought_id) u.thought_id, u.krank, u.chunk_text, u.chunk_origin
    from (select * from kw_doc union all select * from kw_chunk) u
    order by u.thought_id, u.krank desc
  ),
  kw_ranked as (
    select kb.*, row_number() over (order by kb.krank desc)::int as krank_pos
    from (select * from kw_best order by krank desc limit 200) kb
  ),
  -- Inverse document frequency for the query as a whole: how much of this user's brain matched
  -- at all. Computed from kw_best (pre-LIMIT) so a broad match is correctly recognised as unselective.
  kw_selectivity as (
    select case
      when matched = 0 or total < 2 then 0.0
      else ln(total::float / greatest(matched::float, 1.0)) / ln(total::float)
    end as sel
    from (select (select count(*) from kw_best) as matched,
                 (select count(*) from visible)  as total) c
  ),

  -- ── fusion ──
  fused as (
    select
      coalesce(vr.thought_id, kr.thought_id) as thought_id,
      vr.sim,
      vr.vrank,
      kr.krank_pos,
      case when vr.thought_id is null then kr.chunk_text
           when kr.thought_id is null then vr.chunk_text
           when kr.krank_pos < vr.vrank then kr.chunk_text
           else vr.chunk_text end as chunk_text,
      case when vr.thought_id is null then kr.chunk_origin
           when kr.thought_id is null then vr.chunk_origin
           when kr.krank_pos < vr.vrank then kr.chunk_origin
           else vr.chunk_origin end as chunk_origin,
      coalesce(vector_weight / (rrf_k + vr.vrank), 0)
        + coalesce(
            keyword_weight * (1.0 + keyword_selectivity_boost * ks.sel) / (rrf_k + kr.krank_pos),
            0
          ) as fusion
    from vec_ranked vr
    full outer join kw_ranked kr on kr.thought_id = vr.thought_id
    cross join kw_selectivity ks
  ),

  -- ── per-document cap, applied after fusion so a crowded-out slot is
  --    refilled by the next best result from a DIFFERENT source ──
  capped as (
    select f.*,
           v.source_document,
           case
             when v.source_document is null then 1
             else row_number() over (partition by v.source_document order by f.fusion desc)
           end as doc_rank
    from fused f
    join visible v on v.id = f.thought_id
  )

  select
    v.id, v.content, v.source, v.category, v.tags, v.created_at,
    coalesce(c.sim, 0)::float as similarity,
    c.chunk_text as matched_chunk,
    c.chunk_origin,
    case when c.chunk_text is null then 'thought' else 'chunk' end as match_source,
    c.fusion as fusion_score
  from capped c
  join visible v on v.id = c.thought_id
  where c.doc_rank <= greatest(max_per_document, 1)
  order by c.fusion desc, coalesce(c.sim, 0) desc
  limit match_count;
$$;


-- ---------------------------------------------------------------------------
-- 9. FIND NEIGHBOURS — used to build the graph
--
-- VOLATILE, not STABLE, on purpose. This runs immediately after a new thought
-- is inserted. A STABLE function may read an older snapshot of the table that
-- does not yet contain the row we just saved. VOLATILE always sees current data.
--
-- Dropped by NAME first, same as search_thoughts_hybrid above. This one is not
-- hypothetical: the seven-level course's own find_links_for_thought takes 4
-- arguments with no p_user_id (source_id, source_embedding, match_threshold,
-- match_count). That is a genuinely different signature from this one, so on
-- an upgrading brain a plain CREATE OR REPLACE would not replace it — it would
-- add a second overload and leave the 4-argument original behind for good.
-- ---------------------------------------------------------------------------
do $drop$
declare sig text;
begin
  for sig in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'find_links_for_thought' and n.nspname = 'public'
  loop
    execute 'drop function ' || sig;
  end loop;
end
$drop$;

create function find_links_for_thought(
  p_user_id        uuid,
  source_id        uuid,
  source_embedding vector(1536),
  match_threshold  float default 0.5,
  match_count      int   default 5
)
returns table (
  target_id  uuid,
  similarity float
)
language plpgsql
volatile
as $$
begin
  return query
    select
      t.id as target_id,
      (1 - (t.embedding <=> source_embedding))::float as similarity
    from thoughts t
    where t.user_id = p_user_id
      and t.id != source_id
      and t.embedding is not null
      and (1 - (t.embedding <=> source_embedding)) > match_threshold
    order by t.embedding <=> source_embedding
    limit match_count;
end;
$$;


-- ---------------------------------------------------------------------------
-- DONE.
-- Expected result: "Success. No rows returned."
--
-- Quick check that it worked — run this separately:
--   select table_name from information_schema.tables
--   where table_schema = 'public';
-- You should see: thoughts, thought_links, thought_sources, thought_chunks
-- ---------------------------------------------------------------------------
