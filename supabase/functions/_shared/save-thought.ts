/**
 * The single way a thought gets written.
 *
 * WHY THIS EXISTS
 *   Every write path here (capture-url, capture-youtube, telegram-bot, the MCP server,
 *   weekly-digest, and the browser's own text/voice/PDF save) used a bare `.insert()`.
 *   None of them checked for a repeat. Paste the same article link twice, or have Telegram
 *   redeliver a message after a slow reply, and the same thought got saved twice — silently.
 *
 * HOW IT IS FIXED
 *   migration.sql puts a UNIQUE index on (dedup_key, user_id), where a BEFORE INSERT/UPDATE
 *   trigger defaults dedup_key to md5(content). This function writes through
 *   ON CONFLICT DO UPDATE, so a repeat capture resolves to one row and one update —
 *   atomically, inside the database, with no check-then-insert race to lose.
 *
 * IMPORTANT: callers must NOT go back to `.insert()`. With the unique index in place a bare
 * insert of already-captured content raises 23505 (Postgres) and the capture fails outright,
 * where before it silently duplicated. Going through here turns that same event into an
 * update, which is what you actually want.
 */

export interface ThoughtRow {
  content: string
  user_id: string
  source: string
  embedding?: unknown
  metadata?: Record<string, unknown>
  category?: string | null
  tags?: string[]
  [key: string]: unknown
}

export interface SaveThoughtOptions {
  /**
   * Force a NEW row for content that already exists — the deliberate re-capture case. Someone
   * may want to save the same passage twice on purpose (filed once as-is, then again with a note
   * added). Setting this supplies a unique dedup_key, so the row opts out of collapsing
   * permanently, including on any later edit.
   */
  allowDuplicate?: boolean
}

export interface SaveThoughtResult {
  id: string
  /** True when this collapsed onto an existing thought instead of creating one. */
  deduped: boolean
  createdAt: string
}

/**
 * Write a thought, collapsing an accidental repeat onto the existing row.
 * Throws on a real database error.
 */
export async function saveThoughtRow(
  supabase: any,
  row: ThoughtRow,
  opts: SaveThoughtOptions = {},
): Promise<SaveThoughtResult> {
  const payload: Record<string, unknown> = { ...row }

  if (opts.allowDuplicate) {
    // Unique by construction, so ON CONFLICT cannot match anything and a new row is created.
    payload.dedup_key = `forced:${crypto.randomUUID()}`
  }

  const { data, error } = await supabase
    .from('thoughts')
    .upsert(payload, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
    .select('id, created_at')
    .single()

  if (error) throw error

  // No direct "was this an insert or an update?" signal from PostgREST. created_at is set by
  // DEFAULT now() on insert and left alone by the update, so an older timestamp means this
  // collapsed onto an existing row. The 10s allowance covers clock skew and slow round-trips.
  const createdAt = data.created_at as string
  const deduped = Date.now() - new Date(createdAt).getTime() > 10_000

  return { id: data.id as string, deduped, createdAt }
}
