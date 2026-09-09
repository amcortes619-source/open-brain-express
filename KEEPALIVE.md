# Keeping the brain awake

Supabase pauses a free project after about **7 days of low activity**. Once paused,
the data is still there and you have a long window to restore it by hand, but the
brain is dead until you do. A few database requests a day is all it takes to
prevent it.

`.github/workflows/keepalive.yml` does that automatically, every morning, on
GitHub's servers. Your laptop does not need to be on.

## What it actually does

**Every day at 08:17 Bogota** it runs a real query against the `thoughts` table.
Row Level Security means the anon key gets an empty list back, so no data leaves
the project, but the query still reaches Postgres and that is what Supabase
counts as activity.

**If the query fails**, the workflow fails, and GitHub emails you. That is the
early warning: either the project paused anyway, or the anon key was rotated and
the repo secret is stale.

**Every 20 days or so** it pushes a one-line heartbeat file back to the repo.
This is not decoration. GitHub switches off scheduled workflows in any repository
that has seen no activity for 60 days, so without this the keepalive would
quietly turn itself off after two months and you would be right back here.

**Nothing here uses a personal access token.** The workflow runs on the
`GITHUB_TOKEN` that GitHub mints fresh for every single run and throws away
afterwards. It cannot expire.

## Setting it up (once, about three minutes)

1. Open <https://github.com/amcortes619-source/open-brain-express/settings/secrets/actions>

2. Add two repository secrets. Both values are in your local `.env.local` file,
   which is gitignored and stays on your machine:

   | Secret name         | Value                              |
   |---------------------|------------------------------------|
   | `SUPABASE_URL`      | the `SUPABASE_URL` line            |
   | `SUPABASE_ANON_KEY` | the `SUPABASE_ANON_KEY` line       |

   Use the **anon** key, not the service role key. The anon key is already public
   in `config.js`, so there is nothing to lose if it leaks. The service role key
   would be a real problem.

3. Commit and push:

   ```
   cd ~/Documents/open-brain-express
   git add .github/workflows/keepalive.yml KEEPALIVE.md
   git commit -m "Add Supabase keepalive workflow"
   git push
   ```

4. Go to the **Actions** tab, pick "Keep the brain awake", and hit
   **Run workflow** to prove it works right now instead of waiting until
   tomorrow morning. You want a green check and `HTTP 200` in the log.

## The personal access token

The keepalive does not need one. But your own `git push` does, and a fine-grained
token expires after at most a year, silently, usually at the worst moment.

Two ways to stop being surprised by it:

**Get warned before it dies.** Add your token as a repo secret named `GH_PAT`.
The workflow's second job then checks it daily and fails loudly — so you get an
email — starting 14 days before it expires. When you regenerate the token,
update the `GH_PAT` secret and the local `.env.local` line, and the warning
clears itself.

**Or stop needing it.** Switch the remote to SSH and pushes stop depending on a
token at all:

```
ssh-keygen -t ed25519 -C "amcortes619@gmail.com"      # press enter through the prompts
pbcopy < ~/.ssh/id_ed25519.pub                         # copies the public key
```

Paste it at <https://github.com/settings/ssh/new>, then:

```
cd ~/Documents/open-brain-express
git remote set-url origin git@github.com:amcortes619-source/open-brain-express.git
git push
```

SSH keys do not expire. This is the version you never have to think about again.

## If it ever does go dark

Open <https://supabase.com/dashboard/project/nwdrlmcnsyxrkebalbeu>, click
**Restore project**, wait a few minutes, then re-run the keepalive workflow from
the Actions tab to confirm it is answering again.
