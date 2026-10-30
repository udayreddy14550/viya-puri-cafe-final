"use strict";
/* SQLite via Node's built-in node:sqlite (Node >= 22.13). All queries use bound parameters. */
const fs = require("node:fs"), path = require("node:path");
const cfg = require("./config");   // first: it checks the Node version before node:sqlite is loaded
const { DatabaseSync } = require("node:sqlite");

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new DatabaseSync(cfg.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");

const SCHEMA_VERSION = 4;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  veg INTEGER NOT NULL DEFAULT 1 CHECK (veg IN (0,1)),
  tint TEXT NOT NULL DEFAULT '#e6c08e',
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  photo_type TEXT NOT NULL DEFAULT 'actual' CHECK (photo_type IN ('actual','representative')),
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_category ON menu_items(category_id);

CREATE TABLE IF NOT EXISTS item_sizes (
  item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  size_id TEXT NOT NULL,
  label TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, size_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  client_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','preparing','ready','completed','cancelled')),
  mode TEXT NOT NULL CHECK (mode IN ('delivery','pickup')),
  payment_method TEXT NOT NULL DEFAULT 'cod',
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),
  paid_at TEXT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address_line TEXT, locality TEXT, landmark TEXT, pincode TEXT,
  note TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, delivery_fee INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  coupon_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_coupon ON orders(coupon_code);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  category_name TEXT NOT NULL,
  size_id TEXT NOT NULL,
  size_label TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  line_total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_value TEXT, to_value TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('percent','flat')),
  value INTEGER NOT NULL CHECK (value > 0),
  max_discount INTEGER,
  min_order INTEGER NOT NULL DEFAULT 0,
  starts_on TEXT, expires_on TEXT,
  usage_limit INTEGER, per_customer_limit INTEGER,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id_hash TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_phone ON customer_sessions(phone);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, contact TEXT NOT NULL, message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  ip TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

