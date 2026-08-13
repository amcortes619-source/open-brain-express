# Open Brain — Express

A personal knowledge base you own. Save anything worth remembering — typed
notes, spoken thoughts, YouTube videos, PDFs, web articles — and it works out
what each thing is about and connects related ideas together on its own. Then
point Claude at it and it can search everything you have ever saved.

*Una base de conocimiento personal que te pertenece. Todo el proceso está
disponible en español.*

**Not sure where to start?** → **[WELCOME.md](WELCOME.md)** asks one
question and sends you to the right page — new brain or existing one, in
either language.
*¿No sabes por dónde empezar?* → **[WELCOME.md](WELCOME.md#bienvenido)**
*hace una pregunta y te manda a la página correcta — cerebro nuevo o
existente, en cualquiera de los dos idiomas.*

---

**New here? Two minutes of context first:**
[What is this and what do I do with it?](WHAT-IS-THIS.md) · [¿Qué es esto y para qué sirve?](QUE-ES-ESTO.md)

# 🚀 → **[START HERE / EMPIEZA AQUÍ](START-HERE.md)** ←

**There is one prompt. Copy it, paste it into Claude, press enter.**
It asks your language first, checks what you already have, and takes it from
there. Works in Claude Code or in claude.ai in a browser. **Nothing needs to be
installed before you begin.**

*Hay un solo prompt. Cópialo, pégalo en Claude, presiona Enter. Te pregunta tu
idioma antes que nada. No necesitas tener nada instalado para empezar.*

---

### Already have a brain? · ¿Ya tienes un cerebro?

Built one before — the seven-level course, the bare-bones starter repo, or an
earlier version of this Express repo? Don't start over. There's a page for
bringing an existing brain up to date without losing anything in it, and it
says plainly what upgrading actually gets you:

# → **[UPGRADE / ACTUALIZAR](UPGRADE.md)** ←

*¿Construiste uno antes — con el curso de siete niveles, el repositorio
inicial, o una versión anterior de este repositorio Express? No empieces de
cero. Hay una página para poner al día un cerebro existente sin perder nada
de lo que ya tienes, y ahí te dice claramente qué consigues al actualizar.*

---

## Everything below is reference

You do not need to read any of it. The prompt above opens these files for you at
the right moment. They are here so you can look things up later, or see what is
going to happen before it happens.

| | English | Español |
|---|---|---|
| Accounts and keys | [Session 1](Session-1-Accounts.md) | [Sesión 1](Sesion-1-Cuentas.md) |
| The build | [Session 2](Session-2-Build.md) | [Sesión 2](Sesion-2-Construir.md) |
| Telegram *(optional)* | [Session 2b](Session-2b-Telegram.md) | [Sesión 2b](Sesion-2b-Telegram.md) |
| Claude + filling your brain | [Session 3](Session-3-Connect.md) | [Sesión 3](Sesion-3-Conectar.md) |

Roughly 3–4 hours end to end, most of it waiting. You can stop after the build
and come back another day — what you built stays built.

---

## What you end up with

- A **web app** at your own URL, installable on your phone
- A **database you own** — export it any time, take it anywhere
- **Search by meaning AND by exact word, fused together.** Ask for "how do I
  get new clients" and find the note you wrote about customer acquisition, in
  different words — but an exact name, account number or unusual term still
  finds its match too, which meaning alone is unreliable at
- **The full text is kept, not just the summary.** An article or video gets
  summarised for readability, but the whole thing stays underneath, split into
  overlapping sections, so a detail the summary left out is still searchable
- **A graph that builds itself.** Every new thought finds related older ones and
  links to them. Things you forgot resurface on their own
- **Claude reading your brain** in any conversation, through MCP
- **What it has actually cost you**, shown in the app — not an estimate, the real
  number, so you never have to take anyone's word for it
- **A weekly report on yourself.** Every Sunday your brain reads back the week
  and writes you a short summary: what held your attention, what themes ran
  through it, and the question you appear to be circling

---

## What it costs

The infrastructure is free — Supabase, Vercel and GitHub all have free tiers
this fits inside comfortably.

The one paid piece is an AI key from OpenRouter, used to tag your thoughts and
work out their meaning. Put $5–$10 on it and it will most likely last months.
Saving fifty things a month costs well under a dollar.

**Your Claude subscription does not cover this** — that pays for you talking to
Claude, not for your software calling an AI on its own. Different product,
separate bill. Session 1 explains this properly.

---

## Not locked in

Every AI call goes through one file — [`supabase/functions/_shared/ai.ts`](supabase/functions/_shared/ai.ts).
Change the model names at the top and your whole brain switches providers.
Nothing else changes.

The Claude connection uses MCP, an open standard. If you move to a different AI
that speaks it, you point that one at the same address. Your data never moves,
because it was never anywhere but your own database.

---

## What's in here

```
migration.sql              The database: tables, login protection, hybrid
                            search, chunking, the graph — one file, safe to
                            re-run any time
index.html                 The app
config.js                  Your Supabase details (filled in during Session 2)
manifest.json, sw.js       Makes it installable on a phone

supabase/functions/
  _shared/ai.ts            Every AI call. Change models here and nowhere else.
  _shared/text.ts          Turns HTML entities (&rsquo; &ntilde; etc) into real characters
  _shared/chunking.ts      Splits long text into overlapping, retrievable sections
  _shared/thought-chunks.ts    Embeds and stores those sections
  _shared/thought-sources.ts   Keeps the full article/transcript, not just the summary
  _shared/save-thought.ts  The one place a thought gets written — saving the
                            same thing twice updates it instead of duplicating it
  enrich-thought           Tags, embeds, chunks and links each thought automatically
  capture-youtube          Fetches real transcripts, four different ways
  capture-url              Reads any web page server-side
  search-brain             Meaning + exact-word search, fused into one ranking
  open-brain-mcp           What Claude Desktop talks to
  weekly-digest            Sunday morning report, run by a schedule in your database
  telegram-bot             Text your brain from your phone (optional)
```

---

## A few things worth knowing

**Your brain is private.** The database refuses to return anything unless you
are logged in, and only ever returns your own rows. The key in `config.js` is
public on purpose and cannot read anything by itself.

**Deploy the MCP server with `--no-verify-jwt`.** It is the one exception, and
the reason is explained at the top of that file. Without the flag Claude Desktop
fails to connect with no useful error.

**YouTube is deliberately complicated.** YouTube hides subtitles from servers,
so `capture-youtube` tries several routes and takes the first that works. If you
find yourself "simplifying" it, read the comments at the top first.

**If a deploy fails, let Claude Code fix it.** Services change their APIs. This
repository is not actively maintained — it is meant to be repaired in place, and
Claude Code is told it is allowed to do that.

---

## Credit

Built from a working system by the author, who runs a version of this with
thousands of thoughts and tens of thousands of automatic connections. This is a
stripped-down version of that, meant to be stood up in an afternoon.

There is also a longer seven-level course that teaches you to build all of this
yourself, step by step, rather than having it installed for you. This version is
for people who want the thing working. That version is for people who want to
understand every piece.
