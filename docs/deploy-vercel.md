# Deploy Linkmein to Vercel for free

Linkmein runs on Vercel's free **Hobby** plan using three free services:

| What | Service | Free allowance |
| --- | --- | --- |
| The app and API | **Vercel** (Hobby) | Functions run up to 5 minutes |
| Photos, videos, voice notes | **Vercel Blob** (private) | 1 GB of storage |
| Database | **Turso** (hosted SQLite) | Generous free tier |
| Publishing at the minute you schedule | **cron-job.org** | Calls Linkmein every minute |

The last row is needed because Vercel's free cron only runs **once a day**. A free external service pings Linkmein's publish link every minute instead. Vercel's daily cron stays on as a backup.

Speech transcription and photo and video processing happen **in your browser**, so the servers stay small and voice notes never leave your device until you upload them.

Setup takes about 20 minutes.

## Before you start

- Push the code to a GitHub repository you own, or fork it.
- Create a LinkedIn developer app (see "Create a LinkedIn app" in the [README](../README.md)). You'll add its redirect URL in step 5.
- Vercel's Hobby plan is for **personal, non-commercial** use. If you run Linkmein as a paid service for others, you need Vercel Pro.

## 1. Import the project into Vercel

1. Sign in at https://vercel.com with GitHub.
2. Click **Add New → Project** and import your Linkmein repository.
3. Leave the settings as they are. The repo's `vercel.json` sets the build. Click **Deploy**.

The first deploy builds but won't work until you finish the next steps. That's expected.

Your app's address is shown on the project page, for example `https://linkmein-yourname.vercel.app`. The rest of this guide calls it `YOUR_APP`.

## 2. Add Blob storage

1. In your project, open the **Storage** tab and click **Create Database → Blob**.
2. If asked for an access level, choose **Private**.
3. Connect it to your project, for all environments.

This adds `BLOB_READ_WRITE_TOKEN` to your project's environment variables automatically.

## 3. Add a Turso database

Pick one:

- **From Vercel:** **Storage → Create Database →** pick **Turso** from the Marketplace, follow the prompts, and connect it to the project. It adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
- **Directly:** sign up at https://turso.tech, create a database, then copy its **URL** (starts with `libsql://`) and create an **auth token**. Add both in step 4 as `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.

Linkmein creates its tables on first use.

## 4. Set environment variables

Open **Settings → Environment Variables** and add:

| Name | Value |
| --- | --- |
| `APP_SECRET` | A long random string. Run `openssl rand -hex 32`, or mash the keyboard for 40+ characters. **Never change it later:** it decrypts saved API keys and LinkedIn tokens. |
| `CRON_SECRET` | Another long random string. It protects the publish link. |
| `LINKEDIN_CLIENT_ID` | From your LinkedIn app |
| `LINKEDIN_CLIENT_SECRET` | From your LinkedIn app |

Optional:

- `BASE_URL`: only if you use a custom domain, for example `https://linkmein.yourdomain.com`. It defaults to your Vercel production address.
- `LINKEDIN_DRY_RUN=true`: log posts instead of publishing them, while you test.

Then open **Deployments**, find the latest one, and click **⋯ → Redeploy** so the new settings take effect.

## 5. Tell LinkedIn where to send you back

In your LinkedIn app, on the **Auth** tab, add this **Authorized redirect URL**:

```
https://YOUR_APP/auth/linkedin/callback
```

Open `https://YOUR_APP`, click **Sign in with LinkedIn**, and add your Claude API key under **Settings**.

## 6. Publish on time with cron-job.org

1. Sign up for free at https://cron-job.org.
2. Click **Create cronjob** and fill in:
   - **URL:** `https://YOUR_APP/api/cron/publish?secret=YOUR_CRON_SECRET`
   - **Execution schedule:** every **1 minute**.
3. Save. In its history you should see successful runs that return `{"ok":true,...}`.

Each run publishes whatever is due. If cron-job.org is ever down, Vercel's own daily cron (08:00 UTC) still publishes anything overdue.

## Check it works

Create a post, schedule it 2–3 minutes ahead, and watch it change to **published** on the Schedule page.

## Good to know

- **Storage:** the Library shows how much of the free 1 GB you've used. Videos take the most space. Delete ones you've already posted to free some up. If you go over, Vercel doesn't charge you; it blocks Blob access for up to 30 days instead, so keep an eye on it.
- **Upload limit:** files are limited to 200 MB on Vercel, so a video can be uploaded and published within one 5-minute function run.
- **Transcription:** the first voice note downloads the speech model into your browser once; after that it's cached. Keep the tab open until "Transcribing…" finishes. If you close it, open the **Library** and click **Resume**, or type the transcript yourself.
- **Videos:** Linkmein grabs a few frames from each video so Claude can see it. Browsers can't decode every format; iPhone HEVC `.mov` files often fail in Chrome. Those videos still upload and post fine, and Claude uses the transcript and your notes instead.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The site shows a server error and the function logs say `Linkmein on Vercel is missing: …` | Add the listed environment variables (steps 2–4), then redeploy. |
| LinkedIn says `redirect_uri does not match` | The redirect URL in your LinkedIn app must be exactly `https://YOUR_APP/auth/linkedin/callback`. If you use a custom domain, set `BASE_URL` to it and use that domain in LinkedIn. |
| cron-job.org shows `401` | The `secret=` in the URL must match `CRON_SECRET` exactly. |
| cron-job.org shows `503` | `CRON_SECRET` isn't set in Vercel, or you haven't redeployed since adding it. |
| Scheduled posts only go out around 08:00 UTC | The cron-job.org job isn't running. Check step 6. |
| You changed environment variables and nothing happened | Redeploy. Vercel only applies new variables to new deployments. |
