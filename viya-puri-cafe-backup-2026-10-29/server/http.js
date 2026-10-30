"use strict";
const cfg = require("./config");

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (message, field) => new HttpError(400, message, field ? { field } : {});

/* ---------- responses ---------- */
function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
  res.writeHead(status, { "Content-Length": buf.length, ...headers });
  res.end(buf);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
}

/* ---------- request helpers ---------- */
function clientIp(req) {
  if (cfg.trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];   // last entry = the one appended by OUR proxy (not spoofable by the client)
  }
  return req.socket.remoteAddress || "unknown";
}
function isHttps(req) {
  return !!req.socket.encrypted || (cfg.trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
}
function expectedOrigin(req) {
  if (cfg.publicOrigin) return cfg.publicOrigin;
  const host = (cfg.trustProxy && req.headers["x-forwarded-host"]) || req.headers.host;
  return (isHttps(req) ? "https://" : "http://") + host;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers["content-length"] || "0", 10);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, "That request is too large.")); }
    const chunks = []; let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(new HttpError(413, "That request is too large.")); }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit = 100 * 1024) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (!ct.startsWith("application/json")) throw new HttpError(415, "Send the request as application/json.");
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString("utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch { throw bad("The request body is not valid JSON."); }
}

/* ---------- cookies ---------- */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, { maxAgeSec, expire } = {}) {
  const p = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (cfg.cookieSecure) p.push("Secure");
  if (expire) p.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  else if (maxAgeSec) p.push(`Max-Age=${maxAgeSec}`);
  return p.join("; ");
}

/* ---------- router ---------- */
function compile(pattern) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
  return { re, keys };
}
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) { this.routes.push({ method, ...compile(pattern), handler, opts }); return this; }
  get(p, h, o) { return this.add("GET", p, h, o); }
  post(p, h, o) { return this.add("POST", p, h, o); }
  put(p, h, o) { return this.add("PUT", p, h, o); }
  patch(p, h, o) { return this.add("PATCH", p, h, o); }
  delete(p, h, o) { return this.add("DELETE", p, h, o); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname); if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return { pathMatched };
  }
}

/* ---------- input validation / sanitising ---------- */
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;
const clean = s => String(s).replace(CTRL, "").trim();
const v = {
  str(x, field, { min = 0, max = 200, multiline = false, optional = false, pattern, msg } = {}) {
    if (x == null || x === "") { if (optional || min === 0) return ""; throw bad(`${field} is required.`, field); }
    if (typeof x !== "string") throw bad(`${field} must be text.`, field);
    let s = clean(x); if (!multiline) s = s.replace(/\s+/g, " ");
    if (s.length < min) throw bad(min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`, field);
    if (s.length > max) throw bad(`${field} must be ${max} characters or fewer.`, field);
    if (pattern && s && !pattern.test(s)) throw bad(msg || `${field} has an invalid format.`, field);
    return s;
  },
  int(x, field, { min = 0, max = 1e9, optional = false } = {}) {
    if (x == null || x === "") { if (optional) return null; throw bad(`${field} is required.`, field); }
    const n = typeof x === "string" && /^-?\d+$/.test(x.trim()) ? parseInt(x, 10) : x;
    if (!Number.isInteger(n)) throw bad(`${field} must be a whole number.`, field);
    if (n < min || n > max) throw bad(`${field} must be between ${min} and ${max}.`, field);
    return n;
  },
  bool(x, field) { if (typeof x !== "boolean") throw bad(`${field} must be true or false.`, field); return x; },
  oneOf(x, field, list) { if (!list.includes(x)) throw bad(`${field} must be one of: ${list.join(", ")}.`, field); return x; },
  date(x, field, optional = true) {
    if (x == null || x === "") { if (optional) return null; throw bad(`${field} is required.`, field); }
    if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x) || isNaN(Date.parse(x + "T00:00:00Z"))) throw bad(`${field} must be a date (YYYY-MM-DD).`, field);
    return x;
  },
  time(x, field) { if (typeof x !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw bad(`${field} must be a time like 09:30.`, field); return x; },
  url(x, field, optional = true) {
    if (x == null || x === "") { if (optional) return ""; throw bad(`${field} is required.`, field); }
    const s = v.str(x, field, { max: 500 });
    let u; try { u = new URL(s); } catch { throw bad(`${field} must be a full web address starting with https://`, field); }
    if (!/^https?:$/.test(u.protocol)) throw bad(`${field} must start with http:// or https://`, field);
    return u.toString();
  },
  arr(x, field, { max = 50 } = {}) { if (!Array.isArray(x)) throw bad(`${field} must be a list.`, field); if (x.length > max) throw bad(`${field} has too many entries (max ${max}).`, field); return x; },
};

const slug = s => String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";

module.exports = { HttpError, bad, send, json, clientIp, isHttps, expectedOrigin, readBody, readJson, parseCookies, cookie, Router, v, clean, slug };
