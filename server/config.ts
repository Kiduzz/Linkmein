import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function defaultLinkedInVersion(now = new Date()): string {
  // LinkedIn's versioned REST APIs take a YYYYMM header and retire versions after
  // roughly a year. Two months back is almost always a live version.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const dataDir = path.resolve(env("DATA_DIR", "./data"));
fs.mkdirSync(dataDir, { recursive: true });

/**
 * The secret used to encrypt API keys and LinkedIn tokens at rest. If APP_SECRET
 * isn't set we generate one once and keep it next to the database, so a
 * self-hosted install works out of the box and survives restarts.
 */
function loadAppSecret(): string {
  const fromEnv = env("APP_SECRET");
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, "app-secret.key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const port = Number(env("PORT", "3000"));
const baseUrl = env("BASE_URL", `http://localhost:${port}`).replace(/\/$/, "");

export const config = {
  port,
  baseUrl,
  isProduction: env("NODE_ENV") === "production",
  dataDir,
  uploadDir: path.join(dataDir, "uploads"),
  dbPath: path.join(dataDir, "linkmein.db"),
  appSecret: loadAppSecret(),
  /** Where the browser should land after login. In dev the Vite server runs on another port. */
  webUrl: env("WEB_URL", baseUrl).replace(/\/$/, ""),
  allowDevLogin: env("ALLOW_DEV_LOGIN") === "true",
  linkedin: {
    clientId: env("LINKEDIN_CLIENT_ID"),
    clientSecret: env("LINKEDIN_CLIENT_SECRET"),
    redirectUri: env("LINKEDIN_REDIRECT_URI", `${baseUrl}/auth/linkedin/callback`),
    apiVersion: env("LINKEDIN_API_VERSION", defaultLinkedInVersion()),
    /** When true, publishing is simulated: nothing is sent to LinkedIn. */
    dryRun: env("LINKEDIN_DRY_RUN") === "true",
  },
  ai: {
    defaultModel: env("DEFAULT_MODEL", "claude-opus-5-5"),
  },
  whisperModel: env("WHISPER_MODEL", "onnx-community/whisper-base"),
  ffmpegPath: env("FFMPEG_PATH", "ffmpeg"),
  ffprobePath: env("FFPROBE_PATH", "ffprobe"),
  maxUploadMb: Number(env("MAX_UPLOAD_MB", "500")),
  schedulerIntervalMs: Number(env("SCHEDULER_INTERVAL_MS", "30000")),
};

fs.mkdirSync(config.uploadDir, { recursive: true });

export const linkedinConfigured = () => Boolean(config.linkedin.clientId && config.linkedin.clientSecret);

export { defaultLinkedInVersion };
