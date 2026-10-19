# Linkmein

Linkmein is an open-source, self-hosted tool for writing and scheduling LinkedIn posts. You give it photos, voice notes or videos, and Claude writes the post in your voice. It uses your own Anthropic API key.

- **Media in, posts out.** Upload photos and videos, record a voice note in the browser, add a few words, and get 1–4 drafts. Claude looks at the photos and frames sampled from each video. Speech in voice notes and videos is transcribed on your own server.
- **It knows you.** Fill in "About you" once: your role, audience, goals, stories, tone, and what you never want to say. Paste a few of your old posts and Claude matches their style. It can also turn them into a voice guide you can edit.
- **Remix posts you admire.** Paste another person's post or upload a screenshot of it. Claude works out why it works (the hook, structure, pacing and formatting). Then it writes an original post about *your* work using the same techniques. Each draft shows how much wording it shares with the original, and drafts that copy too much are rewritten.
- **Edit and refine.** A preview shows the post as it will appear in the feed, including the "…see more" cut-off. One-click rewrites include "shorter", "stronger hook" and "more personal", or you can type your own instruction. Changes can be undone.
- **Schedule.** Post now, save a draft, or schedule a time. A built-in scheduler publishes text, up to 20 images, or a single video through LinkedIn's official API. It retries if LinkedIn is down and never posts the same thing twice.
- **Private by design.** Each user brings their own Claude API key. Keys and LinkedIn tokens are encrypted at rest. Uploads stay on your server, and Claude only sees what you choose to write about.

## How it works

```
Browser (React)
   │  photos · video · voice notes · notes
   ▼
Linkmein server (Node, Express, SQLite)
   ├── sharp: resizes photos for Claude's vision input
   ├── ffmpeg: samples video frames and extracts audio
   ├── Whisper (transformers.js): local speech-to-text
   ├── Claude API, using your key: drafts, remixes, refinements, voice analysis
   └── Scheduler → LinkedIn Posts / Images / Videos API
```

## Quick start

You need **Node 20.11+** and **ffmpeg**, or Docker.

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

Or with Docker:

```bash
cp .env.example .env        # set BASE_URL to your public https URL
docker compose up -d --build
```

Run it behind HTTPS (Caddy, nginx, Cloudflare Tunnel and so on). Everything is stored in `DATA_DIR`: the SQLite database, uploads, the Whisper model, and the generated `app-secret.key`. Back that directory up.

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

Linkmein checks the key before saving it, encrypts it with `APP_SECRET`, and never sends it back to the browser. You choose the model:

| Model | Good for |
| --- | --- |
| `claude-opus-5-5` (default) | The best writing and the closest match to your voice |
| `claude-sonnet-5-5` | Nearly as good, and costs less |
| `claude-haiku-5-5` | Fastest and cheapest, fine for quick edits |

A typical generation (three drafts from a few photos and a voice note) is a single API call. Most of the cost is image input. The system prompt with your profile is prompt-cached, so repeat requests are cheaper.

## Voice notes and video audio

Speech is transcribed locally with [Whisper](https://github.com/openai/whisper) through [transformers.js](https://huggingface.co/docs/transformers.js), so recordings never go to a third party. The model (`WHISPER_MODEL`, default `onnx-community/whisper-base`, about 150 MB) downloads into `DATA_DIR/models` the first time it's used. You can correct any transcript in the **Library**. If the optional `@huggingface/transformers` package fails to install on your platform, everything else still works and you can type transcripts yourself.

## Configuration

See [`.env.example`](.env.example) for every option. The important ones:

| Variable | Default | |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | Public URL. Used for the OAuth redirect and secure cookies |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | | From your LinkedIn app |
| `APP_SECRET` | generated | Encrypts keys and tokens at rest |
| `DATA_DIR` | `./data` | Database, uploads and models |
| `LINKEDIN_DRY_RUN` | `false` | Log posts instead of publishing them |
| `ALLOW_DEV_LOGIN` | `false` | Skip LinkedIn sign-in locally. Never enable this in production |
| `DEFAULT_MODEL` | `claude-opus-5-5` | Model for new users |
| `WHISPER_MODEL` | `onnx-community/whisper-base` | Speech-to-text model |
| `MAX_UPLOAD_MB` | `500` | Per-file upload limit |

## Development

```bash
npm run dev         # API with auto-reload + Vite dev server
npm test            # Vitest: LinkedIn formatting, scheduler, API, AI prompt assembly
npm run typecheck
```

Project layout:

```
server/
  app.ts            REST API (Express 5)
  auth.ts           LinkedIn OAuth, sessions, CSRF
  linkedin.ts       LinkedIn API client (posts, images, videos, little-text escaping)
  posts.ts          post storage, validation, publishing
  scheduler.ts      publishes due posts, with retries
  ai/               Claude client, prompts, generation, remix originality check
  media/            uploads, sharp/ffmpeg processing, Whisper transcription
web/src/            React app (Vite + Tailwind)
shared/types.ts     types shared by server and web
tests/
```

Contributions are welcome. Please open an issue to discuss larger changes first.

## Responsible use

Linkmein writes drafts; you decide what gets published. Remix is meant for learning techniques, not copying people. It tells Claude never to reuse sentences or present someone else's experiences as yours, and it shows an overlap score so you can check. Follow LinkedIn's [User Agreement](https://www.linkedin.com/legal/user-agreement) and [API terms](https://www.linkedin.com/legal/l/api-terms-of-use).

## License

[MIT](LICENSE)
