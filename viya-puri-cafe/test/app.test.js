"use strict";
/* End-to-end tests: real HTTP requests against a real server with a throwaway database. Run: npm test */
const os = require("node:os"), path = require("node:path"), fs = require("node:fs"), vm = require("node:vm"), { spawnSync } = require("node:child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpc-"));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, "t.db"), UPLOAD_DIR: path.join(tmp, "up"), SESSION_SECRET: "test-secret-".padEnd(48, "x"), NODE_ENV: "test", LOGIN_MAX_FAILURES: "5" });
const test = require("node:test"), assert = require("node:assert/strict");
const { start } = require("../server/index");
const { resetRateLimits } = require("../server/security");
const { db } = require("../server/db");

const EMAIL = "owner@example.com", PASSWORD = "Correct-Horse-9!";
let server, base, cookie = "", csrf = "";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function call(method, url, { body, auth = true, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  if (auth && csrf && method !== "GET" && !h["x-csrf-token"]) h["x-csrf-token"] = csrf;
  let b = raw;
  if (body !== undefined) { h["content-type"] = "application/json"; b = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers: h, body: b, redirect: "manual" });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function openOrderEvents(sessionCookie, since) {
  const controller = new AbortController();
  const suffix = since == null ? "" : "?since=" + encodeURIComponent(since);
  const response = await fetch(base + "/api/admin/order-events" + suffix, { headers: { cookie: sessionCookie }, signal: controller.signal });
  return { response, controller, reader: response.body?.getReader(), buffer: "" };
}
async function readSseUntil(stream, text, timeoutMs = 3000) {
  const read = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for SSE event: " + text)), timeoutMs);
    stream.reader.read().then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  while (!stream.buffer.includes(text)) {
    const part = await read();
    if (part.done) throw new Error("SSE stream closed before " + text);
    stream.buffer += Buffer.from(part.value).toString("utf8");
  }
  return stream.buffer;
}
function closeSse(stream) {
  stream.controller.abort();
  if (stream.reader) stream.reader.cancel().catch(() => {});
}
const login = async (email = EMAIL, password = PASSWORD) => {
  const r = await call("POST", "/api/admin/login", { body: { email, password }, auth: false });
  if (r.status === 200) { cookie = r.headers.get("set-cookie").split(";")[0]; csrf = r.json.csrfToken; }
  return r;
};
const itemBody = (o = {}) => ({ name: "Test Puri Chaat", description: "Crispy test item", categoryId: "pani-puri-chaat", veg: true, available: true, photoType: "actual", image: null, sizes: [{ label: "Half", price: 80 }, { label: "Full", price: 150 }], ...o });
const order = (o = {}) => ({ clientKey: "key-" + Math.random().toString(36).slice(2, 12), mode: "delivery", payment: "cod", items: [{ id: o.itemId || "mocktails--blue-curacao", size: o.size || "medium", qty: 2 }], customer: { name: "Asha", phone: "9876543210" }, address: { line: "12 Main Road", locality: "Brodipet", landmark: "", pincode: "522019" }, note: "", ...o.extra });

test.before(async () => {
  server = await start({ port: 0, host: "127.0.0.1" }); base = "http://127.0.0.1:" + server.address().port;
  const r = spawnSync("node", ["scripts/create-admin.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD }, encoding: "utf8" });
  assert.match(r.stdout, /Administrator created/, r.stderr);
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test("create-admin rejects weak passwords", () => {
  const r = spawnSync("node", ["scripts/create-admin.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, ADMIN_EMAIL: "x@example.com", ADMIN_PASSWORD: "short" }, encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Password rejected/);
});

test("customer-session migration preserves valid sessions and supports phone-based sessions", () => {
  const legacyDb = path.join(tmp, "legacy-customer-sessions.db");
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const legacy = new DatabaseSync(process.env.DATABASE_PATH);
    legacy.exec("PRAGMA foreign_keys = ON; CREATE TABLE admins (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT, last_login_at TEXT, created_at TEXT NOT NULL); INSERT INTO admins(id,email,password_hash,created_at) VALUES(1,'legacy@example.com','legacy-hash','2025-01-01'); CREATE TABLE customers (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE customer_sessions (id_hash TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);");
    legacy.prepare("INSERT INTO customers(id, phone, created_at) VALUES(1, ?, ?)").run("9876543210", new Date().toISOString());
    legacy.prepare("INSERT INTO customer_sessions(id_hash, customer_id, csrf_token, created_at, last_seen_at, expires_at) VALUES(?,?,?,?,?,?)").run("legacy-hash", 1, "legacy-csrf", new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
    legacy.exec("PRAGMA user_version = 2"); legacy.close();
    const { db } = require("./server/db");
    const result = {
      version: db.prepare("PRAGMA user_version").get().user_version,
      adminRole: db.prepare("SELECT role FROM admins WHERE email = ?").get("legacy@example.com")?.role,
      columns: db.prepare("PRAGMA table_info(customer_sessions)").all().map(row => row.name),
      migratedPhone: db.prepare("SELECT phone FROM customer_sessions WHERE id_hash = ?").get("legacy-hash")?.phone,
    };
    db.prepare("INSERT INTO customer_sessions(id_hash, phone, csrf_token, created_at, last_seen_at, expires_at) VALUES(?,?,?,?,?,?)").run("new-hash", "9123456789", "new-csrf", new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
    db.close(); console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_PATH: legacyDb, UPLOAD_DIR: path.join(tmp, "legacy-up") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout.trim());
  assert.equal(migrated.version, 4);
  assert.equal(migrated.adminRole, "owner");
  assert.ok(migrated.columns.includes("phone"));
  assert.ok(!migrated.columns.includes("customer_id"));
  assert.equal(migrated.migratedPhone, "9876543210");
});

test("public site and bootstrap data come from the database", async () => {
  assert.equal((await call("GET", "/", { auth: false })).status, 200);
  const b = await call("GET", "/api/public/bootstrap.js", { auth: false });
  const sb = { window: {} }; vm.runInNewContext(b.text, sb);
  assert.equal(sb.window.VPC_MENU.items.length, 50); assert.equal(sb.window.VPC_MENU.categories.length, 7);
  assert.equal(sb.window.VPC_CONFIG.orderingEnabled, false); assert.equal(sb.window.VPC_CONFIG.contactEnabled, false);
  assert.equal(JSON.stringify(sb.window.VPC_CONFIG.payments.map(p => p.id)), '["cod"]');
  assert.equal(sb.window.VPC_CONFIG.coupons.length, 0, "WELCOME10/CAFE20 start disabled, as in the original site");
  assert.ok(sb.window.VPC_MENU.items.every(i => i.description && i.description.length > 10), "every seeded item has a description");
  assert.match(sb.window.VPC_MENU.items[0].img, /^\/uploads\/menu\//);
  assert.equal((await call("GET", sb.window.VPC_MENU.items[0].img, { auth: false })).status, 200);
  const h = (await call("GET", "/", { auth: false })).headers;
  assert.match(h.get("content-security-policy"), /script-src 'self'/); assert.equal(h.get("x-content-type-options"), "nosniff");
});

test("unauthenticated visitors are blocked everywhere", async () => {
  for (const [m, u] of [["GET", "/api/admin/dashboard"], ["GET", "/api/admin/menu"], ["GET", "/api/admin/orders"], ["GET", "/api/admin/order-events"], ["GET", "/api/admin/settings"], ["GET", "/api/admin/coupons"], ["GET", "/api/admin/reports"], ["GET", "/api/admin/staff"], ["POST", "/api/admin/staff"], ["PATCH", "/api/admin/staff/1/active"], ["PUT", "/api/admin/staff/1/password"], ["POST", "/api/admin/menu/items"], ["DELETE", "/api/admin/menu/items/x"], ["POST", "/api/admin/uploads"], ["PUT", "/api/admin/settings"]])
    assert.equal((await call(m, u, { auth: false, body: m === "GET" ? undefined : {} })).status, 401, m + " " + u);
  const p = await call("GET", "/admin", { auth: false }); assert.equal(p.status, 302); assert.equal(p.headers.get("location"), "/admin/login");
  assert.equal((await call("GET", "/admin/assets/app.js", { auth: false })).status, 401);
  assert.equal((await call("GET", "/admin/login", { auth: false })).status, 200);
});

test("login: invalid credentials rejected with a generic message; valid credentials set a hardened cookie", async () => {
  const a = await login(EMAIL, "Wrong-Password-1!"), b = await login("nobody@example.com", PASSWORD);
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.json.message, b.json.message);
  assert.equal((await call("POST", "/api/admin/login", { body: { email: "", password: "" }, auth: false })).status, 400);
  const ok = await login();
  assert.equal(ok.status, 200);
  const sc = ok.headers.get("set-cookie"); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.ok(!JSON.stringify(ok.json).includes("scrypt"));
  assert.equal((await call("GET", "/api/admin/dashboard")).status, 200);
  assert.equal((await call("GET", "/admin")).status, 200);
});

test("owner can manage staff and staff are restricted to order management", async () => {
  const ownerLogin = await login();
  assert.equal(ownerLogin.status, 200);
  assert.equal(db.prepare("SELECT role FROM admins WHERE email = ?").get(EMAIL).role, "owner");
  assert.equal((await call("POST", "/api/admin/staff", { body: { email: "worker@example.com", password: "Cafe-Team-Strong-123!" } })).status, 201);
  assert.equal((await call("POST", "/api/admin/staff", { body: { email: "worker@example.com", password: "Cafe-Team-Strong-123!" } })).status, 400);

  const staffLogin = await login("worker@example.com", "Cafe-Team-Strong-123!");
  assert.equal(staffLogin.status, 200);
  assert.equal((await call("GET", "/api/admin/session")).json.role, "staff");
  assert.equal((await call("GET", "/api/admin/orders")).status, 200);
  const staffEvents = await openOrderEvents(cookie);
  assert.equal(staffEvents.response.status, 200);
  closeSse(staffEvents);
  assert.equal((await call("GET", "/api/admin/dashboard")).status, 403);
  assert.equal((await call("GET", "/api/admin/settings")).status, 403);
  assert.equal((await call("GET", "/api/admin/staff")).status, 403);
  assert.equal((await call("POST", "/api/admin/menu/items", { body: itemBody() })).status, 403);

  await login();
  assert.equal((await call("GET", "/api/admin/staff")).json.staff.length, 1);
  const staffId = db.prepare("SELECT id FROM admins WHERE email = ?").get("worker@example.com").id;
  assert.equal((await call("PUT", `/api/admin/staff/${staffId}/password`, { body: { password: "Cafe-Updated-456!Team" } })).status, 200);
  assert.equal((await login("worker@example.com", "Cafe-Team-Strong-123!")).status, 401);
  assert.equal((await login("worker@example.com", "Cafe-Updated-456!Team")).status, 200);
  const activeStaffCookie = cookie;
  await login();
  assert.equal((await call("PATCH", `/api/admin/staff/${staffId}/active`, { body: { active: false } })).status, 200);
  assert.equal((await call("GET", "/api/admin/orders", { auth: false, headers: { cookie: activeStaffCookie } })).status, 401, "deactivation revokes active sessions");
  assert.equal((await login("worker@example.com", "Cafe-Updated-456!Team")).status, 401);
  await login();
  assert.equal((await call("PATCH", `/api/admin/staff/${staffId}/active`, { body: { active: true } })).status, 200);
  assert.equal((await login("worker@example.com", "Cafe-Updated-456!Team")).status, 200);
  await login();
});

test("CSRF and cross-site requests are refused", async () => {
  assert.equal((await call("POST", "/api/admin/menu/categories", { body: { name: "X" }, headers: { "x-csrf-token": "wrong" } })).status, 403);
  assert.equal((await call("POST", "/api/admin/menu/categories", { body: { name: "Evil" }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("POST", "/api/admin/login", { body: { email: EMAIL, password: PASSWORD }, auth: false, headers: { origin: "https://evil.example" } })).status, 403);
});

test("menu CRUD: create, edit sizes/prices, availability, delete; public menu follows", async () => {
  const pub = async () => { const b = await call("GET", "/api/public/menu", { auth: false }); return b.json.items; };
  const c = await call("POST", "/api/admin/menu/items", { body: itemBody() });
  assert.equal(c.status, 201); const id = c.json.id; assert.match(id, /^pani-puri-chaat--test-puri-chaat/);
  let it = (await pub()).find(i => i.id === id);
  assert.deepEqual(it.sizes.map(s => [s.label, s.price]), [["Half", 80], ["Full", 150]]); assert.equal(it.cat.length > 0, true); assert.equal(it.available, true);
  const sizeIds = it.sizes.map(s => s.id);
  const e = await call("PUT", "/api/admin/menu/items/" + id, { body: itemBody({ name: "Test Puri Chaat v2", sizes: [{ id: sizeIds[0], label: "Half", price: 90 }, { id: sizeIds[1], label: "Full", price: 160 }, { label: "Family", price: 400 }] }) });
  assert.equal(e.status, 200);
  it = (await pub()).find(i => i.id === id); assert.equal(it.name, "Test Puri Chaat v2"); assert.deepEqual(it.sizes.map(s => s.price), [90, 160, 400]); assert.deepEqual(it.sizes.slice(0, 2).map(s => s.id), sizeIds, "existing size ids are stable");
  assert.equal((await call("PATCH", `/api/admin/menu/items/${id}/availability`, { body: { available: false } })).status, 200);
  assert.equal((await pub()).find(i => i.id === id).available, false);
  for (const bad of [itemBody({ sizes: [] }), itemBody({ sizes: [{ label: "A", price: -5 }] }), itemBody({ sizes: [{ label: "A", price: 1.5 }] }), itemBody({ name: "" }), itemBody({ categoryId: "nope" }), itemBody({ image: "https://evil.example/x.png" })])
    assert.equal((await call("POST", "/api/admin/menu/items", { body: bad })).status, 400);
  assert.equal((await call("DELETE", "/api/admin/menu/items/" + id)).status, 200);
  assert.equal((await pub()).find(i => i.id === id), undefined);
  assert.equal((await call("DELETE", "/api/admin/menu/items/" + id)).status, 404);
});

test("image upload: type, size and content are checked", async () => {
  const up = (buf, name, type) => { const fd = new FormData(); fd.append("file", new Blob([buf], { type }), name); return call("POST", "/api/admin/uploads", { raw: fd }); };
  const ok = await up(PNG, "x.png", "image/png"); assert.equal(ok.status, 201); assert.match(ok.json.url, /^\/uploads\/menu\/[0-9a-f]{24}\.png$/);
  const served = await call("GET", ok.json.url, { auth: false }); assert.equal(served.status, 200); assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal((await up(Buffer.from("<script>alert(1)</script>"), "evil.png", "image/png")).status, 415, "fake image content");
  assert.equal((await up(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "a.svg", "image/svg+xml")).status, 415);
  assert.equal((await up(Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]), "big.png", "image/png")).status, 413);
  const withImg = await call("POST", "/api/admin/menu/items", { body: itemBody({ name: "Pic item", image: ok.json.url }) }); assert.equal(withImg.status, 201);
  assert.equal((await call("GET", "/uploads/..%2f..%2fetc%2fpasswd", { auth: false })).status, 404);
  assert.equal((await call("GET", "/uploads/menu/../../server/config.js", { auth: false })).status, 404);
  await call("DELETE", "/api/admin/menu/items/" + withImg.json.id);
  assert.equal((await call("GET", ok.json.url, { auth: false })).status, 404, "file removed when its item is deleted");
});

test("ordering is off by default, then works end to end with server-side pricing", async () => {
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order() })).status, 503);
  assert.equal((await call("POST", "/api/contact", { auth: false, body: { name: "A B", contact: "9876543210", message: "hello there" } })).status, 503);
  const s = await call("PUT", "/api/admin/settings", { body: { orderingEnabled: true, contactEnabled: true, phone: "+919014753530" } }); assert.equal(s.status, 200);
  const menu = (await call("GET", "/api/public/menu", { auth: false })).json.items; const cur = menu.find(i => i.id === "mocktails--blue-curacao"); const price = cur.sizes[0].price; const size = cur.sizes[0].id;

  const o1 = order({ itemId: cur.id, size, extra: { expectedTotal: price * 2 + (price * 2 > 300 ? 0 : 20) } });
  const r1 = await call("POST", "/api/orders", { auth: false, body: { ...o1, items: [{ id: cur.id, size, qty: 2, price: 1 }] } });   // a client-supplied price is ignored
  assert.equal(r1.status, 201, r1.text); assert.match(r1.json.reference, /^VPC-\d{6}-[A-Z2-9]{4}$/);
  assert.deepEqual(r1.json.items.map(i => [i.name, i.qty]), [[cur.name, 2]]);
  assert.equal(r1.json.paymentMethod, "cod"); assert.equal(r1.json.paymentStatus, "unpaid"); assert.equal(r1.json.orderStatus, "pending");
  assert.equal(r1.json.subtotal, price * 2); assert.equal(typeof r1.json.deliveryFee, "number");
  assert.equal((await call("POST", "/api/orders", { auth: false, body: o1 })).json.duplicate, true, "same clientKey returns the same order, not a second one");
  assert.equal((await call("POST", "/api/orders", { auth: false, body: { ...order({ itemId: cur.id, size }), expectedTotal: 1 } })).status, 409);
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order({ extra: { customer: { name: "A", phone: "123" } } }) })).status, 400);
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order({ extra: { items: [{ id: "nope", size: "x", qty: 1 }] } }) })).status, 409);
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order({ extra: { items: [{ id: cur.id, size, qty: 99 }] } }) })).status, 400);
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order({ extra: { payment: "card" } }) })).status, 400);
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order({ extra: { mode: "pickup", address: null } }) })).status, 400, "pickup no longer exists");
  assert.equal("pickup" in (await call("GET", "/api/public/config", { auth: false })).json, false);
  // phone starting with 91 is a valid number and must not be mangled
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order({ itemId: cur.id, size, extra: { customer: { name: "Ravi", phone: "9123456789" } } }) })).status, 201);
  // sold out items are refused
  await call("PATCH", `/api/admin/menu/items/${cur.id}/availability`, { body: { available: false } });
  assert.equal((await call("POST", "/api/orders", { auth: false, body: order({ itemId: cur.id, size }) })).status, 409);
  await call("PATCH", `/api/admin/menu/items/${cur.id}/availability`, { body: { available: true } });
  // contact form now stores a message
  assert.equal((await call("POST", "/api/contact", { auth: false, body: { name: "Asha K", contact: "9876543210", message: "Do you do party orders?" } })).status, 201);
  assert.equal((await call("GET", "/api/admin/messages")).json.messages.length, 1);
});

