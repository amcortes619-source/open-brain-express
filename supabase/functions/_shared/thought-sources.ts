/**
 * Stores the SOURCE text a capture was summarised from, and chunks it for retrieval.
 *
 * capture-url and capture-youtube each hand a document (an article, a transcript) to the AI and
 * store the summary as thoughts.content. Left there, any detail the summariser did not carry
 * forward is permanently absent from the brain — a 6,000-word article becomes a 200-word summary
 * and the rest is gone. This keeps both layers: the summary stays the high-signal, human-readable
 * content of the thought, and the source becomes searchable at chunk granularity underneath it.
 *
 * The source deliberately gets NO document-level embedding of its own. A single vector over tens
 * of thousands of characters of raw text is the dilution problem chunking exists to fix — source
 * text is chunk-only.
 */

import { saveThoughtChunks, type ChunkOrigin } from './thought-chunks.ts'

/**
 * Ceiling on stored source text. Not a storage limit — the binding cost is chunk rows, each
 * embedded individually. Past this a single capture would start to dominate a student's kit and
 * the embedding pass would threaten the edge function's wall clock. char_count on the row always
 * records the ORIGINAL length and truncated is set, so an over-length document is visibly
 * partial rather than silently clipped.
 */
export const MAX_SOURCE_TEXT_CHARS = 200_000

export type SourceKind = 'web' | 'youtube_transcript' | 'youtube_description'

export interface SaveSourceResult {
  stored: boolean
  chunks: number
  truncated: boolean
  chars: number
}

const EMPTY: SaveSourceResult = { stored: false, chunks: 0, truncated: false, chars: 0 }

/**
 * Upsert the source text for a thought and (re)build its source chunks. Throws on failure.
 *
 * Content at or below the chunker's minimum is still STORED — it just produces no chunks,
 * because the summary's own vector already covers text that short. Storing it regardless keeps
 * the promise that a capture retains its source.
 */
export async function saveThoughtSource(
  supabase: any,
  thoughtId: string,
  sourceText: string,
  sourceKind: SourceKind,
  userId?: string,
): Promise<SaveSourceResult> {
  if (!thoughtId || typeof sourceText !== 'string' || !sourceText.trim()) return EMPTY

  const originalChars = sourceText.length
  const truncated = originalChars > MAX_SOURCE_TEXT_CHARS
  const stored = truncated ? sourceText.substring(0, MAX_SOURCE_TEXT_CHARS) : sourceText

  const { error } = await supabase.from('thought_sources').upsert({
    thought_id: thoughtId,
    source_text: stored,
    source_kind: sourceKind,
    char_count: originalChars,
    truncated,
  }, { onConflict: 'thought_id' })
  if (error) throw new Error(`source store failed: ${error.message}`)

  const chunks = await saveThoughtChunks(supabase, thoughtId, stored, 'source' as ChunkOrigin, userId)

  return { stored: true, chunks, truncated, chars: stored.length }
}

/**
 * Same, but never throws. Callers run this after the thought is already committed: losing the
 * source costs retrieval depth, whereas throwing would fail a capture that otherwise succeeded.
 */
export async function saveThoughtSourceSafe(
  supabase: any,
  thoughtId: string,
  sourceText: string,
  sourceKind: SourceKind,
  label: string,
  userId?: string,
): Promise<SaveSourceResult> {
  try {
    return await saveThoughtSource(supabase, thoughtId, sourceText, sourceKind, userId)
  } catch (err) {
    console.error(`[${label}] source capture failed (non-fatal):`, String(err))
    return EMPTY
  }
}
