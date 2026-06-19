# task-dag secrets — operator runbook

The task-dag automation needs **two** GitHub Actions secrets, and only for
the single cross-repo writer job (`completion-aggregate`). This is the one
manual, per-repo step that cannot be expressed as code, because GitHub stores
Actions secrets per repository and `virusdave` is a **user account**, not an
org (so there is no org-wide secret to inherit — confirmed: the
`/orgs/virusdave/actions/secrets` API returns 404).

| Secret | What it is |
|---|---|
| `TASK_DAG_APP_ID` | Numeric App ID of the one shared **task-dag cross-repo GitHub App**. |
| `TASK_DAG_APP_PRIVATE_KEY` | PEM private key generated for that same App. |

## Why these exist (and only here)

Three of the four caller jobs — `issue-to-task`, `comment-sync`,
`close-completed` — read/write **only the caller repo's own** issues, so the
built-in `secrets.GITHUB_TOKEN` (scoped to the running repo, carries
`issues: write`) is sufficient. No App secret is involved.

`completion-aggregate` is the **only** job that writes **cross-repo**: it posts
`Satisfies: …` completion comments onto `virusdave/top-level`. The automatic
`GITHUB_TOKEN` cannot write to a different repo, so the job mints a *top-level*
installation token via the App
(`actions/create-github-app-token@v1` ← `app_id` / `app_private_key`). The App
is installed on `virusdave/top-level` with **Issues: Read & write**; the mint
step requests a token scoped to `owner=virusdave`, `repositories=top-level`.

Therefore every repo whose commits can carry `Satisfies: virusdave/top-level#N`
trailers needs its own copy of these two secrets. The values are **identical**
across all repos — it is the same one App.

## One-time provisioning for a new peer (e.g. `virusdave/task-dag`)

These are the same values already set on the four existing peers
(`FreshlyBakedNYC/automation`, `Nicponskis/mostly-static-sites`,
`Nicponskis/nixos-sbc`, `virusdave/top-level`; all provisioned 2026-05-18).
You are **copying**, not creating, an App.

1. **Get the App ID** (same App as the other peers). On any repo that already
   has it, the value is the body of `TASK_DAG_APP_ID`. Authoritative source:
   the App's settings page, `https://github.com/settings/apps` →
   *task-dag cross-repo bot* → **App ID**.

2. **Get the private key.** Use the PEM you generated when the App was created
   (the same `.pem` you loaded onto the other four repos). If it is lost,
   generate a fresh one from the App settings page
   (*Private keys* → **Generate a private key**) — a new key is additive and
   does not invalidate the App; just re-load it on **all** peers so they stay
   identical, or rotate per the note below.

3. **Set both secrets on the new repo** (example for `virusdave/task-dag`):

   ```sh
   gh secret set TASK_DAG_APP_ID \
     --repo virusdave/task-dag \
     --body '<APP_ID>'

   gh secret set TASK_DAG_APP_PRIVATE_KEY \
     --repo virusdave/task-dag \
     < /path/to/task-dag-app.private-key.pem
   ```

4. **Verify:**

   ```sh
   gh secret list --repo virusdave/task-dag
   # expect: TASK_DAG_APP_ID  and  TASK_DAG_APP_PRIVATE_KEY
   ```

5. **Confirm the App is installed where it writes.** The App only needs to be
   installed on the **destination** (`virusdave/top-level`, already done — the
   other peers write there successfully). It does **not** need installing on
   the new caller repo; the secrets are all that repo needs.

> **Ordering hazard:** provision these secrets **before** the caller's
> `completion-aggregate` job lands on `master`. With the job present but the
> secrets absent, the App-token mint step fails and every `master` push shows a
> failed job. (The other three jobs are unaffected.)

## Rotation

To rotate the key: generate a new private key in the App settings, then
re-run step 3's `gh secret set TASK_DAG_APP_PRIVATE_KEY` on **all five** repos
(`virusdave/task-dag`, `virusdave/top-level`,
`FreshlyBakedNYC/automation`, `Nicponskis/mostly-static-sites`,
`Nicponskis/nixos-sbc`), then delete the old key from the App. Keeping all
repos on the same key is what keeps the fleet uniform.