test("customers can see full order details by checkout phone without SMS or order reference", async () => {
  resetRateLimits();
  const created = await call("POST", "/api/orders", {
    auth: false, body: order({ extra: { customer: { name: "Lookup Customer", phone: "9345670001" } } }),
  });
  assert.equal(created.status, 201, created.text);
  const otherOrder = await call("POST", "/api/orders", {
    auth: false,
    body: order({ extra: { customer: { name: "Other Customer", phone: "9345670002" } } }),
  });
  assert.equal(otherOrder.status, 201, otherOrder.text);
  const history = await call("POST", "/api/customer/orders/lookup", {
    auth: false,
    body: { phone: "+91 93456 70001" },
  });
  assert.equal(history.status, 200, history.text);
  assert.equal(history.json.total, 1);
  assert.equal(history.json.orders.length, 1);
  assert.equal(history.json.orders[0].reference, created.json.reference);
  assert.equal(history.json.orders[0].customer.name, "Lookup Customer");
  assert.equal(history.json.orders[0].customer.phone, "9345670001");
  assert.equal(history.json.orders[0].address.pincode, "522019");
  assert.equal(history.json.orders[0].timeline[0].kind, "created");
  assert.equal(history.headers.get("cache-control"), "no-store");
  assert.equal((await call("POST", "/api/customer/orders/lookup", {
    auth: false, body: { phone: "9345670002" },
  })).json.orders[0].reference, otherOrder.json.reference);
  assert.equal((await call("POST", "/api/customer/orders/lookup", {
    auth: false, body: { phone: "9123450000" },
  })).json.total, 0);
  assert.equal((await call("POST", "/api/customer/orders/lookup", {
    auth: false, body: { phone: "12345" },
  })).status, 400, "phone format is validated");
  assert.equal((await call("POST", "/api/customer/auth/otp", {
    auth: false, body: { phone: "9876543210" },
  })).status, 404, "no SMS-provider endpoint is required");
});

