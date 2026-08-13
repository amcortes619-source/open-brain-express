// ============================================================================
// OPEN-BRAIN-MCP
// ============================================================================
// This is what lets Claude read your brain directly, inside any conversation.
//
// MCP (Model Context Protocol) is an open standard for connecting AI
// assistants to outside tools and data. Claude speaks it, and so does a
// growing list of other AI tools. Because it is a standard and not a Claude
// feature, switching to a different AI later means pointing that AI at this
// same address — nothing here needs to change.
//
// HOW THE PIECES FIT:
//   Claude  ->  this function  ->  your database
// Claude never touches your database directly. It asks this function
// questions, and this function decides what it is allowed to see.
//
// ---------------------------------------------------------------------------
// IMPORTANT — DEPLOYING THIS ONE IS DIFFERENT:
//
//   npx supabase functions deploy open-brain-mcp --no-verify-jwt
//
// Every other function is called by your logged-in web app, which sends a
// login token. This one is called by Claude Desktop, which cannot send a
// Supabase login token — it has no idea what Supabase is. Without
// --no-verify-jwt, Supabase rejects every request before this code even runs,
// and Claude reports a mysterious connection failure.
//
// That is why this file guards itself with MCP_ACCESS_KEY instead. Requests
// without the right key are refused below.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateEmbedding, corsHeaders } from '../_shared/ai.ts'
import { saveThoughtRow } from '../_shared/save-thought.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY') ?? ''

// Which brain this server serves. Set during setup, right after you create
// your login. Without it this function does not know whose thoughts to return.
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

const PROTOCOL_VERSION = '2024-11-05'

// ---------------------------------------------------------------------------
// The tools Claude will see
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'search_brain',
    description:
      'Search the user\'s personal knowledge base by meaning, not just keywords. ' +
      'Returns matching thoughts along with related thoughts that are connected ' +
      'to them in the knowledge graph. Use this whenever the user refers to ' +
      'something they saved, read, watched, or noted previously.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain language' },
        limit: { type: 'number', description: 'How many results (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description:
      'List the most recently saved thoughts, newest first. Use this to catch ' +
      'up on what the user has been capturing lately.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return (default 10)' },
      },
    },
  },
  {
    name: 'add_thought',
    description:
      'Save something new into the user\'s brain. Use this when the user asks ' +
      'you to remember, note, or capture something.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text to save' },
      },
      required: ['content'],
    },
  },
]

