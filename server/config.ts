import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Load .env when present (real environment variables win).
if (fs.existsSync(".env")) process.loadEnvFile(".env");

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

/** True when running as a Vercel function: read-only filesystem, no long-running process. */
const onVercel = Boolean(process.env.VERCEL);
const dataDir = path.resolve(env("DATA_DIR", "./data"));

/**
 * The secret used to encrypt API keys and LinkedIn tokens at rest. Self-hosted, we
 * generate one once and keep it next to the database. On Vercel there's no disk to
 * keep it on, so it must be set.
 */
function loadAppSecret(): string {
  const fromEnv = env("APP_SECRET");
  if (fromEnv) return fromEnv;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "app-secret.key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

// Vercel has no persistent disk, so the database, file storage and secret must all be external.
if (onVercel) {
  const missing = [
    !env("APP_SECRET") && "APP_SECRET",
    !(env("DATABASE_URL") || env("TURSO_DATABASE_URL")) && "TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN)",
    !env("BLOB_READ_WRITE_TOKEN") && "BLOB_READ_WRITE_TOKEN (connect a Blob store)",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Linkmein on Vercel is missing: ${missing.join(", ")}. See docs/deploy-vercel.md.`);
}

const port = Number(env("PORT", "3000"));
const vercelUrl = env("VERCEL_PROJECT_PRODUCTION_URL") || env("VERCEL_URL");
const baseUrl = env("BASE_URL", vercelUrl ? `https://${vercelUrl}` : `http://localhost:${port}`).replace(/\/$/, "");

export const config = {
  port,
  baseUrl,
  onVercel,
  isProduction: env("NODE_ENV") === "production",
  dataDir,
  uploadDir: path.join(dataDir, "uploads"),
  database: {
    url: env("DATABASE_URL") || env("TURSO_DATABASE_URL") || `file:${path.join(dataDir, "linkmein.db")}`,
    authToken: env("DATABASE_AUTH_TOKEN") || env("TURSO_AUTH_TOKEN") || undefined,
  },
  /** Vercel Blob when its token is present, otherwise files on local disk. */
  storage: env("BLOB_READ_WRITE_TOKEN") ? ("blob" as const) : ("local" as const),
  appSecret: loadAppSecret(),
  /** Where the browser should land after login. In dev the Vite server runs on another port. */
  webUrl: env("WEB_URL", baseUrl).replace(/\/$/, ""),
  allowDevLogin: env("ALLOW_DEV_LOGIN") === "true",
  /** Protects the publish endpoint that an external cron service calls on serverless hosts. */
  cronSecret: env("CRON_SECRET"),
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
  /** Per-file limit. On Vercel, publishing a video must finish within one 5-minute function run. */
  maxUploadMb: Number(env("MAX_UPLOAD_MB", onVercel ? "200" : "500")),
  schedulerIntervalMs: Number(env("SCHEDULER_INTERVAL_MS", "30000")),
};

export const linkedinConfigured = () => Boolean(config.linkedin.clientId && config.linkedin.clientSecret);

export { defaultLinkedInVersion };
