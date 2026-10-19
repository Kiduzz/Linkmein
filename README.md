# Linkmein

Linkmein is an open-source tool for writing and scheduling LinkedIn posts. You give it photos, voice notes or videos, and Claude writes the post in your voice. It uses your own Anthropic API key. Deploy it free on Vercel, or host it yourself.

- **Media in, posts out.** Upload photos and videos, record a voice note in the browser, add a few words, and get 1–4 drafts. Claude looks at the photos and frames sampled from each video. Speech in voice notes and videos is transcribed in your browser, on your own device.
- **It knows you.** Fill in "About you" once: your role, audience, goals, stories, tone, and what you never want to say. Paste a few of your old posts and Claude matches their style. It can also turn them into a voice guide you can edit.
- **Remix posts you admire.** Paste another person's post or upload a screenshot of it. Claude works out why it works (the hook, structure, pacing and formatting). Then it writes an original post about *your* work using the same techniques. Each draft shows how much wording it shares with the original, and drafts that copy too much are rewritten.
- **Edit and refine.** A preview shows the post as it will appear in the feed, including the "…see more" cut-off. One-click rewrites include "shorter", "stronger hook" and "more personal", or you can type your own instruction. Changes can be undone.
- **Schedule.** Post now, save a draft, or schedule a time. A built-in scheduler publishes text, up to 20 images, or a single video through LinkedIn's official API. It retries if LinkedIn is down and never posts the same thing twice.
- **Your data stays on your phone.** Your profile, Claude key, media library, saved posts and drafts live in your browser's own storage, not on a server. Claude is called straight from your device with your key. The server only holds your LinkedIn connection (encrypted) and posts waiting to go out, and it deletes each post's files once it's published. Download a backup any time from Settings.

## How it works

```
Your phone (React app, installable to the home screen)
   ├── on-device database (IndexedDB): profile, Claude key, media, posts, drafts
   ├── resizes photos and samples video frames (canvas)
   ├── transcribes speech locally (Whisper via transformers.js)
   └── calls the Claude API directly with your key: drafts, remixes, refinements
   │
   │  when you schedule a post: its text + files
   ▼
Linkmein server (Node, Express) + private storage (local disk or Vercel Blob)
   ├── LinkedIn sign-in; the encrypted LinkedIn connection
   └── publish queue → LinkedIn Posts / Images / Videos API
         (a built-in timer when self-hosted, a cron-called endpoint on Vercel)
```

## Quick start

You need **Node 20.11+**, or Docker.

```bash
git clone https://github.com/kiduzz/linkmein.git
cd linkmein
cp .env.example .env        # then fill in the LinkedIn values (next section)
npm install
npm run dev                 # server on :3000, web app on :5173
```

Open http://localhost:5173.

For a first look without a LinkedIn app, set these in `.env`:

```
ALLOW_DEV_LOGIN=true
LINKEDIN_DRY_RUN=true
BASE_URL=http://localhost:5173
```

This adds a "Continue as local dev user" button, and posts are logged to the console instead of published.

### Production

```bash
npm run build
npm start                   # serves the app and API on $PORT
```

Or with Docker, including automatic HTTPS through Caddy:

```bash
cp .env.example .env        # set DOMAIN and BASE_URL=https://<DOMAIN>
docker compose --profile https up -d --build
```

Self-hosted, the server keeps its few files in `DATA_DIR`: LinkedIn connections, the publish queue, and the generated `app-secret.key`. Everything else is on each user's device.

### Free hosting

Two free options, each with a step-by-step guide:

- **[Vercel](docs/deploy-vercel.md)** (recommended). Free Vercel Hobby plan plus a free cron-job.org account to publish on time. No server and no database to look after. The catches: 200 MB per attached file, and Hobby is for personal, non-commercial use.
- **[Oracle Cloud Always Free](docs/deploy-oracle.md)**. A free always-on server running the Docker setup above. More room, more setup.

## Create a LinkedIn app

LinkedIn needs every installation to have its own developer app. This takes about five minutes.

1. Go to https://www.linkedin.com/developers/apps and click **Create app**. LinkedIn asks you to link a Company Page; any page you admin will do.
2. Open the **Products** tab and add:
   - **Sign In with LinkedIn using OpenID Connect** (scopes `openid profile email`)
   - **Share on LinkedIn** (scope `w_member_social`)
3. Open the **Auth** tab:
   - Copy the **Client ID** and **Client Secret** into `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
   - Under **Authorized redirect URLs**, add `<BASE_URL>/auth/linkedin/callback`, for example `https://linkmein.example.com/auth/linkedin/callback`, or `http://localhost:5173/auth/linkedin/callback` in development.
4. Restart Linkmein and sign in with LinkedIn.

Notes:

