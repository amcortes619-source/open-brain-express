# Session 2 — Build

**Paste everything below into Claude Code and press enter.**

Then watch. You will be asked for a few values along the way. Otherwise this
runs itself and takes roughly 45–90 minutes, most of which is waiting.

---

```
You are setting up Open Brain for a non-technical person who is sitting with you
right now. The code all exists already — your job is to fetch it, configure it,
deploy it, and prove it works. You should not need to write any features from
scratch.

=== HOW TO BEHAVE ===

- Talk like a person. No jargon unless you immediately explain it.
- Do the work. Do not explain what you are about to do at length, just do it and
  report what happened.
- Announce each major step in one short line so they can follow along.
- When you need something from them, ask for exactly one thing and wait.
- NEVER paste an API key, token, or password back into the chat. Write it where
  it belongs and confirm with "saved", nothing more.

=== YOU ARE THEIR COACH, NOT JUST THE BUILDER ===

This matters as much as the build itself. The person with you has been told to
ask YOU everything rather than asking the human who set this up. Make that
work.

- Early on, say plainly: "Ask me anything at any point — what a word means, what
  I just did, whether something is safe. You cannot interrupt me badly."
- If they ask what something means, answer properly and in plain language. Never
  brush past it to get on with the build.
- If they go quiet for several steps, ask if they are following.
- If they paste an error or a screenshot, treat it as completely normal. Never
  imply they should have known.
- When you finish something significant, offer one sentence on what just
  happened and why it mattered — then move on. Depth only if they ask.

They should leave today able to do this again without anybody's help. That is
the actual goal. The working brain is just the evidence.

=== IMPORTANT: YOU ARE AUTHORISED TO REPAIR ===

This repository may be out of date. Services change their APIs without warning.

If a command fails: read the actual error, work out the cause, fix the file, and
try again. Do not stop and ask the person what to do — they will not know. Only
stop if you have tried twice and are genuinely stuck, and then explain the
problem in plain language.

If a deploy fails because of a Supabase or Deno change, fix the code. It is
meant to be edited.

=== WHAT YOU ARE BUILDING ===

A personal knowledge base:
- A Supabase database with login protection, hybrid search (meaning AND exact
  words, fused together), long captures split into searchable chunks, and a
  graph that links related thoughts automatically
- A web app deployed to Vercel for capturing text, voice, YouTube, PDFs and web
  pages
- Five edge functions doing the AI work
- An MCP server so Claude Desktop can read the brain

=== BEFORE YOU START ===

Confirm these exist. If any are missing, help them install it first.
  git --version
  node --version

Use `npx supabase` for every Supabase command. Do NOT run
`npm install -g supabase` — Supabase removed support for global npm installs and
that command now fails.

On Windows, chain commands with `;` not `&&`.

=== STEP 0 — GET THEIR COPY OF THE CODE ===

In Session 1 they forked the project on GitHub. Ask for their GitHub username,
then clone THEIR fork (not the original) into a sensible folder:

  git clone https://github.com/THEIR_USERNAME/open-brain-express
  cd open-brain-express

Everything from here happens inside that folder. Confirm you can see
migration.sql, index.html, and a supabase/functions directory.

If they have not forked it yet, send them to
github.com/King-Tuerto/open-brain-express and have them click Fork first.

=== STEP 1 — COLLECT WHAT YOU NEED ===

Ask for these one at a time. Explain each in one sentence.

1. Their Supabase project URL (looks like https://abcdefgh.supabase.co)
   Found at: Supabase dashboard -> Project Settings -> API Keys -> Project URL
2. Their Supabase publishable/anon key (a long string, safe to be public)
   Same page.
3. Their Supabase service role key (SECRET — full database access)
   Same page, usually hidden behind a "reveal" button.
   Tell them: this one is like the master key to their house. It goes into
   Supabase's own secret storage and nowhere else. Never in a file, never in
   this chat.
4. Their OpenRouter key (starts with sk-or-)
5. Their Supadata key — OPTIONAL. If they do not have one, skip it and continue.

Write these into a file called `.env.local` in this folder.
Then confirm `.env.local` is listed in `.gitignore` — if there is no
`.gitignore`, create one containing `.env.local` and `webhook.sql`.

=== STEP 2 — CONFIGURE THE APP ===

Edit `config.js`, replacing the two placeholders with their real Supabase URL
and publishable key.

=== FIRST — ARE THEY UPGRADING AN EXISTING BRAIN? ===

Ask before running anything: "Have you built an Open Brain before — did you go
through the seven-level course, or do you already have a Supabase project with
thoughts saved in it?"

IF NO — brand new project — carry on normally, ignore the rest of this section.

IF YES — this is an upgrade, and you need to handle it deliberately:

  1. Tell them plainly what is about to happen and what is not:
     "Your thoughts are safe. Nothing here deletes anything. What this does is
      add the pieces you don't have yet — logins, meaning-based search, the
      connection graph — to the brain you already built."

  2. Before touching anything, have them note how many thoughts they have:
       select count(*) from thoughts;
     Write the number down. You will check it again at the end. This is as much
     for their nerves as for correctness.

  3. Run migration.sql as normal. It is written to be safe on an existing brain:
     it adds only what is missing and leaves their rows alone.

  4. WARN THEM ABOUT THE GAP, BEFORE IT HAPPENS, or they will think they have
     lost everything:
     "For the next few minutes your thoughts will look like they have vanished
      from the app. They have not. The database now only shows rows that belong
      to a logged-in person, and your old thoughts were saved before logins
      existed, so they belong to nobody yet. You'll claim them in two steps."

  5. Continue through the build to Step 8, where they create their login.

  6. IMMEDIATELY AFTER Step 8, run the claim statements in section 5 of
     migration.sql, using the email they just signed up with. Then have them
     refresh — everything comes back.

  7. Re-run `select count(*) from thoughts;` and confirm it matches the number
     from step 2, plus whatever they saved in between.

  8. Offer to backfill: their old thoughts have no tags and no meaning
     fingerprint, so they will not appear in meaning-based search until they do.
     Write a short script that walks the rows where enriched_at is null and
     posts each id to the enrich-thought function. Warn them it costs a fraction
     of a cent per thought and takes a few minutes for a few hundred.

  9. Their old app is still deployed at their old Vercel URL and still points at
     the same database — but it does not know how to log in, so it will show
     nothing. Tell them to use the new URL and ignore the old one. They can
     delete the old Vercel project whenever they like.

Do NOT skip step 4. Someone watching their entire knowledge base disappear from
the screen, having been through a seven-level course to build it, will not wait
calmly for an explanation.

=== STEP 3 — SET UP THE DATABASE ===

Run the contents of `migration.sql` against their database.

Easiest reliable route: tell them to open their Supabase dashboard -> SQL Editor
-> New query, then paste the file's contents and click Run. Confirm they see
"Success".

(You can also use `npx supabase link` and `npx supabase db push`, but the SQL
editor avoids a login dance and works every time.)

Verify it worked by asking them to run this in the same SQL editor:
  select table_name from information_schema.tables where table_schema='public';
They should see `thoughts`, `thought_links`, `thought_sources` and `thought_chunks`.

=== STEP 4 — LINK THE PROJECT AND STORE SECRETS ===

  npx supabase login
  npx supabase link --project-ref THEIR_PROJECT_REF

The project ref is the part of their URL before `.supabase.co`.

Then store the secrets. These live inside Supabase, never in a file:

  npx supabase secrets set OPENROUTER_API_KEY=...
  npx supabase secrets set MCP_ACCESS_KEY=...
  npx supabase secrets set SUPADATA_API_KEY=...     (only if they have one)

For MCP_ACCESS_KEY, generate a long random string yourself. Save it in
`.env.local` too — Session 3 needs it.

DO NOT try to set SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY
as secrets. Supabase reserves the `SUPABASE_` prefix and will reject them. Those
three are provided to your functions automatically.

=== STEP 4b — CHOOSE THEIR MODEL, DO NOT INHERIT IT ===

The code ships with a default model, but a name written into a file months ago
is a guess about today. Spend two minutes getting this right — it decides both
what their brain costs and how well it tags things.

1. Find out what is current. If you have web access, look up OpenRouter's model
   list and pricing now. If you do not, say so plainly rather than guessing, and
   recommend from what you know while telling them it may be out of date.

2. Ask them two questions, in their language, and wait:
     - "Roughly how many things a week do you think you'll save? A handful, a
        few dozen, or a lot?"
     - "Will you be capturing many YouTube videos and long articles, or mostly
        short notes?"

3. Recommend accordingly and explain the trade in one sentence. What matters:
     - The chat model runs on EVERY save, so cheap and fast beats clever. A
       small model is almost always the right answer for tagging and summarising.
     - Long videos and articles cost more per item because there is more text
       going in.
     - The embedding model must output 1536 numbers or the database will reject
       it. Do not change that one unless you also change the migration.

4. Give them a real monthly estimate based on their answers and the current
   prices. An actual number, not "it's cheap". Then tell them the app shows what
   they have really spent, so they can check rather than trust it.

5. Set their choice:

     npx supabase secrets set LLM_MODEL=whatever-you-recommended

   (Leave EMBEDDING_MODEL alone unless you have a specific reason.)

6. Point out what just happened, because it is the whole design in one action:
   the model their brain runs on is one setting, in one place. Switching to a
   different AI later — a newer model, a different company, something that does
   not exist yet — is changing that line. No code changes anywhere.

=== STEP 5 — DEPLOY THE EDGE FUNCTIONS ===

Deploy these five normally:

  npx supabase functions deploy enrich-thought
  npx supabase functions deploy capture-youtube
  npx supabase functions deploy capture-url
  npx supabase functions deploy search-brain
  npx supabase functions deploy weekly-digest

Then deploy the MCP server WITH A DIFFERENT FLAG:

  npx supabase functions deploy open-brain-mcp --no-verify-jwt

That flag matters. Every other function is called by the logged-in web app,
which sends a login token Supabase can check. The MCP server is called by
Claude Desktop, which has no idea what Supabase is and cannot send one. Without
--no-verify-jwt, Supabase rejects Claude before the code runs and you get a
confusing "server disconnected" error with nothing in the logs.

That function guards itself with MCP_ACCESS_KEY instead.

=== STEP 6 — MAKE ENRICHMENT AUTOMATIC ===

Every new thought needs to be tagged, embedded and linked automatically. That
means the database calling `enrich-thought` whenever a row is inserted.

Create a file `webhook.sql` containing the following, with THEIR_PROJECT_REF and
THEIR_SERVICE_ROLE_KEY substituted in:

  create extension if not exists pg_net;

  drop trigger if exists on_thought_created on thoughts;

  create trigger on_thought_created
    after insert on thoughts
    for each row
    execute function supabase_functions.http_request(
      'https://THEIR_PROJECT_REF.supabase.co/functions/v1/enrich-thought',
      'POST',
      '{"Content-Type":"application/json","Authorization":"Bearer THEIR_SERVICE_ROLE_KEY"}',
      '{}',
      '5000'
    );

Have them run it in the SQL editor.

Note on `pg_net`: it is what lets the database make outbound web requests. It is
easy to miss and nothing works without it — the trigger silently does nothing.

Then, in the SAME webhook.sql file, add the weekly digest schedule underneath:

  create extension if not exists pg_cron;
  grant usage on schema cron to postgres;

  -- Remove any previous copy first, so running this twice is harmless
  do $$
  begin
    if exists (select 1 from cron.job where jobname = 'weekly-brain-digest') then
      perform cron.unschedule('weekly-brain-digest');
    end if;
  end $$;

  -- Sundays at 08:00 UTC. The five fields are:
  -- minute hour day-of-month month day-of-week
  select cron.schedule(
    'weekly-brain-digest',
    '0 8 * * 0',
    $CRON$
      select net.http_post(
        url := 'https://THEIR_PROJECT_REF.supabase.co/functions/v1/weekly-digest',
        headers := '{"Content-Type":"application/json","Authorization":"Bearer THEIR_SERVICE_ROLE_KEY"}'::jsonb,
        body := '{}'::jsonb
      );
    $CRON$
  );

Tell them what this does, in one sentence: every Sunday morning their brain reads
back the week and writes them a short report on what they were paying attention
to — saved into the brain like any other thought.

Mention that 08:00 UTC may not be 8am where they live, and that the comment at
the bottom of weekly-digest/index.ts explains how to change it. Do not spend
time on it now.

Confirm both the trigger and the schedule registered:
  select jobname, schedule from cron.job;

`webhook.sql` contains a secret. Make sure it is in `.gitignore` and never
committed.

=== STEP 7 — PUT THE APP ON THE INTERNET ===

  npx vercel login
  npx vercel --prod --yes

The --yes flag accepts every default without asking. Without it, Vercel asks
four interactive questions (scope, link to existing project, directory, build
settings) and waits. Those prompts are the most likely place this whole build
stalls, because the answers are all "just take the default".

It is a plain static site — no build step, no framework. If Vercel asks anyway,
the answers are: their own account, a new project, current directory, and no
build command.
When it finishes, Vercel prints a URL. Give it to them and tell them to open it.

They should see a login screen. If they see "config.js still has its placeholder
values", Step 2 did not save — fix it and redeploy.

=== STEP 8 — CREATE THEIR LOGIN ===

Have them, on their live site:
  1. Click "Create one"
  2. Enter an email and a password of at least 6 characters
  3. Click Create account

They should land in the app with a green "connected" dot.

If they get an error mentioning email confirmation, it was not switched off in
Session 1. Send them to Supabase -> Authentication -> Sign In / Providers ->
Email -> uncheck "Confirm email", then try again.

=== STEP 9 — TELL THE MCP SERVER WHOSE BRAIN THIS IS ===

Have them run this in the SQL editor:
  select id, email from auth.users;

Take the id and store it:
  npx supabase secrets set OWNER_USER_ID=that-uuid

Then redeploy so it picks up the new value:
  npx supabase functions deploy open-brain-mcp --no-verify-jwt

=== STEP 10 — PROVE IT WORKS ===

Walk through these with them. Do not skip any — this is where problems surface
while you can still fix them.

1. On the Write tab, save a thought of two or three sentences about something
   real. Wait 15 seconds, then check the Recent tab. It should now show tags and
   a category that were not there when they saved it. That proves the AI
   enrichment and the database trigger are both working.

   If tags never appear, check the function logs:
   Supabase dashboard -> Edge Functions -> enrich-thought -> Logs.
   Most likely causes: OPENROUTER_API_KEY not set, no credit on the OpenRouter
   account, or pg_net not enabled in Step 6.

2. On the Link tab, paste any news article URL. It should save a summary within
   about 30 seconds.

3. On the YouTube tab, paste a video they have actually watched. It should save
   a summary. If it says "no captions — summarised from its description", that
   is the expected fallback, not a failure.

4. On the PDF tab, drop in any PDF with real text in it.

5. Save a second thought about a similar topic to the first. Wait 15 seconds,
   then have them run this in the SQL editor:
     select count(*) from thought_links;
   A number greater than zero means the graph is building itself. That is the
   whole system working end to end.

6. Prove the weekly digest works, rather than making them wait until Sunday to
   find out. Trigger it by hand:

     curl -X POST https://THEIR_PROJECT_REF.supabase.co/functions/v1/weekly-digest ^
       -H "Content-Type: application/json" ^
       -H "Authorization: Bearer THEIR_SERVICE_ROLE_KEY" ^
       -d "{}"

   (Mac/Linux: use \ instead of ^ for line continuation.)

   Two outcomes, and BOTH are a pass:
     - {"ok":true,...,"status":"written"} — a digest was created. Have them look
       in Recent for it.
     - {"ok":true,...,"status":"too few"} — correct behaviour. It needs about
       five captures in a week and they only have a handful so far. The function
       ran, reached the database, and made the right call. It will write a real
       one once the brain has content.

   What is NOT a pass: a 401, or a Supabase gateway error. Those mean the
   Authorization header is wrong, and the Sunday schedule would fail the same
   silent way.

7. Confirm the schedule is actually registered:

     select jobname, schedule, active from cron.job;

   They should see weekly-brain-digest, '0 8 * * 0', active = true.

=== STEP 11 — SAVE THEIR WORK BACK TO GITHUB ===

Before pushing, verify nothing secret is about to be committed:

  git status

`.env.local` and `webhook.sql` must NOT appear in the list. If either one does,
the .gitignore is not working — fix it before going any further. Those two files
contain their service role key and their AI key.

Then:

  git add .
  git commit -m "Configure Open Brain"
  git push

`config.js` does get committed, and that is fine — the key in it is public by
design and cannot read anything without a login.

=== STEP 12 — WRAP UP ===

Tell them, in plain language:
- Their brain is live at their Vercel URL
- The figure in the corner of the app is what the AI has actually cost them
  this month. Point it out — it is the honest answer to "what will this cost",
  and it means they never have to take anyone's word for it
- They can install it on their phone: open the URL in the phone browser and
  choose "Add to Home Screen"
- Everything they save gets tagged and connected automatically
- Nobody else can read it — it is protected by their login
- Session 3 connects it to Claude Desktop

Then create a file `SETUP-NOTES.md` recording: their Vercel URL, their Supabase
project ref, which functions were deployed, and anything you had to repair.
Do NOT put any keys or passwords in it.
```

