"use strict";
const { db, tx, now, getSettings, saveSettings, audit } = require("../db");
const { HttpError, bad, json, readJson, clientIp, cookie, v, slug } = require("../http");
const S = require("../security");
const { handleImageUpload, removeUpload } = require("../uploads");
const { localDate, couponUsage } = require("../pricing");
const { openOrderStream } = require("../order-events");

const STATUSES = ["pending", "confirmed", "preparing", "ready", "completed", "cancelled"];
const FINAL = ["completed", "cancelled"];
const ok = (ctx, data = {}, status = 200) => json(ctx.res, status, { ok: true, ...data });

/* ---------- time helpers (café timezone) ---------- */
function tzOffsetMin(tz, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000);
}
/** local YYYY-MM-DD start -> UTC ISO */
function dayStartUtc(ymd, tz) {
  const guess = new Date(ymd + "T00:00:00Z");
  return new Date(guess.getTime() - tzOffsetMin(tz, guess) * 60000).toISOString();
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
function range(q, tz, defaultDays = 30) {
  const today = localDate(tz);
  const to = v.date(q.to, "To date") || today, from = v.date(q.from, "From date") || addDays(to, -(defaultDays - 1));
  if (from > to) throw bad("The From date must be on or before the To date.", "from");
  if (Date.parse(to) - Date.parse(from) > 800 * 864e5) throw bad("Choose a range of two years or less.", "from");
  return { from, to, startUtc: dayStartUtc(from, tz), endUtc: dayStartUtc(addDays(to, 1), tz) };
}

/* ---------- row shaping ---------- */
const orderRow = o => ({ id: o.id, reference: o.reference, status: o.status, mode: o.mode, paymentMethod: o.payment_method, paymentStatus: o.payment_status, paidAt: o.paid_at,
  customer: { name: o.customer_name, phone: o.customer_phone }, address: o.mode === "delivery" ? { line: o.address_line, locality: o.locality, landmark: o.landmark, pincode: o.pincode } : null,
  note: o.note, subtotal: o.subtotal, discount: o.discount, deliveryFee: o.delivery_fee, total: o.total, coupon: o.coupon_code, createdAt: o.created_at, updatedAt: o.updated_at, itemCount: o.item_count });

function adminMenu() {
  const sizes = new Map();
  for (const z of db.prepare("SELECT * FROM item_sizes ORDER BY item_id, sort_order").all()) { (sizes.get(z.item_id) || sizes.set(z.item_id, []).get(z.item_id)).push({ id: z.size_id, label: z.label, price: z.price }); }
  const categories = db.prepare("SELECT c.id, c.name, c.sort_order AS sortOrder, (SELECT COUNT(*) FROM menu_items i WHERE i.category_id = c.id) AS itemCount FROM categories c ORDER BY sort_order, name").all();
  const items = db.prepare("SELECT * FROM menu_items ORDER BY sort_order, name").all().map(i => ({ id: i.id, categoryId: i.category_id, name: i.name, description: i.description, veg: !!i.veg, tint: i.tint, available: !!i.available, photoType: i.photo_type, image: i.image_url, sizes: sizes.get(i.id) || [], updatedAt: i.updated_at }));
  return { categories, items };
}

function parseItem(b, existing) {
  const name = v.str(b.name, "Name", { min: 2, max: 80 });
  const description = v.str(b.description, "Description", { max: 400, multiline: true, optional: true });
  const categoryId = v.str(b.categoryId, "Category", { min: 1, max: 80 });
  if (!db.prepare("SELECT 1 FROM categories WHERE id = ?").get(categoryId)) throw bad("Choose a valid category.", "categoryId");
  const veg = v.bool(b.veg, "Veg / non-veg");
  const available = v.bool(b.available, "Availability");
  const tint = b.tint == null || b.tint === "" ? "#e6c08e" : v.str(b.tint, "Tint", { pattern: /^#[0-9a-fA-F]{6}$/, msg: "Tint must be a colour like #e6c08e." });
  const photoType = v.oneOf(b.photoType || "actual", "Photo type", ["actual", "representative"]);
  let image = b.image == null || b.image === "" ? null : v.str(b.image, "Image", { max: 200, pattern: /^\/uploads\/menu\/[A-Za-z0-9._-]+$/, msg: "Upload the image using the image button." });
  const sizesIn = v.arr(b.sizes, "Sizes", { max: 8 });
  if (!sizesIn.length) throw bad("Add at least one size with a price.", "sizes");
  const used = new Set(), sizes = sizesIn.map((z, i) => {
    z = z && typeof z === "object" ? z : {};
    const label = v.str(z.label, `Size ${i + 1} name`, { min: 1, max: 30 });
    const price = v.int(z.price, `Price for ${label}`, { min: 0, max: 100000 });
    let id = z.id != null && existing?.some(s => s.id === z.id) ? z.id : slug(label);
    let base = id, n = 2; while (used.has(id)) id = base + "-" + n++;
    used.add(id); return { id, label, price };
  });
  return { name, description, categoryId, veg, available, tint, photoType, image, sizes };
}
function writeSizes(itemId, sizes) {
  db.prepare("DELETE FROM item_sizes WHERE item_id = ?").run(itemId);
  const ins = db.prepare("INSERT INTO item_sizes(item_id, size_id, label, price, sort_order) VALUES(?,?,?,?,?)");
  sizes.forEach((z, i) => ins.run(itemId, z.id, z.label, z.price, i));
}
function pruneSettingsRefs(itemId) {
  const s = getSettings(), patch = {};
  for (const k of ["featured", "newItems", "bestsellers"]) if (s[k].includes(itemId)) patch[k] = s[k].filter(x => x !== itemId);
  if (Object.keys(patch).length) saveSettings(patch);
}
const imageStillUsed = url => url && db.prepare("SELECT 1 FROM menu_items WHERE image_url = ?").get(url);

function parseSettings(b) {
  const out = {}, s = getSettings();
  if ("name" in b) out.name = v.str(b.name, "Café name", { min: 2, max: 80 });
  if ("tagline" in b) out.tagline = v.str(b.tagline, "Tagline", { max: 120, optional: true });
  if ("announcement" in b) out.announcement = v.str(b.announcement, "Announcement", { max: 200, optional: true });
  if ("address" in b) out.address = v.arr(b.address, "Address", { max: 4 }).map(l => v.str(l, "Address line", { min: 1, max: 120 }));
  if ("phone" in b) out.phone = v.str(b.phone, "Phone", { pattern: /^\+?\d{8,15}$/, msg: "Phone must be digits with an optional leading + (for example +919014753530)." });
  if ("phoneDisplay" in b) out.phoneDisplay = v.str(b.phoneDisplay, "Phone (as shown)", { min: 5, max: 30 });
  if ("whatsapp" in b) out.whatsapp = v.str(b.whatsapp, "WhatsApp number", { optional: true, pattern: /^\d{8,15}$/, msg: "WhatsApp number must be digits only with country code, no + (for example 919014753530)." });
  if ("mapsUrl" in b) out.mapsUrl = v.url(b.mapsUrl, "Maps link");
  if ("social" in b) { const so = b.social || {}; out.social = { instagram: v.url(so.instagram, "Instagram link"), facebook: v.url(so.facebook, "Facebook link") }; }
  if ("hours" in b) { const h = b.hours || {}; out.hours = { open: v.time(h.open, "Opening time"), close: v.time(h.close, "Closing time") }; if (out.hours.open === out.hours.close) throw bad("Opening and closing time cannot be the same.", "hours"); }
  if ("prepMinutes" in b) out.prepMinutes = v.int(b.prepMinutes, "Preparation time", { min: 1, max: 240 });
  if ("delivery" in b) {
    const d = b.delivery || {};
    out.delivery = { enabled: v.bool(d.enabled, "Delivery on/off"), freeAbove: v.int(d.freeAbove, "Free delivery above", { min: 0, max: 100000 }), freeAboveBasis: v.oneOf(d.freeAboveBasis, "Free delivery basis", ["afterDiscount", "itemTotal"]),
      fee: v.int(d.fee, "Delivery fee", { min: 0, max: 5000 }), minOrder: v.int(d.minOrder, "Minimum delivery order", { min: 0, max: 100000 }),
      pincodes: v.arr(d.pincodes, "Pincodes", { max: 100 }).map(p => v.str(p, "Pincode", { pattern: /^\d{6}$/, msg: "Each pincode must be 6 digits." })), confirmed: v.bool(d.confirmed, "Delivery confirmed") };
  }
  if (!(out.delivery || s.delivery).enabled && (out.orderingEnabled ?? s.orderingEnabled)) throw bad("Turn on home delivery before accepting online orders.", "delivery");
  for (const k of ["orderingEnabled", "contactEnabled"]) if (k in b) out[k] = v.bool(b[k], k);
  for (const k of ["featured", "newItems", "bestsellers"]) if (k in b) {
    out[k] = [...new Set(v.arr(b[k], k, { max: 60 }).map(id => v.str(id, "Item", { min: 1, max: 120 })))];
    for (const id of out[k]) if (!db.prepare("SELECT 1 FROM menu_items WHERE id = ?").get(id)) throw bad("One of the chosen items no longer exists.", k);
  }
  if (out.orderingEnabled && !(out.phone || s.phone)) throw bad("Add a phone number before accepting online orders.", "phone");
  return out;
}

function parseCoupon(b, isNew) {
  const code = v.str(String(b.code || "").toUpperCase(), "Code", { min: 3, max: 20, pattern: /^[A-Z0-9_-]+$/, msg: "Use letters, numbers, - or _ only." });
  const type = v.oneOf(b.type, "Discount type", ["percent", "flat"]);
  const value = v.int(b.value, type === "percent" ? "Percent off" : "Amount off", { min: 1, max: type === "percent" ? 100 : 100000 });
  const c = { code, description: v.str(b.description, "Description", { max: 120, optional: true }), type, value,
    max_discount: type === "percent" ? v.int(b.maxDiscount, "Maximum discount", { min: 1, max: 100000, optional: true }) : null,
    min_order: v.int(b.minOrder ?? 0, "Minimum order", { min: 0, max: 100000 }),
    starts_on: v.date(b.startsOn, "Start date"), expires_on: v.date(b.expiresOn, "Expiry date"),
    usage_limit: v.int(b.usageLimit, "Total usage limit", { min: 1, max: 1e6, optional: true }), per_customer_limit: v.int(b.perCustomerLimit, "Per-customer limit", { min: 1, max: 1000, optional: true }),
    active: v.bool(b.active, "Active") ? 1 : 0 };
  if (c.starts_on && c.expires_on && c.starts_on > c.expires_on) throw bad("The expiry date must be after the start date.", "expiresOn");
  return c;
}
const couponOut = c => ({ code: c.code, description: c.description, type: c.type, value: c.value, maxDiscount: c.max_discount, minOrder: c.min_order, startsOn: c.starts_on, expiresOn: c.expires_on,
  usageLimit: c.usage_limit, perCustomerLimit: c.per_customer_limit, active: !!c.active, used: couponUsage(c.code).total, updatedAt: c.updated_at });

function register(router) {
  const A = (m, p, h, opts = {}) => router[m](p, h, { auth: true, ...opts });

  /* ----- auth ----- */
  A("get", "/api/admin/order-events", openOrderStream, { roles: ["owner", "staff"] });

  router.post("/api/admin/login", async (ctx) => {
    const ip = ctx.ip;
    S.checkSameOrigin(ctx.req);
    S.rateLimit("login-ip:" + ip, 20, 15 * 60e3);
    const b = await readJson(ctx.req, 4096);
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase().slice(0, 254) : "";
    const password = typeof b.password === "string" ? b.password.slice(0, 300) : "";
    if (!email || !password) throw new HttpError(400, "Enter your email address and password.");
    S.rateLimit("login-email:" + email, 10, 15 * 60e3);
    const a = db.prepare("SELECT * FROM admins WHERE email = ?").get(email);
    const generic = new HttpError(401, "That email address or password is not correct.");
    if (a && a.locked_until && Date.parse(a.locked_until) > Date.now()) { await S.verifyPassword(password, await S.getDummyHash()); throw new HttpError(429, "This account is temporarily locked after too many failed attempts. Try again later.", { retryAfter: Math.ceil((Date.parse(a.locked_until) - Date.now()) / 1000) }); }
    const good = a && a.active ? await S.verifyPassword(password, a.password_hash) : (await S.verifyPassword(password, await S.getDummyHash()), false);
    if (!good) {
      if (a) {
        const n = a.failed_attempts + 1, lock = n >= require("../config").loginMaxFailures;
        db.prepare("UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : n, lock ? new Date(Date.now() + require("../config").loginLockMinutes * 60e3).toISOString() : null, a.id);
        audit(email, "login-failed", "admin", a.id, lock ? "Account locked after repeated failures" : "Wrong password");
      }
      throw generic;
    }
    db.prepare("UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").run(now(), a.id);
    const old = S.getSession(ctx.req); if (old) S.destroySession(old.hash);
    const s = S.createSession(a.id, ip, ctx.req.headers["user-agent"]);
    audit(a.email, "login", "admin", a.id, "Signed in");
    json(ctx.res, 200, { ok: true, email: a.email, csrfToken: s.csrf, redirect: "/admin" }, { "Set-Cookie": cookie(S.COOKIE, s.token, { maxAgeSec: s.maxAgeSec }) });
  }, { auth: false });

  router.get("/api/admin/session", (ctx) => {
    const s = S.getSession(ctx.req);
    json(ctx.res, 200, s ? { authenticated: true, email: s.admin.email, role: s.admin.role, csrfToken: s.csrf } : { authenticated: false });
  }, { auth: false });

  A("post", "/api/admin/logout", (ctx) => {
    S.destroySession(ctx.session.hash);
    audit(ctx.admin.email, "logout", "admin", ctx.admin.id, "Signed out");
    json(ctx.res, 200, { ok: true }, { "Set-Cookie": cookie(S.COOKIE, "", { expire: true }) });
  }, { roles: ["owner", "staff"] });

  A("post", "/api/admin/password", async (ctx) => {
    S.rateLimit("pw:" + ctx.admin.id, 8, 15 * 60e3);
    const b = await readJson(ctx.req, 4096);
    const a = db.prepare("SELECT * FROM admins WHERE id = ?").get(ctx.admin.id);
    if (!(await S.verifyPassword(String(b.currentPassword || ""), a.password_hash))) throw bad("Your current password is not correct.", "currentPassword");
    const problem = S.passwordProblem(b.newPassword, a.email); if (problem) throw bad(problem, "newPassword");
    db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(await S.hashPassword(b.newPassword), a.id);
    S.destroyOtherSessions(a.id, ctx.session.hash);
    audit(a.email, "password", "admin", a.id, "Changed password");
    ok(ctx);
  }, { roles: ["owner", "staff"] });

  /* ----- owner-managed staff accounts ----- */
  A("get", "/api/admin/staff", (ctx) => {
    const staff = db.prepare("SELECT id, email, active, last_login_at AS lastLoginAt, created_at AS createdAt FROM admins WHERE role = 'staff' ORDER BY active DESC, email").all();
    json(ctx.res, 200, { staff });
  });
  A("post", "/api/admin/staff", async (ctx) => {
    S.rateLimit("staff-create:" + ctx.admin.id, 20, 60 * 60e3);
    const b = await readJson(ctx.req, 4096);
    const email = v.str(b.email, "Email", { min: 3, max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Enter a valid email address.", "email");
    const problem = S.passwordProblem(b.password, email);
    if (problem) throw bad(problem, "password");
    if (db.prepare("SELECT 1 FROM admins WHERE email = ?").get(email)) throw bad("An account with this email already exists.", "email");
    const passwordHash = await S.hashPassword(b.password);
    const t = now();
    const result = tx(() => {
      if (db.prepare("SELECT 1 FROM admins WHERE email = ?").get(email)) throw bad("An account with this email already exists.", "email");
      const created = db.prepare("INSERT INTO admins(email, password_hash, role, active, created_at) VALUES(?,?,'staff',1,?)").run(email, passwordHash, t);
      audit(ctx.admin.email, "create", "staff", created.lastInsertRowid, `Created staff account ${email}`);
      return created.lastInsertRowid;
    });
    ok(ctx, { id: result, email, active: true }, 201);
  });
  A("patch", "/api/admin/staff/:id/active", async (ctx) => {
    const id = v.int(ctx.params.id, "Staff account", { min: 1 });
    const b = await readJson(ctx.req, 4096);
    const active = v.bool(b.active, "Active");
    const staff = db.prepare("SELECT id, email, active FROM admins WHERE id = ? AND role = 'staff'").get(id);
    if (!staff) throw new HttpError(404, "That staff account was not found.");
    if (!!staff.active === active) throw new HttpError(409, `This account is already ${active ? "active" : "inactive"}.`);
    tx(() => {
      db.prepare("UPDATE admins SET active = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?").run(active ? 1 : 0, id);
      if (!active) db.prepare("DELETE FROM sessions WHERE admin_id = ?").run(id);
      audit(ctx.admin.email, active ? "activate" : "deactivate", "staff", id, `${active ? "Activated" : "Deactivated"} staff account ${staff.email}`);
    });
    ok(ctx, { id, active });
  });
  A("put", "/api/admin/staff/:id/password", async (ctx) => {
    const id = v.int(ctx.params.id, "Staff account", { min: 1 });
    S.rateLimit("staff-password:" + ctx.admin.id, 20, 60 * 60e3);
    const b = await readJson(ctx.req, 4096);
    const staff = db.prepare("SELECT id, email FROM admins WHERE id = ? AND role = 'staff'").get(id);
    if (!staff) throw new HttpError(404, "That staff account was not found.");
    const problem = S.passwordProblem(b.password, staff.email);
    if (problem) throw bad(problem, "password");
    const passwordHash = await S.hashPassword(b.password);
    tx(() => {
      db.prepare("UPDATE admins SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?").run(passwordHash, id);
      db.prepare("DELETE FROM sessions WHERE admin_id = ?").run(id);
      audit(ctx.admin.email, "password-reset", "staff", id, `Reset password for staff account ${staff.email}`);
    });
    ok(ctx, { id });
  });

  /* ----- dashboard ----- */
  A("get", "/api/admin/dashboard", (ctx) => {
    const s = getSettings(), tz = s.timezone, today = localDate(tz);
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const menu = one("SELECT COUNT(*) total, COALESCE(SUM(available),0) available FROM menu_items");
    const o = one("SELECT COUNT(*) total, COALESCE(SUM(status='pending'),0) pending, COALESCE(SUM(status IN ('confirmed','preparing','ready')),0) active, COALESCE(SUM(status='cancelled'),0) cancelled FROM orders");
    const sales = one("SELECT COALESCE(SUM(total),0) total, COUNT(*) n FROM orders WHERE status != 'cancelled'");
    const start = dayStartUtc(today, tz), startWeek = dayStartUtc(addDays(today, -6), tz);
    const td = one("SELECT COUNT(*) n, COALESCE(SUM(total),0) sales FROM orders WHERE status != 'cancelled' AND created_at >= ?", start);
    const byDay = new Map(); for (let i = 6; i >= 0; i--) byDay.set(addDays(today, -i), { date: addDays(today, -i), orders: 0, sales: 0 });
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    for (const r of db.prepare("SELECT created_at, total FROM orders WHERE status != 'cancelled' AND created_at >= ?").all(startWeek)) { const d = byDay.get(fmt.format(new Date(r.created_at))); if (d) { d.orders++; d.sales += r.total; } }
    const recentOrders = db.prepare("SELECT o.*, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) item_count FROM orders o ORDER BY created_at DESC, id DESC LIMIT 6").all().map(orderRow);
    const recentUpdates = db.prepare("SELECT created_at createdAt, actor, summary FROM audit_log WHERE action NOT IN ('login','logout','login-failed') ORDER BY id DESC LIMIT 8").all();
    json(ctx.res, 200, { menu: { total: menu.total, available: menu.available, unavailable: menu.total - menu.available, categories: one("SELECT COUNT(*) n FROM categories").n },
      orders: { total: o.total, pending: o.pending, inProgress: o.active, cancelled: o.cancelled, today: td.n }, sales: { total: sales.total, today: td.sales, average: sales.n ? Math.round(sales.total / sales.n) : 0, last7: [...byDay.values()] },
      unreadMessages: one("SELECT COUNT(*) n FROM messages WHERE is_read = 0").n, orderingEnabled: !!s.orderingEnabled, contactEnabled: !!s.contactEnabled, recentOrders, recentUpdates,
      topItems: db.prepare("SELECT item_name name, SUM(qty) qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled' GROUP BY item_id ORDER BY qty DESC LIMIT 5").all() });
  });

  /* ----- menu ----- */
  A("get", "/api/admin/menu", (ctx) => json(ctx.res, 200, adminMenu()));

  A("post", "/api/admin/menu/items", async (ctx) => {
    const d = parseItem(await readJson(ctx.req));
    const cat = d.categoryId;
    let id = cat + "--" + slug(d.name), n = 2; const base = id;
    while (db.prepare("SELECT 1 FROM menu_items WHERE id = ?").get(id)) id = base + "-" + n++;
    const t = now();
    tx(() => {
      const max = db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM menu_items WHERE category_id = ?").get(cat).m;
      db.prepare("INSERT INTO menu_items(id, category_id, name, description, veg, tint, available, photo_type, image_url, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, cat, d.name, d.description, d.veg ? 1 : 0, d.tint, d.available ? 1 : 0, d.photoType, d.image, max + 10, t, t);
      writeSizes(id, d.sizes);
    });
    audit(ctx.admin.email, "create", "menu", id, `Added menu item “${d.name}”`);
    ok(ctx, { id, item: adminMenu().items.find(i => i.id === id) }, 201);
  });

  A("put", "/api/admin/menu/items/:id", async (ctx) => {
    const cur = db.prepare("SELECT * FROM menu_items WHERE id = ?").get(ctx.params.id);
    if (!cur) throw new HttpError(404, "That menu item no longer exists.");
    const curSizes = db.prepare("SELECT size_id id FROM item_sizes WHERE item_id = ?").all(cur.id);
    const d = parseItem(await readJson(ctx.req), curSizes);
    tx(() => {
      db.prepare("UPDATE menu_items SET category_id=?, name=?, description=?, veg=?, tint=?, available=?, photo_type=?, image_url=?, updated_at=? WHERE id=?")
        .run(d.categoryId, d.name, d.description, d.veg ? 1 : 0, d.tint, d.available ? 1 : 0, d.photoType, d.image, now(), cur.id);
      writeSizes(cur.id, d.sizes);
    });
    if (cur.image_url && cur.image_url !== d.image && !imageStillUsed(cur.image_url)) removeUpload(cur.image_url);
    audit(ctx.admin.email, "update", "menu", cur.id, `Edited menu item “${d.name}”`);
    ok(ctx, { item: adminMenu().items.find(i => i.id === cur.id) });
  });

  A("patch", "/api/admin/menu/items/:id/availability", async (ctx) => {
    const b = await readJson(ctx.req, 1024), val = v.bool(b.available, "Availability");
    const r = db.prepare("UPDATE menu_items SET available = ?, updated_at = ? WHERE id = ?").run(val ? 1 : 0, now(), ctx.params.id);
    if (!r.changes) throw new HttpError(404, "That menu item no longer exists.");
    const it = db.prepare("SELECT name FROM menu_items WHERE id = ?").get(ctx.params.id);
    audit(ctx.admin.email, "update", "menu", ctx.params.id, `Marked “${it.name}” ${val ? "available" : "sold out"}`);
    ok(ctx, { available: val });
  });

  A("delete", "/api/admin/menu/items/:id", (ctx) => {
    const cur = db.prepare("SELECT * FROM menu_items WHERE id = ?").get(ctx.params.id);
    if (!cur) throw new HttpError(404, "That menu item no longer exists.");
    tx(() => { db.prepare("DELETE FROM menu_items WHERE id = ?").run(cur.id); pruneSettingsRefs(cur.id); });
    if (cur.image_url && !imageStillUsed(cur.image_url)) removeUpload(cur.image_url);
    audit(ctx.admin.email, "delete", "menu", cur.id, `Deleted menu item “${cur.name}”`);
    ok(ctx);
  });

  A("post", "/api/admin/menu/categories", async (ctx) => {
    const b = await readJson(ctx.req, 4096), name = v.str(b.name, "Category name", { min: 2, max: 40 });
    if (db.prepare("SELECT 1 FROM categories WHERE name = ?").get(name)) throw bad("A category with that name already exists.", "name");
    let id = slug(name), n = 2; const base = id; while (db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id)) id = base + "-" + n++;
    const max = db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM categories").get().m;
    db.prepare("INSERT INTO categories(id, name, sort_order) VALUES(?,?,?)").run(id, name, max + 10);
    audit(ctx.admin.email, "create", "category", id, `Added category “${name}”`);
    ok(ctx, { id }, 201);
  });
  A("put", "/api/admin/menu/categories/:id", async (ctx) => {
    const b = await readJson(ctx.req, 4096), name = v.str(b.name, "Category name", { min: 2, max: 40 }), order = v.int(b.sortOrder, "Order", { min: 0, max: 100000 });
    const clash = db.prepare("SELECT id FROM categories WHERE name = ? AND id != ?").get(name, ctx.params.id);
    if (clash) throw bad("A category with that name already exists.", "name");
    const r = db.prepare("UPDATE categories SET name = ?, sort_order = ? WHERE id = ?").run(name, order, ctx.params.id);
    if (!r.changes) throw new HttpError(404, "That category no longer exists.");
    audit(ctx.admin.email, "update", "category", ctx.params.id, `Updated category “${name}”`);
    ok(ctx);
  });
  A("delete", "/api/admin/menu/categories/:id", (ctx) => {
    const c = db.prepare("SELECT name FROM categories WHERE id = ?").get(ctx.params.id);
    if (!c) throw new HttpError(404, "That category no longer exists.");
    const n = db.prepare("SELECT COUNT(*) n FROM menu_items WHERE category_id = ?").get(ctx.params.id).n;
    if (n) throw new HttpError(409, `“${c.name}” still has ${n} item${n === 1 ? "" : "s"}. Move or delete them first.`);
    db.prepare("DELETE FROM categories WHERE id = ?").run(ctx.params.id);
    audit(ctx.admin.email, "delete", "category", ctx.params.id, `Deleted category “${c.name}”`);
    ok(ctx);
  });

  A("post", "/api/admin/uploads", async (ctx) => { S.rateLimit("upload:" + ctx.admin.id, 60, 60 * 60e3); ok(ctx, await handleImageUpload(ctx.req), 201); });

  /* ----- orders ----- */
  A("get", "/api/admin/orders", (ctx) => {
    const q = Object.fromEntries(ctx.url.searchParams), tz = getSettings().timezone;
    const where = [], p = [];
    if (q.status) { v.oneOf(q.status, "Status", STATUSES); where.push("o.status = ?"); p.push(q.status); }
    if (q.payment) { v.oneOf(q.payment, "Payment status", ["paid", "unpaid"]); where.push("o.payment_status = ?"); p.push(q.payment); }
    if (q.from) { where.push("o.created_at >= ?"); p.push(dayStartUtc(v.date(q.from, "From date"), tz)); }
    if (q.to) { where.push("o.created_at < ?"); p.push(dayStartUtc(addDays(v.date(q.to, "To date"), 1), tz)); }
    if (q.q) { const t = "%" + String(q.q).trim().slice(0, 60).replace(/[\\%_]/g, m => "\\" + m) + "%"; where.push("(o.reference LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR o.customer_phone LIKE ? ESCAPE '\\')"); p.push(t, t, t); }
    const W = where.length ? "WHERE " + where.join(" AND ") : "";
    const sort = { newest: "o.created_at DESC", oldest: "o.created_at ASC", total: "o.total DESC" }[q.sort] || "o.created_at DESC";
    const pageSize = Math.min(100, Math.max(5, parseInt(q.pageSize, 10) || 25)), page = Math.max(1, parseInt(q.page, 10) || 1);
    const total = db.prepare(`SELECT COUNT(*) n FROM orders o ${W}`).get(...p).n;
    const rows = db.prepare(`SELECT o.*, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) item_count FROM orders o ${W} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...p, pageSize, (page - 1) * pageSize).map(orderRow);
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0])); for (const r of db.prepare("SELECT status, COUNT(*) n FROM orders GROUP BY status").all()) counts[r.status] = r.n;
    json(ctx.res, 200, { orders: rows, total, page, pageSize, counts });
  }, { roles: ["owner", "staff"] });

  const loadOrder = idOrRef => {
    const o = db.prepare("SELECT * FROM orders WHERE reference = ? OR id = ?").get(idOrRef, /^\d+$/.test(idOrRef) ? +idOrRef : -1);
    if (!o) throw new HttpError(404, "That order was not found.");
    return o;
  };
  A("get", "/api/admin/orders/:id", (ctx) => {
    const o = loadOrder(ctx.params.id);
    json(ctx.res, 200, { order: { ...orderRow(o), items: db.prepare("SELECT item_id itemId, item_name name, category_name category, size_label size, unit_price price, qty, line_total total FROM order_items WHERE order_id = ? ORDER BY id").all(o.id),
      events: db.prepare("SELECT created_at createdAt, actor, kind, from_value 'from', to_value 'to', note FROM order_events WHERE order_id = ? ORDER BY id").all(o.id) } });
  }, { roles: ["owner", "staff"] });
  A("patch", "/api/admin/orders/:id/status", async (ctx) => {
    const b = await readJson(ctx.req, 4096), to = v.oneOf(b.status, "Status", STATUSES), note = v.str(b.note, "Note", { max: 200, optional: true });
    tx(() => {
      const o = loadOrder(ctx.params.id);
      if (o.status === to) throw new HttpError(409, `This order is already ${to}.`);
      if (FINAL.includes(o.status)) throw new HttpError(409, `A ${o.status} order cannot be changed.`);
      db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(to, now(), o.id);
      db.prepare("INSERT INTO order_events(order_id, created_at, actor, kind, from_value, to_value, note) VALUES(?,?,?,?,?,?,?)").run(o.id, now(), ctx.admin.email, "status", o.status, to, note || null);
      audit(ctx.admin.email, "order", "order", o.reference, `Order ${o.reference}: ${o.status} → ${to}`);
    });
    ok(ctx, { status: to });
  }, { roles: ["owner", "staff"] });
  A("patch", "/api/admin/orders/:id/payment", async (ctx) => {
    const b = await readJson(ctx.req, 4096), to = v.oneOf(b.paymentStatus, "Payment status", ["paid", "unpaid"]), note = v.str(b.note, "Note", { max: 200, optional: true });
    tx(() => {
      const o = loadOrder(ctx.params.id);
      if (o.status === "cancelled") throw new HttpError(409, "A cancelled order cannot be marked as paid.");
      if (o.payment_status === to) throw new HttpError(409, `This order is already marked ${to}.`);
      db.prepare("UPDATE orders SET payment_status = ?, paid_at = ?, updated_at = ? WHERE id = ?").run(to, to === "paid" ? now() : null, now(), o.id);
      db.prepare("INSERT INTO order_events(order_id, created_at, actor, kind, from_value, to_value, note) VALUES(?,?,?,?,?,?,?)").run(o.id, now(), ctx.admin.email, "payment", o.payment_status, to, note || null);
      audit(ctx.admin.email, "order", "order", o.reference, `Order ${o.reference}: payment ${o.payment_status} → ${to}`);
    });
    ok(ctx, { paymentStatus: to });
  }, { roles: ["owner", "staff"] });

  /* ----- settings ----- */
  A("get", "/api/admin/settings", (ctx) => { const s = getSettings(); json(ctx.res, 200, { settings: { ...s }, items: db.prepare("SELECT id, name FROM menu_items ORDER BY name").all() }); });
  A("put", "/api/admin/settings", async (ctx) => {
    const patch = parseSettings(await readJson(ctx.req));
    const s = saveSettings(patch);
    audit(ctx.admin.email, "update", "settings", null, "Updated café settings" + (Object.keys(patch).length <= 3 ? ": " + Object.keys(patch).join(", ") : ` (${Object.keys(patch).length} fields)`));
    ok(ctx, { settings: s });
  });

  /* ----- coupons ----- */
  A("get", "/api/admin/coupons", (ctx) => json(ctx.res, 200, { coupons: db.prepare("SELECT * FROM coupons ORDER BY active DESC, code").all().map(couponOut) }));
  A("post", "/api/admin/coupons", async (ctx) => {
    const c = parseCoupon(await readJson(ctx.req), true), t = now();
    if (db.prepare("SELECT 1 FROM coupons WHERE code = ?").get(c.code)) throw bad("A coupon with that code already exists.", "code");
    db.prepare("INSERT INTO coupons(code, description, type, value, max_discount, min_order, starts_on, expires_on, usage_limit, per_customer_limit, active, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(c.code, c.description, c.type, c.value, c.max_discount, c.min_order, c.starts_on, c.expires_on, c.usage_limit, c.per_customer_limit, c.active, t, t);
    audit(ctx.admin.email, "create", "coupon", c.code, `Created coupon ${c.code}`);
    ok(ctx, {}, 201);
  });
  A("put", "/api/admin/coupons/:code", async (ctx) => {
    const c = parseCoupon({ ...(await readJson(ctx.req)), code: ctx.params.code }, false);
    const r = db.prepare("UPDATE coupons SET description=?, type=?, value=?, max_discount=?, min_order=?, starts_on=?, expires_on=?, usage_limit=?, per_customer_limit=?, active=?, updated_at=? WHERE code=?")
      .run(c.description, c.type, c.value, c.max_discount, c.min_order, c.starts_on, c.expires_on, c.usage_limit, c.per_customer_limit, c.active, now(), c.code);
    if (!r.changes) throw new HttpError(404, "That coupon no longer exists.");
    audit(ctx.admin.email, "update", "coupon", c.code, `Edited coupon ${c.code}`);
    ok(ctx);
  });
  A("patch", "/api/admin/coupons/:code/active", async (ctx) => {
    const val = v.bool((await readJson(ctx.req, 1024)).active, "Active");
    const r = db.prepare("UPDATE coupons SET active = ?, updated_at = ? WHERE code = ?").run(val ? 1 : 0, now(), ctx.params.code);
    if (!r.changes) throw new HttpError(404, "That coupon no longer exists.");
    audit(ctx.admin.email, "update", "coupon", ctx.params.code, `${val ? "Enabled" : "Disabled"} coupon ${ctx.params.code}`);
    ok(ctx, { active: val });
  });
  A("delete", "/api/admin/coupons/:code", (ctx) => {
    const r = db.prepare("DELETE FROM coupons WHERE code = ?").run(ctx.params.code);
    if (!r.changes) throw new HttpError(404, "That coupon no longer exists.");
    audit(ctx.admin.email, "delete", "coupon", ctx.params.code, `Deleted coupon ${ctx.params.code}`);
    ok(ctx);
  });

  /* ----- reports (real order rows; cancelled orders excluded from sales) ----- */
  A("get", "/api/admin/reports", (ctx) => {
    const tz = getSettings().timezone, r = range(Object.fromEntries(ctx.url.searchParams), tz);
    const rows = db.prepare("SELECT id, created_at, status, mode, payment_method, payment_status, total FROM orders WHERE created_at >= ? AND created_at < ?").all(r.startUtc, r.endUtc);
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const days = new Map(); for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.set(d, { date: d, orders: 0, sales: 0 });
    const by = { status: Object.fromEntries(STATUSES.map(s => [s, 0])), mode: {}, payment: {} };
    let sales = 0, valid = 0, completed = 0, paid = 0;
    for (const o of rows) {
      by.status[o.status]++;
      if (o.status === "cancelled") continue;
      valid++; sales += o.total; if (o.status === "completed") completed += o.total; if (o.payment_status === "paid") paid += o.total;
      by.payment[o.payment_method] = (by.payment[o.payment_method] || 0) + 1;
      const d = days.get(fmt.format(new Date(o.created_at))); if (d) { d.orders++; d.sales += o.total; }
    }
    const popular = db.prepare(`SELECT oi.item_id itemId, oi.item_name name, SUM(oi.qty) qty, SUM(oi.line_total) revenue FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'cancelled' AND o.created_at >= ? AND o.created_at < ? GROUP BY oi.item_id, oi.item_name ORDER BY qty DESC, revenue DESC LIMIT 10`).all(r.startUtc, r.endUtc);
    json(ctx.res, 200, { range: { from: r.from, to: r.to }, totals: { orders: rows.length, countedOrders: valid, cancelled: by.status.cancelled, sales, completedSales: completed, paidSales: paid, averageOrder: valid ? Math.round(sales / valid) : 0 }, byStatus: by.status, byPayment: by.payment, byDay: [...days.values()], popular, enoughData: valid >= 5 });
  });

  /* ----- messages from the contact form ----- */
  A("get", "/api/admin/messages", (ctx) => json(ctx.res, 200, { messages: db.prepare("SELECT id, name, contact, message, is_read isRead, created_at createdAt FROM messages ORDER BY id DESC LIMIT 200").all() }));
  A("patch", "/api/admin/messages/:id", async (ctx) => { const val = v.bool((await readJson(ctx.req, 1024)).isRead, "isRead"); db.prepare("UPDATE messages SET is_read = ? WHERE id = ?").run(val ? 1 : 0, +ctx.params.id || 0); ok(ctx); });
  A("delete", "/api/admin/messages/:id", (ctx) => { db.prepare("DELETE FROM messages WHERE id = ?").run(+ctx.params.id || 0); ok(ctx); });
}

module.exports = { register };