- LinkedIn access tokens last **60 days**. Linkmein warns you a week before yours expires. Reconnecting takes one click in Settings. Apps that LinkedIn has approved for refresh tokens are refreshed automatically.
- Posts are published as **you** (your member profile). Company Page posting needs LinkedIn's Community Management API, which has its own review process, and isn't supported yet.
- LinkedIn versions its REST API by month (`LinkedIn-Version: YYYYMM`) and retires old versions after about a year. Linkmein uses the version from two months ago. Set `LINKEDIN_API_VERSION` to pin a specific one.

## Your Claude API key

Each user adds their own key under **Settings**. Create one in the [Claude Console](https://platform.claude.com/settings/keys). A Claude.ai Pro or Max chat subscription doesn't include API access, so you need an API key with credit on it.

Linkmein checks the key, then keeps it only on your device and sends it straight to Anthropic. The Linkmein server never sees it. You choose the model:

| Model | Good for |
| --- | --- |
| `claude-opus-5-5` (default) | The best writing and the closest match to your voice |
| `claude-sonnet-5-5` | Nearly as good, and costs less |
| `claude-haiku-5-5` | Fastest and cheapest, fine for quick edits |

A typical generation (three drafts from a few photos and a voice note) is a single API call. Most of the cost is image input. The system prompt with your profile is prompt-cached, so repeat requests are cheaper.

## Your data, on your phone

Linkmein keeps your profile, Claude key, media library, saved posts, drafts and history in your browser's own storage (IndexedDB) on the device you use it on. A few things follow from that:

- **Add it to your home screen.** On iPhone, open it in Safari and choose *Share → Add to Home Screen*; on Android, *Install app* in Chrome's menu. Browsers keep an installed app's data much more reliably than a website's.
- **Back it up.** *Settings → Download backup* saves everything except your Claude key to one file. *Restore from backup* loads it on a new phone, or after you clear your browser.
- **Each device has its own data.** It doesn't sync between your phone and laptop; use a backup file to move it.
- **Scheduled posts still go out with your phone off.** When you schedule a post, its text and files are handed to the server's publish queue. The phone picks up the result the next time you open the app, and the server then deletes it.

## Voice notes and video audio

Speech is transcribed in your browser with [Whisper](https://github.com/openai/whisper) (`onnx-community/whisper-base`) through [transformers.js](https://huggingface.co/docs/transformers.js), so no transcription service sees your recordings and you don't need another API key. The model downloads into the browser the first time and is cached after that. Keep the tab open until a transcription finishes; if it's interrupted, resume it from the **Library**. You can also correct or type any transcript there.

## Configuration

See [`.env.example`](.env.example) for every option. The important ones:

| Variable | Default | |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000`, or your Vercel production URL | Public URL. Used for the OAuth redirect and secure cookies |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | | From your LinkedIn app |
| `APP_SECRET` | generated (required on Vercel) | Encrypts LinkedIn tokens and signs sessions |
| `DATA_DIR` | `./data` | Self-hosted storage for LinkedIn connections and the publish queue |
| `BLOB_READ_WRITE_TOKEN` | local disk | Use Vercel Blob for that storage instead (required on Vercel) |
| `CRON_SECRET` | | Protects `/api/cron/publish`, the endpoint a cron service calls |
| `LINKEDIN_DRY_RUN` | `false` | Log posts instead of publishing them |
| `ALLOW_DEV_LOGIN` | `false` | Skip LinkedIn sign-in locally. Never enable this in production |
| `MAX_UPLOAD_MB` | `500` (`200` on Vercel) | Per-file limit for media attached to posts |

## Development

```bash
npm run dev         # API with auto-reload + Vite dev server
npm test            # Vitest: LinkedIn formatting, publish queue, storage, API, AI prompt assembly
npm run typecheck
```

Project layout:

```
server/
  app.ts            REST API (Express 5)
  index.ts          self-hosted entry: HTTP server + scheduler timer
  vercel.ts         Vercel entry (api/index.js loads the compiled build)
  auth.ts           LinkedIn OAuth, signed-cookie sessions, CSRF
  accounts.ts       encrypted LinkedIn connections
  queue.ts          the publish queue: claim, publish, retry, clean up
  storage.ts        local disk or private Vercel Blob, with compare-and-swap JSON records
  linkedin.ts       LinkedIn API client (posts, images, videos, little-text escaping)
web/src/            React app (Vite + Tailwind)
  api.ts            the app's data layer: on-device data + the publish queue
  local/            on-device database (IndexedDB), backups, uploads to the queue
  ai/               Claude client (browser) and post generation
  media/            in-browser photo/video processing, Whisper transcription
shared/             types, prompts and the remix originality check
tests/
```

Contributions are welcome. Please open an issue to discuss larger changes first.

## Responsible use

Linkmein writes drafts; you decide what gets published. Remix is meant for learning techniques, not copying people. It tells Claude never to reuse sentences or present someone else's experiences as yours, and it shows an overlap score so you can check. Follow LinkedIn's [User Agreement](https://www.linkedin.com/legal/user-agreement) and [API terms](https://www.linkedin.com/legal/l/api-terms-of-use).

## License

[MIT](LICENSE)
