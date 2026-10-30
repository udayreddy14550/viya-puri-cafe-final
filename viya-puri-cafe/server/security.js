"use strict";
const crypto = require("node:crypto");
const cfg = require("./config");
const { db, now } = require("./db");
const { HttpError, parseCookies, expectedOrigin } = require("./http");

/* ---------------- password hashing: scrypt (memory-hard, built into Node) ---------------- */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
const scrypt = (pw, salt, o) => new Promise((res, rej) => crypto.scrypt(pw.normalize("NFKC"), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: o.maxmem }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}
async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || "").split("$");
  if (alg !== "scrypt" || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), { N: +N, r: +r, p: +p, keylen: want.length, maxmem: SCRYPT.maxmem });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
let dummyHash = null;   // verified against when the email is unknown, so timing does not reveal which emails exist
const getDummyHash = async () => (dummyHash ||= await hashPassword(crypto.randomBytes(12).toString("hex")));

const COMMON = new Set(["password1234", "123456789012", "qwertyuiop12", "admin1234567", "letmein12345", "welcome12345", "viyapuricafe", "viyapuricafe1"]);
function passwordProblem(pw, email = "") {
  if (typeof pw !== "string" || pw.length < 12) return "Use at least 12 characters.";
  if (pw.length > 200) return "That password is too long (200 characters maximum).";
  if (/^(.)\1+$/.test(pw)) return "Use more than one repeated character.";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (classes < 3) return "Mix at least three of: lowercase, uppercase, numbers and symbols.";
  if (COMMON.has(pw.toLowerCase()) || (email && pw.toLowerCase().includes(String(email).split("@")[0].toLowerCase()) && String(email).split("@")[0].length > 3)) return "That password is too easy to guess.";
  return null;
}

/* ---------------- sessions ---------------- */
const COOKIE = "vpc_admin";
const idHash = token => crypto.createHmac("sha256", cfg.sessionSecret).update(token).digest("hex");

function createSession(adminId, ip, ua) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(32).toString("base64url");
  const t = now(), exp = new Date(Date.now() + cfg.sessionTtlMs).toISOString();
  db.prepare("INSERT INTO sessions(id_hash, admin_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES(?,?,?,?,?,?,?,?)")
    .run(idHash(token), adminId, csrf, t, t, exp, String(ip || "").slice(0, 64), String(ua || "").slice(0, 200));
  return { token, csrf, maxAgeSec: Math.floor(cfg.sessionTtlMs / 1000) };
}
/** Returns {admin, csrf, hash} for a valid session cookie, otherwise null. Server-side only; nothing the browser says is trusted. */
function getSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const hash = idHash(token);
  const s = db.prepare(`SELECT s.*, a.email, a.active, a.role FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id_hash = ?`).get(hash);
  if (!s) return null;
  const t = Date.now();
  if (!s.active || Date.parse(s.expires_at) < t || Date.parse(s.last_seen_at) + cfg.sessionIdleMs < t) { destroySession(hash); return null; }
  if (t - Date.parse(s.last_seen_at) > 60e3) db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now(), hash);
  return { admin: { id: s.admin_id, email: s.email, role: s.role }, csrf: s.csrf_token, hash };
}
const destroySession = hash => db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hash);
const destroyOtherSessions = (adminId, keepHash) => db.prepare("DELETE FROM sessions WHERE admin_id = ? AND id_hash != ?").run(adminId, keepHash || "");
const purgeExpiredSessions = () => {
  const t = now();
  db.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?").run(t, new Date(Date.now() - cfg.sessionIdleMs).toISOString());
};

/* ---------------- CSRF + origin checks (state-changing admin requests) ---------------- */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function checkSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) { if (origin !== expectedOrigin(req)) throw new HttpError(403, "Blocked: this request came from a different site."); return; }
  const site = req.headers["sec-fetch-site"];
  if (site && !["same-origin", "none"].includes(site)) throw new HttpError(403, "Blocked: this request came from a different site.");
}
function checkCsrf(req, session) {
  checkSameOrigin(req);
  if (!safeEqual(req.headers["x-csrf-token"], session.csrf)) throw new HttpError(403, "Your session token is missing or out of date. Reload the page and try again.", { code: "CSRF" });
}

/* ---------------- rate limiting (fixed window, in memory) ---------------- */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n > limit) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.", { retryAfter: Math.ceil((b.reset - t) / 1000) });
}
const sweep = setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k); purgeExpiredSessions(); }, 5 * 60e3);
sweep.unref();
const resetRateLimits = () => buckets.clear();

module.exports = { hashPassword, verifyPassword, getDummyHash, passwordProblem, COOKIE, createSession, getSession, destroySession, destroyOtherSessions, checkCsrf, checkSameOrigin, rateLimit, resetRateLimits, safeEqual };
