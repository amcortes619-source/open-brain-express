// ============================================================================
// YOUR SUPABASE DETAILS
// ============================================================================
// Claude Code fills these in for you during setup. If you ever need to do it
// by hand, both values are in your Supabase dashboard under
// Project Settings -> API Keys (look for "Project URL" and the public /
// publishable key).
//
// IS IT SAFE THAT THIS IS PUBLIC?
// Yes — but only because of how the database is configured. This key alone
// cannot read anything. The database refuses to hand out rows unless the
// request comes from someone logged in, and it only ever returns that
// person's own rows. That protection is set up in migration.sql.
//
// The key that IS dangerous is the service role key. It bypasses all of that.
// It belongs only in Supabase's secret storage, never in this file, never in
// your repository, never in a chat window.
// ============================================================================

const SUPABASE_URL = 'https://nwdrlmcnsyxrkebalbeu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ypWDaFLHW649RsbeeZyGMA_kCwIoBBk';
