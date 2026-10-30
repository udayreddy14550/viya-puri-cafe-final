"use strict";
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const cfg = require("./config");
const { seedIfEmpty, db } = require("./db");
const { HttpError, Router, send, json, clientIp, isHttps } = require("./http");
const S = require("./security");
const { MIME_BY_EXT } = require("./uploads");
const { closeOrderStreams } = require("./order-events");

const router = new Router();
require("./routes/public").register(router);
require("./routes/admin").register(router);

const PUBLIC_DIR = path.join(cfg.ROOT, "public"), ADMIN_DIR = path.join(cfg.ROOT, "admin");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const ADMIN_PUBLIC_ASSETS = new Set(["login.js", "admin.css"]);   // everything else under /admin requires a session

const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");

function baseHeaders(req) {
  const h = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Content-Security-Policy": CSP,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Cross-Origin-Opener-Policy": "same-origin" };
  if (cfg.isProd) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return h;
}

function sendFile(req, res, file, extra = {}) {
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const ext = path.extname(file).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream", ETag: etag, "Cache-Control": "no-cache", ...extra };
  if (req.headers["if-none-match"] === etag) { send(res, 304, "", headers); return true; }
  send(res, 200, req.method === "HEAD" ? "" : fs.readFileSync(file), headers);
  return true;
}
function safeJoin(root, rel) {
  let p; try { p = decodeURIComponent(rel); } catch { return null; }
  if (p.includes("\0")) return null;
  const abs = path.resolve(root, "." + path.posix.normalize("/" + p));
  return abs.startsWith(path.resolve(root) + path.sep) ? abs : null;
}
const notFound = (req, res) => send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });

function serveStatic(req, res, pathname, session) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });

  /* uploaded menu photos: random file names, so they can be cached for a long time */
  if (pathname.startsWith("/uploads/")) {
    const f = safeJoin(cfg.uploadDir, pathname.slice(9));
    const mime = f && MIME_BY_EXT[path.extname(f).slice(1).toLowerCase()];
    if (!f || !mime || !sendFile(req, res, f, { "Content-Type": mime, "Cache-Control": "public, max-age=604800" })) notFound(req, res);
    return;
  }
  if (pathname === "/robots.txt") return send(res, 200, "User-agent: *\nDisallow: /admin\nDisallow: /api/admin\n", { "Content-Type": "text/plain; charset=utf-8" });

  /* admin area */
  if (pathname === "/admin/login") {
    if (session) return send(res, 302, "", { Location: "/admin", "Cache-Control": "no-store" });
    return sendFile(req, res, path.join(ADMIN_DIR, "login.html"), { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }) || notFound(req, res);
  }
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const gate = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
    const rel = pathname.replace(/^\/admin\/?/, "");
    if (rel.startsWith("assets/")) {
      const name = rel.slice(7);
      if (!ADMIN_PUBLIC_ASSETS.has(name) && !session) return send(res, 401, "Sign in required", { "Content-Type": "text/plain; charset=utf-8", ...gate });
      const f = safeJoin(path.join(ADMIN_DIR, "assets"), name);
      return (f && sendFile(req, res, f, gate)) || notFound(req, res);
    }
    if (!session) return send(res, 302, "", { Location: "/admin/login", ...gate });
    if (rel === "") return sendFile(req, res, path.join(ADMIN_DIR, "index.html"), gate) || notFound(req, res);
    if (/^receipt\/[^/]+$/.test(rel)) return sendFile(req, res, path.join(ADMIN_DIR, "receipt.html"), gate) || notFound(req, res);
    return notFound(req, res);
  }

  /* customer site */
  const rel = pathname === "/" || pathname === "/my-orders" ? "index.html" : pathname.slice(1);
  const f = safeJoin(PUBLIC_DIR, rel);
  if (f && sendFile(req, res, f)) return;
  notFound(req, res);
}

async function handle(req, res) {
  const ip = clientIp(req);
  try {
    for (const [k, val] of Object.entries(baseHeaders(req))) res.setHeader(k, val);
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    if (cfg.forceHttps && !isHttps(req) && pathname !== "/api/health") return send(res, 301, "", { Location: "https://" + req.headers.host + req.url });

    if (pathname.startsWith("/api/")) {
      const m = router.match(req.method === "HEAD" ? "GET" : req.method, pathname);
      if (!m.route) throw new HttpError(m.pathMatched ? 405 : 404, m.pathMatched ? "Method not allowed." : "Not found.");
      const ctx = { req, res, url, params: m.params, ip };
      if (m.route.opts.auth) {                       // every protected endpoint is checked here, on the server
        const session = S.getSession(req);
        if (!session) throw new HttpError(401, "Please sign in to continue.", { code: "AUTH" });
        const allowedRoles = m.route.opts.roles || ["owner"];
        if (!allowedRoles.includes(session.admin.role)) {
          throw new HttpError(403, "Your staff account does not have access to this page or action.", { code: "FORBIDDEN" });
        }
        if (!["GET", "HEAD"].includes(req.method)) S.checkCsrf(req, session);
        ctx.session = session; ctx.admin = session.admin;
      }
      return await m.route.handler(ctx);
    }
    const needsSession = pathname === "/admin" || pathname.startsWith("/admin/");
    return serveStatic(req, res, pathname, needsSession ? S.getSession(req) : null);
  } catch (e) {
    if (e instanceof HttpError) {
      const h = e.extra.retryAfter ? { "Retry-After": String(e.extra.retryAfter) } : {};
      const { retryAfter, ...extra } = e.extra;
      return json(res, e.status, { ok: false, message: e.message, ...extra }, h);
    }
    console.error("[error]", req.method, req.url, e);
    json(res, 500, { ok: false, message: "Something went wrong on the server. Please try again." });
  }
}

function start({ port = cfg.port, host = cfg.host } = {}) {
  seedIfEmpty();
  const server = http.createServer(handle);
  server.requestTimeout = 30e3; server.headersTimeout = 15e3; server.keepAliveTimeout = 5e3;
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(server); }); });
}

module.exports = { start, handle };

if (require.main === module) {
  start().catch(e => {
    if (e.code === "EADDRINUSE") console.error(`\nPort ${cfg.port} is already in use (is the server already running in another terminal?).\nStop that one, or set a different PORT in your .env file.\n`);
    else console.error("\nCould not start the server:", e.message, "\n");
    process.exit(1);
  }).then(server => {
    if (!server) return;
    const a = server.address();
    console.log(`Viya Puri Café is running at http://${a.address}:${a.port}`);
    console.log(`  Customer site: /      Admin login: /admin/login`);
    if (!db.prepare("SELECT 1 FROM admins LIMIT 1").get()) console.log("  No administrator exists yet. Create one with:  npm run create-admin");
    if (cfg.ephemeralSecret) console.warn("  NOTE: SESSION_SECRET is not set, so admin sessions end whenever the server restarts. Set it in .env.");
    if (cfg.isProd && !cfg.cookieSecure) console.warn("  WARNING: COOKIE_SECURE is off in production.");
    const stop = () => { closeOrderStreams(); server.close(() => { db.close(); process.exit(0); }); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  });
}