test("customers can cancel only matching Pending orders and notify connected owners and staff", async () => {
  resetRateLimits();
  await login();
  assert.equal((await call("PUT", "/api/admin/settings", { body: { orderingEnabled: true } })).status, 200);
  const ownerCookie = cookie;
  const staffLogin = await login("worker@example.com", "Cafe-Updated-456!Team");
  assert.equal(staffLogin.status, 200);
  const staffCookie = cookie;
  await login();
  const placed = await call("POST", "/api/orders", {
    auth: false, body: order({ extra: { customer: { name: "Cancellation Customer", phone: "9345670011" } } }),
  });
  assert.equal(placed.status, 201, placed.text);
  const cursor = Number(db.prepare("SELECT COALESCE(MAX(id), 0) id FROM order_events WHERE kind IN ('created', 'customer_cancelled')").get().id);
  const ownerStream = await openOrderEvents(ownerCookie, cursor);
  const staffStream = await openOrderEvents(staffCookie, cursor);
  try {
    assert.equal(ownerStream.response.status, 200);
    assert.equal(staffStream.response.status, 200);
    await Promise.all([readSseUntil(ownerStream, "event: ready"), readSseUntil(staffStream, "event: ready")]);
    const wrongPhone = await call("POST", "/api/customer/orders/cancel", {
      auth: false, body: { phone: "9345670099", reference: placed.json.reference },
    });
    assert.equal(wrongPhone.status, 404);
    assert.equal(db.prepare("SELECT status FROM orders WHERE reference = ?").get(placed.json.reference).status, "pending");

    const before = db.prepare("SELECT COUNT(*) n FROM order_events WHERE kind = 'customer_cancelled'").get().n;
    const cancelled = await call("POST", "/api/customer/orders/cancel", {
      auth: false, body: { phone: "+91 93456 70011", reference: placed.json.reference },
    });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.json.cancelled, true);
    assert.equal(cancelled.json.duplicate, false);
    assert.equal(db.prepare("SELECT status FROM orders WHERE reference = ?").get(placed.json.reference).status, "cancelled");
    const updatedLookup = await call("POST", "/api/customer/orders/lookup", {
      auth: false, body: { phone: "9345670011" },
    });
    assert.equal(updatedLookup.json.orders[0].status, "cancelled");
    assert.ok(updatedLookup.json.orders[0].timeline.some(event => event.kind === "customer_cancelled"));
    const notifications = await Promise.all([
      readSseUntil(ownerStream, "event: order_cancelled"),
      readSseUntil(staffStream, "event: order_cancelled"),
    ]);
    for (const notification of notifications) {
      const match = notification.match(/id: (\d+)\nevent: order_cancelled\ndata: ([^\n]+)/);
      assert.ok(match, notification);
      assert.equal(JSON.parse(match[2]).reference, placed.json.reference);
      assert.equal(JSON.parse(match[2]).total, placed.json.total);
    }
    const retry = await call("POST", "/api/customer/orders/cancel", {
      auth: false, body: { phone: "9345670011", reference: placed.json.reference },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.duplicate, true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE kind = 'customer_cancelled'").get().n, before + 1);

    const replay = await openOrderEvents(ownerCookie, cursor);
    try {
      assert.equal(replay.response.status, 200);
      const notification = await readSseUntil(replay, "event: order_cancelled");
      assert.match(notification, new RegExp(placed.json.reference));
    } finally { closeSse(replay); }

    const confirmed = await call("POST", "/api/orders", {
      auth: false, body: order({ extra: { customer: { name: "Later Status Customer", phone: "9345670012" } } }),
    });
    assert.equal(confirmed.status, 201);
    assert.equal((await call("PATCH", `/api/admin/orders/${confirmed.json.reference}/status`, { body: { status: "confirmed" } })).status, 200);
    const refused = await call("POST", "/api/customer/orders/cancel", {
      auth: false, body: { phone: "9345670012", reference: confirmed.json.reference },
    });
    assert.equal(refused.status, 409);
    assert.equal(db.prepare("SELECT status FROM orders WHERE reference = ?").get(confirmed.json.reference).status, "confirmed");
  } finally { closeSse(ownerStream); closeSse(staffStream); }
  await login();
});

test("authenticated order streams deliver once, to multiple sessions, and replay missed orders", async () => {
  resetRateLimits();
  const firstCookie = cookie;
  const secondLogin = await call("POST", "/api/admin/login", { auth: false, body: { email: EMAIL, password: PASSWORD } });
  assert.equal(secondLogin.status, 200);
  const secondCookie = secondLogin.headers.get("set-cookie").split(";")[0];
  const latestCreated = () => Number(db.prepare("SELECT COALESCE(MAX(id), 0) id FROM order_events WHERE kind = 'created'").get().id);
  const eventA = await openOrderEvents(firstCookie), eventB = await openOrderEvents(secondCookie);
  try {
    assert.equal(eventA.response.status, 200); assert.equal(eventB.response.status, 200);
    await Promise.all([readSseUntil(eventA, "event: ready"), readSseUntil(eventB, "event: ready")]);
    const payload = order();
    const placed = await call("POST", "/api/orders", { auth: false, body: payload });
    assert.equal(placed.status, 201, placed.text);
    const messages = await Promise.all([readSseUntil(eventA, "event: new_order"), readSseUntil(eventB, "event: new_order")]);
    const eventIds = messages.map(message => Number(message.match(/id: (\d+)\nevent: new_order/)[1]));
    assert.equal(eventIds[0], eventIds[1]);
    for (const message of messages) {
      const data = JSON.parse(message.match(/event: new_order\ndata: ([^\n]+)/)[1]);
      assert.equal(data.reference, placed.json.reference); assert.equal(data.total, placed.json.total);
    }
    const createdCount = db.prepare("SELECT COUNT(*) n FROM order_events WHERE kind = 'created'").get().n;
    const retry = await call("POST", "/api/orders", { auth: false, body: { clientKey: payload.clientKey } });
    assert.equal(retry.status, 200); assert.equal(retry.json.duplicate, true); assert.equal(retry.json.reference, placed.json.reference);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE kind = 'created'").get().n, createdCount, "idempotent retries create no second event");
    assert.equal((await call("PUT", "/api/admin/settings", { body: { orderingEnabled: false } })).status, 200);
    const recoveredWhileOrderingOff = await call("POST", "/api/orders", { auth: false, body: { clientKey: payload.clientKey } });
    assert.equal(recoveredWhileOrderingOff.status, 200); assert.equal(recoveredWhileOrderingOff.json.reference, placed.json.reference);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE kind = 'created'").get().n, createdCount, "reconciliation while ordering is off emits no new event");
    assert.equal((await call("PUT", "/api/admin/settings", { body: { orderingEnabled: true } })).status, 200);
    const failed = await call("POST", "/api/orders", { auth: false, body: order({ extra: { items: [{ id: "missing", size: "missing", qty: 1 }] } }) });
    assert.equal(failed.status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE kind = 'created'").get().n, createdCount, "failed attempts create no event");
  } finally { closeSse(eventA); closeSse(eventB); }

  const replayFrom = latestCreated();
  const missed = await call("POST", "/api/orders", { auth: false, body: order() });
  assert.equal(missed.status, 201);
  const replay = await openOrderEvents(firstCookie, replayFrom);
  try {
    assert.equal(replay.response.status, 200);
    const message = await readSseUntil(replay, "event: new_order");
    const data = JSON.parse(message.match(/event: new_order\ndata: ([^\n]+)/)[1]);
    assert.equal(data.reference, missed.json.reference);
  } finally { closeSse(replay); }
});

test("coupons are validated on the server (dates, minimum, limits, per customer)", async () => {
  resetRateLimits();
  const cur = (await call("GET", "/api/public/menu", { auth: false })).json.items.find(i => i.id === "mocktails--blue-curacao"); const size = cur.sizes[0].id;
  const o = (code, qty, phone) => order({ itemId: cur.id, size, extra: { coupon: code, items: [{ id: cur.id, size, qty }], customer: { name: "Test", phone: phone || "9876500001" } } });
  const place = (code, qty, phone) => (resetRateLimits(), call)("POST", "/api/orders", { auth: false, body: o(code, qty, phone) });
  assert.equal((await place("WELCOME10", 5)).status, 400, "disabled coupon");
  assert.equal((await call("PATCH", "/api/admin/coupons/WELCOME10/active", { body: { active: true } })).status, 200);
  const sub = cur.sizes[0].price * 5; assert.ok(sub >= 150, "test needs subtotal above the WELCOME10 minimum (" + sub + ")");
  const v = await call("POST", "/api/coupons/validate", { auth: false, body: { code: "WELCOME10", mode: "delivery", items: [{ id: cur.id, size, qty: 5 }] } });
  assert.equal(v.json.discount, Math.min(Math.round(sub * 0.10), 50));
  const good = await place("welcome10", 5); assert.equal(good.status, 201); assert.equal(good.json.total, sub - Math.min(Math.round(sub * 0.1), 50) + (sub - Math.min(Math.round(sub * 0.1), 50) > 300 ? 0 : 20));
  assert.equal((await place("WELCOME10", 1)).status, 400, "below minimum order");
  // new coupons: expiry, start, usage limits
  const mk = (b) => call("POST", "/api/admin/coupons", { body: { code: "T", type: "flat", value: 20, minOrder: 0, active: true, ...b } });
  assert.equal((await mk({ code: "OLD1", expiresOn: "2020-01-01" })).status, 201); assert.equal((await place("OLD1", 5)).json.message, "That coupon has expired.");
  assert.equal((await mk({ code: "FUT1", startsOn: "2099-01-01" })).status, 201); assert.match((await place("FUT1", 5)).json.message, /isn't active yet/);
  assert.equal((await mk({ code: "ONCE", usageLimit: 1 })).status, 201); assert.equal((await place("ONCE", 5, "9876500002")).status, 201); assert.match((await place("ONCE", 5, "9876500003")).json.message, /usage limit/);
  assert.equal((await mk({ code: "PERCUST", perCustomerLimit: 1 })).status, 201); assert.equal((await place("PERCUST", 5, "9876500004")).status, 201); assert.match((await place("PERCUST", 5, "9876500004")).json.message, /already used/); assert.equal((await place("PERCUST", 5, "9876500005")).status, 201);
  assert.equal((await mk({ code: "BAD!", type: "percent", value: 150 })).status, 400); assert.equal((await mk({ code: "ONCE" })).status, 400);
  const pc = (await call("GET", "/api/public/config", { auth: false })).json.coupons.map(c => c.code);
  assert.ok(pc.includes("WELCOME10") && !pc.includes("OLD1") && !pc.includes("ONCE"), "public list hides expired/exhausted coupons: " + pc);
});

test("orders: list, filter, status flow, payment rules, history", async () => {
  const list = await call("GET", "/api/admin/orders"); assert.ok(list.json.total >= 5);
  const first = list.json.orders[list.json.orders.length - 1];
  assert.equal((await call("GET", "/api/admin/orders?q=" + first.reference.slice(4, 12))).json.orders.some(o => o.reference === first.reference), true);
  assert.equal((await call("GET", "/api/admin/orders?status=pending")).json.orders.every(o => o.status === "pending"), true);
  assert.equal((await call("GET", "/api/admin/orders?from=2099-01-01")).json.total, 0);
  assert.equal((await call("GET", "/api/admin/orders?status=bogus")).status, 400);
  const ref = first.reference, d = (await call("GET", "/api/admin/orders/" + ref)).json.order;
  assert.equal(d.paymentMethod, "cod"); assert.equal(d.paymentStatus, "unpaid", "never auto-marked paid"); assert.ok(d.items.length && d.items[0].price > 0);
  for (const s of ["confirmed", "preparing", "ready", "completed"]) assert.equal((await call("PATCH", `/api/admin/orders/${ref}/status`, { body: { status: s } })).status, 200);
  assert.equal((await call("GET", "/api/admin/orders/" + ref)).json.order.paymentStatus, "unpaid", "completing an order does not mark it paid");
  assert.equal((await call("PATCH", `/api/admin/orders/${ref}/status`, { body: { status: "pending" } })).status, 409, "completed is final");
  assert.equal((await call("PATCH", `/api/admin/orders/${ref}/payment`, { body: { paymentStatus: "paid" } })).status, 200);
  assert.equal((await call("GET", "/api/admin/orders/" + ref)).json.order.events.length, 6);
  const other = list.json.orders[0].reference;
  assert.equal((await call("PATCH", `/api/admin/orders/${other}/status`, { body: { status: "cancelled", note: "customer called" } })).status, 200);
  assert.equal((await call("PATCH", `/api/admin/orders/${other}/payment`, { body: { paymentStatus: "paid" } })).status, 409, "cancelled orders can't be paid");
  assert.equal((await call("PATCH", `/api/admin/orders/${ref}/status`, { body: { status: "bogus" } })).status, 400);
  assert.equal((await call("GET", "/api/admin/orders/NOPE")).status, 404);
});

test("dashboard and reports use real order rows and exclude cancelled", async () => {
  const all = (await call("GET", "/api/admin/orders?pageSize=100")).json.orders;
  const live = all.filter(o => o.status !== "cancelled"), sum = live.reduce((a, o) => a + o.total, 0);
  const rep = (await call("GET", "/api/admin/reports")).json;
  assert.equal(rep.totals.orders, all.length); assert.equal(rep.totals.sales, sum); assert.equal(rep.totals.cancelled, all.length - live.length); assert.equal(rep.totals.paidSales, live.filter(o => o.paymentStatus === "paid").reduce((a, o) => a + o.total, 0));
  assert.equal(rep.byDay.reduce((a, x) => a + x.sales, 0), sum); assert.ok(rep.popular.length > 0);
  assert.equal((await call("GET", "/api/admin/reports?from=2099-01-01&to=2099-01-02")).json.totals.orders, 0);
  assert.equal((await call("GET", "/api/admin/reports?from=2026-02-01&to=2026-01-01")).status, 400);
  const dash = (await call("GET", "/api/admin/dashboard")).json;
  assert.equal(dash.menu.total, 50); assert.equal(dash.menu.available + dash.menu.unavailable, 50); assert.equal(dash.orders.total, all.length); assert.equal(dash.sales.total, sum);
  assert.ok(dash.recentUpdates.length > 0);
});

test("settings validate input and flow to the public site", async () => {
  assert.equal((await call("PUT", "/api/admin/settings", { body: { phone: "abc" } })).status, 400);
  assert.equal((await call("PUT", "/api/admin/settings", { body: { mapsUrl: "javascript:alert(1)" } })).status, 400);
  assert.equal((await call("PUT", "/api/admin/settings", { body: { hours: { open: "25:00", close: "22:00" } } })).status, 400);
  assert.equal((await call("PUT", "/api/admin/settings", { body: { delivery: { enabled: true, freeAbove: -1, freeAboveBasis: "itemTotal", fee: 20, minOrder: 0, pincodes: [], confirmed: true } } })).status, 400);
  const r = await call("PUT", "/api/admin/settings", { body: { announcement: "Diwali special <b>today</b>", hours: { open: "10:00", close: "23:00" } } }); assert.equal(r.status, 200);
  const cfg = (await call("GET", "/api/public/config", { auth: false })).json; assert.equal(cfg.announcement, "Diwali special <b>today</b>"); assert.equal(cfg.hours.open, "10:00");
  const boot = (await call("GET", "/api/public/bootstrap.js", { auth: false })).text; assert.ok(!boot.includes("</script"), "bootstrap output is script-safe");
  assert.equal((await call("POST", "/api/admin/menu/categories", { body: { name: "Specials" } })).status, 201);
  assert.equal((await call("DELETE", "/api/admin/menu/categories/burgers")).status, 409, "non-empty category");
});

test("data survives a server restart", async () => {
  const before = (await call("GET", "/api/admin/orders")).json.total;
  await new Promise(r => server.close(r));
  server = await start({ port: 0, host: "127.0.0.1" }); base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await call("GET", "/api/admin/orders")).json.total, before, "orders persisted, and the session cookie still works because sessions are stored in the database");
  assert.equal((await call("GET", "/api/public/config", { auth: false })).json.hours.open, "10:00");
});

test("password change signs out other sessions; logout invalidates the session", async () => {
  const old = { cookie, csrf }; await login(); const second = { cookie, csrf }; Object.assign(globalThis, {});
  cookie = old.cookie; csrf = old.csrf;
  assert.equal((await call("POST", "/api/admin/password", { body: { currentPassword: "nope", newPassword: "Another-Strong-1!" } })).status, 400);
  assert.equal((await call("POST", "/api/admin/password", { body: { currentPassword: PASSWORD, newPassword: "weak" } })).status, 400);
  assert.equal((await call("POST", "/api/admin/password", { body: { currentPassword: PASSWORD, newPassword: "Another-Strong-1!" } })).status, 200);
  cookie = second.cookie; csrf = second.csrf; assert.equal((await call("GET", "/api/admin/dashboard")).status, 401, "other session ended");
  assert.equal((await login(EMAIL, PASSWORD)).status, 401); assert.equal((await login(EMAIL, "Another-Strong-1!")).status, 200);
  const saved = cookie, savedCsrf = csrf;
  assert.equal((await call("POST", "/api/admin/logout")).status, 200);
  cookie = saved; csrf = savedCsrf;
  assert.equal((await call("GET", "/api/admin/dashboard")).status, 401, "old cookie is dead after logout");
  assert.equal((await call("GET", "/admin")).status, 302);
});

test("brute force: account lockout and IP rate limit", async () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) assert.equal((await login(EMAIL, "Wrong-Password-" + i)).status, 401);
  const locked = await login(EMAIL, "Another-Strong-1!"); assert.equal(locked.status, 429, "even the right password is refused while locked");
  resetRateLimits();
  let hit = 0; for (let i = 0; i < 25; i++) { const r = await login("spray" + i + "@example.com", "x"); if (r.status === 429) hit++; }
  assert.ok(hit > 0, "IP rate limit kicks in");
});