// ---------------------------------------------------------------------------
function rpcResult(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function rpcError(id: unknown, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** MCP tools reply with text content blocks. */
function textResult(id: unknown, text: string): Response {
  return rpcResult(id, { content: [{ type: 'text', text }] })
}

function formatThought(t: {
  content: string
  created_at: string
  source?: string | null
  category?: string | null
  tags?: string[] | null
  similarity?: number
  match_source?: string
  chunk_origin?: string
}): string {
  const date = new Date(t.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
  const bits = [date]
  if (t.source && t.source !== 'text') bits.push(t.source)
  if (t.category) bits.push(t.category)
  if (typeof t.similarity === 'number' && t.similarity > 0) bits.push(`${Math.round(t.similarity * 100)}% match`)
  // match_source/chunk_origin only come back from search_brain, not list_recent. A 'source' chunk
  // matched the full article/transcript text, which is not part of the content printed below —
  // say so, or the match looks unexplained.
  if (t.match_source === 'chunk') {
    bits.push(t.chunk_origin === 'source' ? 'matched in full source text' : 'matched in an excerpt')
  }
  const tagLine = t.tags?.length ? `\ntags: ${t.tags.join(', ')}` : ''
  return `[${bits.join(' · ')}]${tagLine}\n${t.content}`
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // --- Gate ---------------------------------------------------------------
  // Since Supabase's own check is switched off for this function, this is the
  // only thing standing between the internet and your brain. Treat the key
  // like a password.
  const auth = req.headers.get('Authorization') ?? ''
  const presented = auth.replace(/^Bearer\s+/i, '').trim()

  if (!MCP_ACCESS_KEY) {
    console.error('[mcp] MCP_ACCESS_KEY is not set — refusing all requests')
    return new Response('Server not configured', { status: 500, headers: corsHeaders })
  }
  if (presented !== MCP_ACCESS_KEY) {
    console.log('[mcp] Rejected a request with a bad or missing key')
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return rpcError(null, -32700, 'Could not parse request')
  }

  const { id, method, params } = body
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  try {
    // --- Handshake --------------------------------------------------------
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'open-brain', version: '1.0.0' },
      })
    }

    // Notifications carry no id and expect no reply
    if (typeof method === 'string' && method.startsWith('notifications/')) {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS })
    }

    if (method !== 'tools/call') {
      return rpcError(id, -32601, `Unknown method: ${method}`)
    }

    if (!OWNER_USER_ID) {
      return textResult(id, 'This brain is not finished setting up: OWNER_USER_ID is missing from the Supabase secrets.')
    }

    const toolName = params?.name as string
    const args = (params?.arguments ?? {}) as Record<string, unknown>

    // --- search_brain -----------------------------------------------------
    if (toolName === 'search_brain') {
      const query = String(args.query ?? '').trim()
      const limit = Math.min(Number(args.limit) || 8, 25)
      if (!query) return textResult(id, 'No search text was provided.')

      const embedding = await generateEmbedding(query, { userId: OWNER_USER_ID, source: 'mcp' })

      // Meaning and exact-word matching in one call, fused by rank. A null
      // embedding (AI key missing, or a brief OpenRouter outage) degrades
      // gracefully to keyword-only instead of returning nothing.
      const { data, error } = await supabase.rpc('search_thoughts_hybrid', {
        p_user_id: OWNER_USER_ID,
        query_text: query,
        query_embedding: embedding,
        match_threshold: 0.3,
        match_count: limit,
      })
      if (error) console.error('[mcp] search failed:', error.message)
      const rows = data ?? []

      if (rows.length === 0) {
        return textResult(id, `Nothing in the brain matches "${query}".`)
      }

      // For each hit, also pull what it is connected to. This is the part that
      // surfaces things the user forgot they saved.
      const sections: string[] = []
      for (const row of rows) {
        let block = formatThought(row)

        const { data: links } = await supabase
          .from('thought_links')
          .select('source_thought_id, target_thought_id, similarity_score')
          .or(`source_thought_id.eq.${row.id},target_thought_id.eq.${row.id}`)
          .order('similarity_score', { ascending: false })
          .limit(3)

        if (links?.length) {
          const neighbourIds = links
            .map(l => l.source_thought_id === row.id ? l.target_thought_id : l.source_thought_id)
            .filter(nid => !rows.some(r => r.id === nid))   // skip ones already shown

          if (neighbourIds.length) {
            const { data: neighbours } = await supabase
              .from('thoughts')
              .select('content, created_at')
              .in('id', neighbourIds)

            if (neighbours?.length) {
              const connected = neighbours
                .map(n => `    ↳ ${n.content.slice(0, 200).replace(/\s+/g, ' ')}…`)
                .join('\n')
              block += `\n  Connected to:\n${connected}`
            }
          }
        }

        sections.push(block)
      }

      return textResult(
        id,
        `Found ${rows.length} thought${rows.length === 1 ? '' : 's'} for "${query}":\n\n` +
        sections.join('\n\n---\n\n')
      )
    }

    // --- list_recent ------------------------------------------------------
    if (toolName === 'list_recent') {
      const limit = Math.min(Number(args.limit) || 10, 50)
      const { data, error } = await supabase
        .from('thoughts')
        .select('content, created_at, source, category, tags')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) return textResult(id, `Could not read the brain: ${error.message}`)
      if (!data?.length) return textResult(id, 'The brain is empty.')

      return textResult(
        id,
        `The ${data.length} most recent thoughts:\n\n` +
        data.map(formatThought).join('\n\n---\n\n')
      )
    }

    // --- add_thought ------------------------------------------------------
    if (toolName === 'add_thought') {
      const content = String(args.content ?? '').trim()
      if (!content) return textResult(id, 'Nothing to save — no content was provided.')

      try {
        const saved = await saveThoughtRow(supabase, {
          user_id: OWNER_USER_ID,
          content,
          source: 'claude',
        })
        return textResult(
          id,
          saved.deduped
            ? 'That was already in the brain — no new copy made.'
            : 'Saved to the brain. Tags, category and connections will be added automatically within a few seconds.'
        )
      } catch (err: any) {
        return textResult(id, `Could not save: ${err?.message ?? String(err)}`)
      }
    }

    return textResult(id, `Unknown tool: ${toolName}`)

  } catch (err) {
    console.error('[mcp] Failed:', String(err))
    return rpcError(id, -32603, String(err))
  }
})