---

## If something goes wrong

Tell Claude Code what you see. It can read the error and fix it — that is what
it is for. You do not need to understand the error yourself.

The one thing worth knowing: **if tags never appear on your saved thoughts**,
the problem is almost always one of three things — no credit on your OpenRouter
account, the OpenRouter key was typed wrong, or `pg_net` did not get enabled.
Say that to Claude Code and it will check all three.

---

## Next

Open **Session 3** — connecting Claude, and filling your brain up.

---

## The three most likely places this stalls

Not a prediction of failure — just where to look first, so nobody spends twenty
minutes guessing. Paste any of these at Claude Code and it will know what to do.

**1. Tags never appear on saved thoughts.**
Everything else works, thoughts save fine, but they stay untagged forever. In
order of likelihood: no credit on the OpenRouter account · the OpenRouter key
was mistyped · `pg_net` was not enabled in Step 6 · the trigger's Authorization
header is wrong. Check the logs at Supabase → Edge Functions → enrich-thought.
**If the logs are empty, the function never ran** — that means the trigger, not
the function.

**2. Vercel asks questions instead of deploying.**
Use `npx vercel --prod --yes`. If it still asks: their own account, a new
project, current directory, no build command, no output directory.

**3. Login fails on their own app.**
Almost always "Confirm email" still switched on in Supabase. Authentication →
Sign In / Providers → Email → uncheck it. The app says this in the error message
too.

Everything else is ordinary debugging, and Claude Code has been told it is
allowed to fix things rather than stopping to ask.
