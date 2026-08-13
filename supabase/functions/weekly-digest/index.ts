// ============================================================================
// WEEKLY-DIGEST
// ============================================================================
// Once a week, your brain reads back what you fed it and writes you a short
// report: what you were paying attention to, the themes running through it, and
// a question you seem to be circling.
//
// It saves that report into your brain as a thought, so it gets tagged and
// linked like anything else — and so a year from now you can search your own
// weekly summaries.
//
// NOTHING CALLS THIS BY HAND. A scheduled job inside your database calls it,
// set up in Session 2. To change when it runs, or to turn it off, see the
// bottom of this file.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLM, corsHeaders, jsonResponse } from '../_shared/ai.ts'
import { saveThoughtRow } from '../_shared/save-thought.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Below this, a week is too thin to be worth summarising. Writing "you saved
// two things" is worse than writing nothing.
const MIN_THOUGHTS = 5

interface Thought {
  content: string
  category: string | null
  tags: string[] | null
  source: string
  created_at: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // Who captured anything this week? Written as a loop over users so the same
    // function works whether one person or a household shares this database.
    // Digests themselves are excluded — otherwise next week summarises last
    // week's summary, and the brain slowly starts talking only to itself.
    const { data: recent, error: recentError } = await supabase
      .from('thoughts')
      .select('user_id, content, category, tags, source, created_at')
      .gte('created_at', since)
      .neq('source', 'digest')
      .order('created_at', { ascending: true })

    if (recentError) {
      console.error('[digest] Could not read thoughts:', recentError.message)
      return jsonResponse({ ok: false, error: recentError.message }, 500)
    }

    if (!recent?.length) {
      console.log('[digest] Nothing captured this week — nothing to do')
      return jsonResponse({ ok: true, users: 0, note: 'no activity' })
    }

    // Group by person
    const byUser = new Map<string, Thought[]>()
    for (const row of recent as Array<Thought & { user_id: string }>) {
      const list = byUser.get(row.user_id) ?? []
      list.push(row)
      byUser.set(row.user_id, list)
    }

    const results: Array<{ user: string; status: string; count: number }> = []

    for (const [userId, thoughts] of byUser) {
      if (thoughts.length < MIN_THOUGHTS) {
        console.log(`[digest] ${userId}: only ${thoughts.length} thoughts — skipping`)
        results.push({ user: userId, status: 'too few', count: thoughts.length })
        continue
      }

      // Lay the week out for the AI, grouped by category so themes are visible
      const grouped = new Map<string, string[]>()
      for (const t of thoughts) {
        const key = t.category ?? 'uncategorised'
        const list = grouped.get(key) ?? []
        list.push(`- [${t.source}] ${t.content.replace(/\s+/g, ' ').slice(0, 700)}`)
        grouped.set(key, list)
      }

      const body = [...grouped.entries()]
        .map(([cat, items]) => `## ${cat}\n${items.join('\n')}`)
        .join('\n\n')
        .slice(0, 24_000)

      const summary = await callLLM({
        systemPrompt:
          'You write a weekly reflection for someone based on what they saved ' +
          'into their personal knowledge base. Write to them directly as "you". ' +
          'Be specific and concrete — refer to the actual things they captured, ' +
          'not vague generalities. Never flatter them.',
        prompt:
          `Here is everything this person captured over the past seven days, ` +
          `grouped by category.\n\n` +
          `Write them a short report with three parts:\n\n` +
          `1. WHAT YOU WERE ON — two or three sentences on what actually held ` +
          `their attention this week.\n` +
          `2. THREADS — two to four themes running through it, including any ` +
          `connection between things they may not have noticed were related.\n` +
          `3. THE QUESTION — one question they appear to be circling without ` +
          `having answered. Make it the real one, not a comfortable one.\n\n` +
          `Keep the whole thing under 400 words. No preamble, no sign-off.\n\n` +
          `${body}`,
        maxTokens: 900,
        userId,
        source: 'weekly-digest',
      })

      if (!summary) {
        console.error(`[digest] ${userId}: AI unavailable — skipping this week`)
        results.push({ user: userId, status: 'ai unavailable', count: thoughts.length })
        continue
      }

      const from = new Date(since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const to = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

      try {
        await saveThoughtRow(supabase, {
          user_id: userId,
          content: `🗓️ Your week — ${from} to ${to}\n\n${summary}`,
          source: 'digest',
          category: 'digest',
          metadata: {
            period_start: since,
            period_end: new Date().toISOString(),
            thoughts_covered: thoughts.length,
          },
        })
      } catch (err: any) {
        console.error(`[digest] ${userId}: could not save:`, String(err))
        results.push({ user: userId, status: 'save failed', count: thoughts.length })
        continue
      }

      console.log(`[digest] ${userId}: written from ${thoughts.length} thoughts`)
      results.push({ user: userId, status: 'written', count: thoughts.length })
    }

    return jsonResponse({ ok: true, users: results.length, results })

  } catch (err) {
    console.error('[digest] Failed:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})

// ============================================================================
// CHANGING THE SCHEDULE
// ============================================================================
// The schedule lives in your database, not in this file. To see it:
//
//   select * from cron.job;
//
// To change when it runs, unschedule and re-add it (times are UTC):
//
//   select cron.unschedule('weekly-brain-digest');
//
// then re-run the scheduling block from Session 2 with a different pattern.
// The five fields are: minute hour day-of-month month day-of-week
//
//   '0 8 * * 0'    Sundays at 08:00      (the default)
//   '0 7 * * 1'    Mondays at 07:00
//   '0 20 * * 5'   Fridays at 20:00
//   '0 8 1 * *'    the 1st of each month at 08:00
//
// To stop it entirely, just run the unschedule line on its own.
// ============================================================================
