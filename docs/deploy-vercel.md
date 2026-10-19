# Deploy Linkmein to Vercel for free

Linkmein runs on Vercel's free **Hobby** plan with no database to set up. Your profile, media, drafts and Claude key stay on your phone. The server only needs:

| What | Service | Free allowance |
| --- | --- | --- |
| The app and API | **Vercel** (Hobby) | Functions run up to 5 minutes |
| LinkedIn connection + posts waiting to go out | **Vercel Blob** (private) | 1 GB, and each post's files are deleted once it's published |
| Publishing at the minute you scheduled | **cron-job.org** | Calls Linkmein every minute |

The last row is needed because Vercel's free cron only runs **once a day**. A free external service pings Linkmein's publish link every minute instead. Vercel's daily cron stays on as a backup. Those checks read a small cached index, so they barely touch Blob's free monthly operations.

Setup takes about 15 minutes.

## Before you start

- Push the code to a GitHub repository you own, or fork it.
- Create a LinkedIn developer app (see "Create a LinkedIn app" in the [README](../README.md)). You'll add its redirect URL in step 4.
- Vercel's Hobby plan is for **personal, non-commercial** use. If you run Linkmein as a paid service for others, you need Vercel Pro.

## 1. Import the project into Vercel

1. Sign in at https://vercel.com with GitHub.
2. Click **Add New → Project** and import your Linkmein repository.
3. Leave the settings as they are. The repo's `vercel.json` sets the build. Click **Deploy**.

The first deploy builds but won't work until you finish the next steps. That's expected.

Your app's address is shown on the project page as its production domain, for example `https://linkmein-yourname.vercel.app`. The rest of this guide calls it `YOUR_APP`.

## 2. Add Blob storage

1. In your project, open the **Storage** tab and click **Create Database → Blob**.
2. Choose **Private** access.
3. Connect it to your project, for all environments.

This adds `BLOB_READ_WRITE_TOKEN` to your project's environment variables automatically.

## 3. Set environment variables

Open **Settings → Environment Variables** and add:

| Name | Value |
| --- | --- |
| `APP_SECRET` | A long random string. Run `openssl rand -hex 32`, or mash the keyboard for 40+ characters. It encrypts your LinkedIn connection; if it changes, you just sign in again. |
| `CRON_SECRET` | Another long random string. It protects the publish link. |
| `LINKEDIN_CLIENT_ID` | From your LinkedIn app |
| `LINKEDIN_CLIENT_SECRET` | From your LinkedIn app |

Optional:

- `BASE_URL`: only if you use a custom domain, for example `https://linkmein.yourdomain.com`. It defaults to your Vercel production address.
- `LINKEDIN_DRY_RUN=true`: log posts instead of publishing them, while you test.

Then open **Deployments**, find the latest one, and click **⋯ → Redeploy** so the new settings take effect.

## 4. Tell LinkedIn where to send you back

In your LinkedIn app, on the **Auth** tab, add this **Authorized redirect URL**:

```
https://YOUR_APP/auth/linkedin/callback
```

## 5. Publish on time with cron-job.org

1. Sign up for free at https://cron-job.org.
2. Click **Create cronjob** and fill in:
   - **URL:** `https://YOUR_APP/api/cron/publish?secret=YOUR_CRON_SECRET`
   - **Execution schedule:** every **1 minute**.
3. Save. In its history you should see successful runs that return `{"ok":true,...}`.

## 6. Open it on your phone

1. Open `https://YOUR_APP` on your phone and sign in with LinkedIn.
2. Add it to your home screen. On iPhone, use Safari's **Share → Add to Home Screen**; on Android, use **Install app** in Chrome's menu.
3. Add your Claude API key under **Settings**. It's stored only on your phone.

## Check it works

Create a post, schedule it 2–3 minutes ahead, close the app, and check LinkedIn after the time passes. When you reopen Linkmein, the post shows as **published**.

## Good to know

- **Your data is on your phone.** Use **Settings → Download backup** now and then. Clearing your browser's data for the site deletes everything on the device, and a backup also moves your data to a new phone.
- **Upload limit:** files attached to a post are limited to 200 MB on Vercel, so a video can be published within one 5-minute function run.
- **Transcription:** the first voice note downloads the speech model into your browser once; after that it's cached. Keep the app open until "Transcribing…" finishes. If you close it, open the **Library** and click **Resume**, or type the transcript yourself.
- **Videos:** Linkmein grabs a few frames from each video so Claude can see it. Browsers can't decode every format; iPhone HEVC `.mov` files often fail in Chrome. Those videos still post fine, and Claude uses the transcript and your notes instead.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The site shows "Couldn't reach the Linkmein server", and the function logs say `Linkmein on Vercel is missing: …` | Add the listed environment variables (steps 2–3), then redeploy. |
| LinkedIn says `redirect_uri does not match` | The redirect URL in your LinkedIn app must be exactly `https://YOUR_APP/auth/linkedin/callback`. If you use a custom domain, set `BASE_URL` to it and use that domain in LinkedIn. |
| cron-job.org shows `401` | The `secret=` in the URL must match `CRON_SECRET` exactly. |
| cron-job.org shows `503` | `CRON_SECRET` isn't set in Vercel, or you haven't redeployed since adding it. |
| A Vercel login page appears instead of Linkmein | Deployment Protection is covering your production address. In **Settings → Deployment Protection**, limit Vercel Authentication to preview deployments. |
| Scheduled posts only go out around 08:00 UTC | The cron-job.org job isn't running. Check step 5. |
| You changed environment variables and nothing happened | Redeploy. Vercel only applies new variables to new deployments. |