test(".env files: trailing comments are ignored (regression: README's cp .env.example .env crashed the server)", () => {
  const f = path.join(tmp, "x.env"); fs.writeFileSync(f, "HOST=127.0.0.1   # comment here\nPORT=4567 # another\nQUOTED=\"a # b\"\nNODE_ENV=development # not production\n");
  const r = spawnSync("node", ["-e", "const c=require('./server/config');console.log(JSON.stringify([c.host,c.port,process.env.QUOTED,c.isProd]))"], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { PATH: process.env.PATH, ENV_FILE: f, DATABASE_PATH: path.join(tmp, "e.db"), VPC_QUIET: "1" } });
  assert.equal(r.stdout.trim(), '["127.0.0.1",4567,"a # b",false]', r.stderr);
  const ex = spawnSync("node", ["-e", "const c=require('./server/config');console.log(c.host+'|'+c.port)"], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { PATH: process.env.PATH, ENV_FILE: path.join(__dirname, "..", ".env.example"), DATABASE_PATH: path.join(tmp, "e2.db") } });
  assert.equal(ex.stdout.trim(), "127.0.0.1|3000", "the shipped .env.example parses cleanly");
});

test("private files are never served", async () => {
  for (const u of ["/.env", "/.env.example", "/package.json", "/server/config.js", "/server/db.js", "/seed/seed.json", "/data/t.db", "/scripts/create-admin.js", "/test/app.test.js", "/README.md", "/admin/index.html", "/admin/login.html", "/admin/assets/ui.js", "/.git/config", "/%2e%2e/package.json", "/..%2fpackage.json"]) {
    const r = await call("GET", u, { auth: false }); assert.ok([301, 302, 401, 404].includes(r.status) && !/SESSION_SECRET|scrypt|require\(/.test(r.text), `${u} -> ${r.status}`);
  }
  assert.equal((await call("GET", "/api/admin/session", { auth: false })).json.authenticated, false);
  assert.equal((await call("DELETE", "/", { auth: false })).status, 405);
  resetRateLimits();
  const bad = await call("POST", "/api/orders", { auth: false, raw: "{not json", headers: { "content-type": "application/json" } });
  assert.equal(bad.status, 400, "malformed JSON is a clean 400, not a crash"); assert.ok(bad.json.message);
  assert.equal((await call("POST", "/api/orders", { auth: false, raw: "x", headers: { "content-type": "text/plain" } })).status, 415);
});
