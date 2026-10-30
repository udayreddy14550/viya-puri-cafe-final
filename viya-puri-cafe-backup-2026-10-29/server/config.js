"use strict";
/* Reads configuration from environment variables (optionally from a .env file). No secrets live in the repo. */
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");

/* Friendly message instead of a cryptic crash on old Node versions (node:sqlite needs 22.13+). */
{
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`\nThis app needs Node.js 22.13 or newer, but you are running ${process.versions.node}.\nInstall the current LTS from https://nodejs.org , reopen VS Code, and try again.\n`);
    process.exit(1);
  }
}

const ROOT = path.join(__dirname, "..");

function loadEnvFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^["']/.test(v)) { const q = v[0], end = v.indexOf(q, 1); v = end > 0 ? v.slice(1, end) : v.slice(1); }   // quoted value
    else v = v.replace(/\s+#.*$/, "").trim();                                                                // drop trailing "# comment"
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;   // real environment wins over .env
  }
}
loadEnvFile(process.env.ENV_FILE || path.join(ROOT, ".env"));

const env = process.env;
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max ?? n, Math.max(min ?? n, n)) : d; };
const abs = p => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const isProd = env.NODE_ENV === "production";
let sessionSecret = env.SESSION_SECRET || "";
if (isProd && (sessionSecret.length < 32 || /change-me|placeholder/i.test(sessionSecret))) {
  console.error("FATAL: SESSION_SECRET must be set to a random string of at least 32 characters in production.\n       Generate one with:  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"");
  process.exit(1);
}
let ephemeralSecret = false;
if (!sessionSecret) {
  // Development convenience: remember a generated secret next to the database so restarts (e.g. `npm run dev`) don't sign you out.
  const f = path.join(path.dirname(abs(env.DATABASE_PATH || "data/viya.db")), ".session-secret");
  try { sessionSecret = fs.readFileSync(f, "utf8").trim(); } catch {}
  if (sessionSecret.length < 32) {
    sessionSecret = crypto.randomBytes(48).toString("base64url");
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, sessionSecret, { mode: 0o600 }); } catch { ephemeralSecret = true; }
  }
}

module.exports = {
  ROOT,
  isProd,
  port: int(env.PORT, 3000, 1, 65535),
  host: env.HOST || "127.0.0.1",
  dbPath: abs(env.DATABASE_PATH || "data/viya.db"),
  uploadDir: abs(env.UPLOAD_DIR || "uploads"),
  maxUploadBytes: int(env.MAX_UPLOAD_MB, 3, 1, 20) * 1024 * 1024,
  sessionSecret, ephemeralSecret,
  sessionTtlMs: int(env.SESSION_HOURS, 12, 1, 168) * 3600e3,       // absolute lifetime
  sessionIdleMs: int(env.SESSION_IDLE_MINUTES, 120, 5, 1440) * 60e3, // inactivity timeout
  cookieSecure: bool(env.COOKIE_SECURE, isProd),                    // Secure flag (always on in production)
  trustProxy: bool(env.TRUST_PROXY, false),                         // true only when behind your own reverse proxy
  publicOrigin: (env.PUBLIC_ORIGIN || "").replace(/\/+$/, ""),      // e.g. https://viyapuricafe.in (used for Origin checks)
  forceHttps: bool(env.FORCE_HTTPS, isProd),                        // redirect http -> https (needs TRUST_PROXY behind a proxy)
  loginMaxFailures: int(env.LOGIN_MAX_FAILURES, 5, 3, 50),
  loginLockMinutes: int(env.LOGIN_LOCK_MINUTES, 15, 1, 1440),
};