function migrate() {
  const v = db.prepare("PRAGMA user_version").get().user_version;
  if (v < SCHEMA_VERSION) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const hasAdmins = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admins'").get();
      if (hasAdmins) {
        const adminColumns = db.prepare("PRAGMA table_info(admins)").all().map(row => row.name);
        if (!adminColumns.includes("role")) db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff'))");
      }
      const hasCustomerSessions = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'customer_sessions'").get();
      if (hasCustomerSessions) {
        const columns = db.prepare("PRAGMA table_info(customer_sessions)").all().map(row => row.name);
        if (columns.includes("customer_id")) {
          const hasCustomers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'customers'").get();
          db.exec(`
            DROP TABLE IF EXISTS customer_sessions_next;
            CREATE TABLE customer_sessions_next (
              id_hash TEXT PRIMARY KEY,
              phone TEXT NOT NULL,
              csrf_token TEXT NOT NULL,
              created_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              expires_at TEXT NOT NULL
            );
          `);
          if (hasCustomers) db.exec(`
            INSERT INTO customer_sessions_next(id_hash, phone, csrf_token, created_at, last_seen_at, expires_at)
            SELECT s.id_hash, c.phone, s.csrf_token, s.created_at, s.last_seen_at, s.expires_at
            FROM customer_sessions s JOIN customers c ON c.id = s.customer_id;
          `);
          db.exec("DROP TABLE customer_sessions; ALTER TABLE customer_sessions_next RENAME TO customer_sessions;");
        } else if (!columns.includes("phone")) {
          db.exec("ALTER TABLE customer_sessions ADD COLUMN phone TEXT");
        }
      }
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

/** Run fn inside a transaction (node:sqlite is synchronous, so this is atomic for this process). */
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

const now = () => new Date().toISOString();

/* ---------------- settings (JSON values) ---------------- */
let settingsCache = null;
const SETTING_DEFAULTS = {
  name: "Viya Puri Café", tagline: "", announcement: "", address: [], phone: "", phoneDisplay: "", whatsapp: "", mapsUrl: "",
  social: { instagram: "", facebook: "" }, timezone: "Asia/Kolkata", hours: { open: "11:00", close: "22:00" }, prepMinutes: 15,
  delivery: { enabled: true, freeAbove: 300, freeAboveBasis: "afterDiscount", fee: 20, minOrder: 0, pincodes: [], confirmed: false },
  featured: [], newItems: [], bestsellers: [], gallery: [], reviews: [],
  orderingEnabled: false, contactEnabled: false,
};
function getSettings() {
  if (settingsCache) return settingsCache;
  const out = structuredClone(SETTING_DEFAULTS);
  for (const r of db.prepare("SELECT key, value FROM settings").all()) {
    try { out[r.key] = r.key in SETTING_DEFAULTS && typeof SETTING_DEFAULTS[r.key] === "object" && !Array.isArray(SETTING_DEFAULTS[r.key]) ? { ...SETTING_DEFAULTS[r.key], ...JSON.parse(r.value) } : JSON.parse(r.value); } catch {}
  }
  return (settingsCache = out);
}
function saveSettings(patch) {
  const up = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  tx(() => { for (const [k, v] of Object.entries(patch)) up.run(k, JSON.stringify(v)); });
  settingsCache = null;
  return getSettings();
}

/* ---------------- seeding (first run only) ---------------- */
function seedIfEmpty() {
  const hasData = db.prepare("SELECT (SELECT COUNT(*) FROM categories) + (SELECT COUNT(*) FROM settings) AS n").get().n;
  if (hasData) return false;
  const seedFile = path.join(cfg.ROOT, "seed", "seed.json");
  if (!fs.existsSync(seedFile)) return false;
  const { config: C, menu: M } = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  const t = now();
  // copy bundled menu photos into the uploads folder (never overwrite existing files)
  const imgSrc = path.join(cfg.ROOT, "seed", "images"), imgDst = path.join(cfg.uploadDir, "menu");
  fs.mkdirSync(imgDst, { recursive: true });
  if (fs.existsSync(imgSrc)) for (const f of fs.readdirSync(imgSrc)) { const d = path.join(imgDst, f); if (!fs.existsSync(d)) fs.copyFileSync(path.join(imgSrc, f), d); }
  tx(() => {
    const catIns = db.prepare("INSERT INTO categories(id, name, sort_order) VALUES(?,?,?)");
    const catIdByName = new Map();
    M.categories.forEach((c, i) => { catIns.run(c.id, c.name, (i + 1) * 10); catIdByName.set(c.name, c.id); });
    const itemIns = db.prepare("INSERT INTO menu_items(id, category_id, name, description, veg, tint, available, photo_type, image_url, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    const sizeIns = db.prepare("INSERT INTO item_sizes(item_id, size_id, label, price, sort_order) VALUES(?,?,?,?,?)");
    M.items.forEach((it, i) => {
      itemIns.run(it.id, catIdByName.get(it.cat), it.name, it.description || "", it.veg ? 1 : 0, it.tint || "#e6c08e", it.available ? 1 : 0, it.photoType === "actual" ? "actual" : "representative", it.img || null, (i + 1) * 10, t, t);
      it.sizes.forEach((s, j) => sizeIns.run(it.id, s.id, s.label, s.price, j));
    });
    const skip = new Set(["coupons", "apiBase", "payments", "timezone", "pickup"]);
    const setIns = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
    for (const [k, v] of Object.entries(C)) if (!skip.has(k)) setIns.run(k, JSON.stringify(v));
    const cIns = db.prepare("INSERT INTO coupons(code, description, type, value, max_discount, min_order, starts_on, expires_on, usage_limit, per_customer_limit, active, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const c of C.coupons || []) cIns.run(c.code, "", "percent", c.percent, c.max ?? null, c.min ?? 0, null, c.expires || null, null, null, c.active ? 1 : 0, t, t);
  });
  settingsCache = null;
  return true;
}

function audit(actor, action, entity, entityId, summary) {
  db.prepare("INSERT INTO audit_log(created_at, actor, action, entity, entity_id, summary) VALUES(?,?,?,?,?,?)").run(now(), actor || "system", action, entity, entityId == null ? null : String(entityId), summary);
}

migrate();

module.exports = { db, tx, now, migrate, seedIfEmpty, getSettings, saveSettings, audit, SETTING_DEFAULTS };
