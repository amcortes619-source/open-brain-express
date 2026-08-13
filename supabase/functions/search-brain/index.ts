// ============================================================================
// SEARCH-BRAIN
// ============================================================================
// Powers the Search tab in the web app.
//
// WHY THIS NEEDS TO BE A SERVER FUNCTION: searching by meaning means turning
// your search phrase into the same kind of numeric fingerprint your thoughts
// have, then finding the closest ones. Making that fingerprint requires an AI
// key, and an AI key must never sit in a web page where anyone could read it.
// So the browser sends the phrase here, and this function does the rest.
//
// If the fingerprint cannot be made for any reason, this falls back to plain
// keyword matching rather than returning nothing.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateEmbedding, corsHeaders, jsonResponse } from '../_shared/ai.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Identify the searcher from their login token. This is what stops one
    // person searching another person's brain.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return jsonResponse({ ok: false, error: 'Not signed in' }, 401)
    }

    const { query, limit } = await req.json()
    const q = String(query ?? '').trim()
    if (!q) return jsonResponse({ ok: false, error: 'Nothing to search for' }, 400)

    const count = Math.min(Number(limit) || 20, 50)
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // Meaning and exact-word matching in one call, fused by rank (see
    // migration.sql section 8). If the embedding call fails — the AI key is
    // missing, or OpenRouter is briefly down — query_embedding is null and
    // the function gracefully runs keyword-only instead of returning nothing.
    const embedding = await generateEmbedding(q, { userId: user.id, source: 'search-brain' })

    const { data, error } = await admin.rpc('search_thoughts_hybrid', {
      p_user_id: user.id,
      query_text: q,
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: count,
    })
    if (error) return jsonResponse({ ok: false, error: error.message }, 500)

    const results = data ?? []
    const mode = embedding ? 'hybrid' : 'keyword'

    return jsonResponse({ ok: true, mode, count: results.length, results })

  } catch (err) {
    console.error('[search] Failed:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})
