"use strict";
const crypto = require("node:crypto");
const { db, tx, now, getSettings } = require("../db");
const { HttpError, bad, send, json, readJson, clientIp, v } = require("../http");
const { rateLimit, checkSameOrigin: checkOrigin } = require("../security");
const { quote, evaluateCoupon, couponUsable } = require("../pricing");
const { publishNewOrder, publishOrderCancellation } = require("../order-events");

/* ---------- shaping data for the customer site (same shapes the original page used) ---------- */
function publicMenu() {
  const cats = db.prepare("SELECT id, name FROM categories ORDER BY sort_order, name").all();
  const sizes = new Map();
  for (const z of db.prepare("SELECT item_id, size_id, label, price FROM item_sizes ORDER BY item_id, sort_order").all()) {
    if (!sizes.has(z.item_id)) sizes.set(z.item_id, []);
    sizes.get(z.item_id).push({ id: z.size_id, label: z.label, price: z.price });
  }
  const items = db.prepare(`SELECT i.*, c.name AS cat FROM menu_items i JOIN categories c ON c.id = i.category_id ORDER BY c.sort_order, c.name, i.sort_order, i.name`).all()
    .map(i => ({ id: i.id, cat: i.cat, name: i.name, description: i.description || "", veg: !!i.veg, sizes: sizes.get(i.id) || [], img: i.image_url || null, tint: i.tint, available: !!i.available, photoType: i.photo_type }))
    .filter(i => i.sizes.length);
  return { categories: cats, items };
}

function publicConfig() {
  const s = getSettings();
  const coupons = db.prepare("SELECT * FROM coupons WHERE active = 1 ORDER BY code").all()
    .filter(c => couponUsable(c, s.timezone))
    .map(c => ({ code: c.code, active: true, type: c.type, percent: c.type === "percent" ? c.value : undefined, amount: c.type === "flat" ? c.value : undefined, max: c.max_discount, min: c.min_order, starts: c.starts_on, expires: c.expires_on, description: c.description }));
  return {
    name: s.name, tagline: s.tagline, announcement: s.announcement, address: s.address, phone: s.phone, phoneDisplay: s.phoneDisplay, whatsapp: s.whatsapp,
    mapsUrl: s.mapsUrl, social: s.social, timezone: s.timezone, hours: s.hours, prepMinutes: s.prepMinutes, delivery: s.delivery,
    coupons, featured: s.featured, newItems: s.newItems, bestsellers: s.bestsellers, gallery: s.gallery, reviews: s.reviews,
    apiBase: "/api", orderingEnabled: !!s.orderingEnabled, contactEnabled: !!s.contactEnabled,
    payments: [{ id: "cod", label: "Cash on delivery" }],
  };
}

const jsSafe = o => JSON.stringify(o).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/</g, "\\u003c");

function bootstrap(req, res) {
  const body = `window.VPC_CONFIG=${jsSafe(publicConfig())};\nwindow.VPC_MENU=${jsSafe(publicMenu())};\n`;
  const etag = '"' + crypto.createHash("sha1").update(body).digest("base64url") + '"';
  const headers = { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", ETag: etag };
  if (req.headers["if-none-match"] === etag) return send(res, 304, "", headers);
  send(res, 200, body, headers);
}

/* ---------- order helpers ---------- */
const normPhone = raw => {
  let d = String(raw ?? "").replace(/[\s\-().]/g, "");
  if (/^\+?91\d{10}$/.test(d)) d = d.replace(/^\+?91/, "");   // only strip 91 when a full 10-digit number follows
  else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  return d;
};
const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newReference() {
  const d = new Date(Date.now() + 5.5 * 3600e3);   // date part in IST for readability
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, "");
  let tail = ""; for (const b of crypto.randomBytes(4)) tail += REF_CHARS[b % REF_CHARS.length];
  return `VPC-${ymd}-${tail}`;
}

function orderConfirmation(order, duplicate) {
  return {
    reference: order.reference,
    createdAt: order.created_at,
    total: order.total,
    subtotal: order.subtotal,
    discount: order.discount,
    deliveryFee: order.delivery_fee,
    orderStatus: order.status,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    mode: order.mode,
    address: order.mode === "delivery" ? {
      line: order.address_line, locality: order.locality, landmark: order.landmark, pincode: order.pincode,
    } : null,
    items: db.prepare("SELECT item_name name, size_label size, unit_price unitPrice, qty, line_total lineTotal FROM order_items WHERE order_id = ? ORDER BY id").all(order.id),
    duplicate,
  };
}
function existingOrderConfirmation(clientKey) {
  const order = db.prepare("SELECT * FROM orders WHERE client_key = ?").get(clientKey);
  return order ? orderConfirmation(order, true) : null;
}

function placeOrder(body, ip) {
  const s = getSettings();
  const clientKey = v.str(body.clientKey, "clientKey", { min: 8, max: 80, pattern: /^[A-Za-z0-9._-]+$/ });
  const mode = v.oneOf(body.mode, "mode", ["delivery"]);
  const payment = body.payment == null ? "cod" : body.payment;
  if (payment !== "cod") throw bad("Only cash on delivery is available right now.", "payment");
  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const name = v.str(customer.name, "Name", { min: 2, max: 80 });
  const phone = normPhone(customer.phone);
  if (!/^[6-9]\d{9}$/.test(phone)) throw bad("Enter a valid 10-digit Indian mobile number.", "phone");
  let addr;
  {
    const a = body.address && typeof body.address === "object" ? body.address : {};
    addr = {
      line: v.str(a.line, "Address", { min: 5, max: 200, multiline: true }),
      locality: v.str(a.locality, "Locality", { min: 2, max: 80 }),
      landmark: v.str(a.landmark, "Landmark", { max: 80, optional: true }),
      pincode: v.str(a.pincode, "Pincode", { pattern: /^\d{6}$/, msg: "Enter a 6-digit pincode." }),
    };
    if (s.delivery.pincodes.length && !s.delivery.pincodes.includes(addr.pincode)) throw bad("Sorry, we do not deliver to this pincode yet. Please call us to check.", "pincode");
  }
  const note = v.str(body.note, "Note", { max: 300, multiline: true, optional: true });
  const expected = body.expectedTotal == null ? null : v.int(body.expectedTotal, "expectedTotal", { min: 0, max: 1e7 });
  const itemsIn = v.arr(body.items, "items", { max: 60 }).map(i => ({ id: i && i.id, size: i && i.size, qty: i && i.qty }));

  return tx(() => {
    const dup = db.prepare("SELECT * FROM orders WHERE client_key = ?").get(clientKey);
    if (dup) return { status: 200, out: orderConfirmation(dup, true), eventId: null };
    const q = quote({ items: itemsIn, mode, coupon: body.coupon, phone });
    if (expected !== null && expected !== q.total) throw new HttpError(409, `The total changed to ₹${q.total} because prices, delivery or offers were updated. Please review your cart and try again.`, { code: "PRICE_CHANGED", total: q.total });
    const t = now();
    let reference;
    for (let i = 0; i < 6; i++) { reference = newReference(); if (!db.prepare("SELECT 1 FROM orders WHERE reference = ?").get(reference)) break; }
    const info = db.prepare(`INSERT INTO orders(reference, client_key, status, mode, payment_method, payment_status, customer_name, customer_phone,
        address_line, locality, landmark, pincode, note, subtotal, discount, delivery_fee, total, coupon_code, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(reference, clientKey, "pending", mode, "cod", "unpaid", name, phone, addr.line, addr.locality, addr.landmark, addr.pincode, note,
        q.subtotal, q.discount, q.fee, q.total, q.coupon ? q.coupon.code : null, t, t);
    const orderId = Number(info.lastInsertRowid);
    const ins = db.prepare("INSERT INTO order_items(order_id, item_id, item_name, category_name, size_id, size_label, unit_price, qty, line_total) VALUES(?,?,?,?,?,?,?,?,?)");
    for (const l of q.lines) ins.run(orderId, l.item_id, l.item_name, l.category_name, l.size_id, l.size_label, l.unit_price, l.qty, l.line_total);
    const event = db.prepare("INSERT INTO order_events(order_id, created_at, actor, kind, from_value, to_value, note) VALUES(?,?,?,?,?,?,?)")
      .run(orderId, t, "customer", "created", null, "pending", null);
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    return { status: 201, out: orderConfirmation(order, false), eventId: Number(event.lastInsertRowid) };
  });
}

function shapeCustomerOrder(order, withTimeline = false) {
  return {
    id: order.id, reference: order.reference, status: order.status, mode: order.mode,
    paymentMethod: order.payment_method, paymentStatus: order.payment_status,
    customer: { name: order.customer_name, phone: order.customer_phone },
    address: order.mode === "delivery" ? {
      line: order.address_line, locality: order.locality, landmark: order.landmark, pincode: order.pincode,
    } : null,
    subtotal: order.subtotal, discount: order.discount, deliveryFee: order.delivery_fee, total: order.total,
    coupon: order.coupon_code, createdAt: order.created_at, updatedAt: order.updated_at,
    items: db.prepare("SELECT item_name name, category_name category, size_label size, unit_price unitPrice, qty, line_total lineTotal FROM order_items WHERE order_id = ? ORDER BY id").all(order.id),
    ...(withTimeline ? { timeline: db.prepare(`SELECT created_at createdAt, kind, from_value 'from', to_value 'to'
      FROM order_events WHERE order_id = ? ORDER BY id`).all(order.id) } : {}),
  };
}

/* ---------- registration ---------- */
function register(router) {
  router.get("/api/health", (ctx) => json(ctx.res, 200, { ok: true }));
  router.get("/api/public/bootstrap.js", (ctx) => bootstrap(ctx.req, ctx.res));
  router.get("/api/public/menu", (ctx) => json(ctx.res, 200, publicMenu(), { "Cache-Control": "no-cache" }));
  router.get("/api/public/config", (ctx) => json(ctx.res, 200, publicConfig(), { "Cache-Control": "no-cache" }));
  router.post("/api/customer/orders/lookup", async (ctx) => {
    checkOrigin(ctx.req);
    const body = await readJson(ctx.req, 4096);
    const phone = normPhone(v.str(body.phone, "Mobile number", { min: 10, max: 16 }));
    if (!/^[6-9]\d{9}$/.test(phone)) throw bad("Enter a valid 10-digit Indian mobile number.", "phone");
    const page = v.int(body.page == null ? 1 : body.page, "Page", { min: 1, max: 10000 });
    const ip = clientIp(ctx.req);
    const phoneHash = crypto.createHash("sha256").update(phone).digest("hex");
    rateLimit("customer-order-phone-ip:" + ip, 40, 15 * 60e3);
    rateLimit("customer-order-phone:" + phoneHash, 10, 30 * 60e3);
    const pageSize = 10;
    const total = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE customer_phone = ?").get(phone).count;
    const rows = db.prepare("SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(phone, pageSize, (page - 1) * pageSize);
    json(ctx.res, 200, {
      orders: rows.map(order => shapeCustomerOrder(order, true)),
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
    }, { "Cache-Control": "no-store" });
  });
  router.post("/api/customer/orders/cancel", async (ctx) => {
    checkOrigin(ctx.req);
    const body = await readJson(ctx.req, 4096);
    const phone = normPhone(v.str(body.phone, "Mobile number", { min: 10, max: 16 }));
    if (!/^[6-9]\d{9}$/.test(phone)) throw bad("Enter a valid 10-digit Indian mobile number.", "phone");
    const reference = v.str(body.reference, "Order reference", { min: 15, max: 20, pattern: /^VPC-\d{6}-[A-Z2-9]{4}$/ });
    const ip = clientIp(ctx.req), phoneHash = crypto.createHash("sha256").update(phone).digest("hex");
    rateLimit("customer-order-cancel-ip:" + ip, 20, 15 * 60e3);
    rateLimit("customer-order-cancel-phone:" + phoneHash, 8, 30 * 60e3);
    const result = tx(() => {
      const order = db.prepare("SELECT id, reference, customer_phone, status, total FROM orders WHERE reference = ?").get(reference);
      if (!order || order.customer_phone !== phone) throw new HttpError(404, "We could not find a matching order for this mobile number.");
      if (order.status === "cancelled") return { cancelled: true, duplicate: true, eventId: null, reference: order.reference, total: order.total };
      if (order.status !== "pending") throw new HttpError(409, "Only Pending orders can be cancelled online. Please contact the café for help.");
      const t = now();
      const updated = db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'").run(t, order.id);
      if (!updated.changes) throw new HttpError(409, "This order has changed and can no longer be cancelled online. Please check its latest status.");
      const event = db.prepare("INSERT INTO order_events(order_id, created_at, actor, kind, from_value, to_value, note) VALUES(?,?,?,?,?,?,?)")
        .run(order.id, t, "customer", "customer_cancelled", "pending", "cancelled", null);
      return { cancelled: true, duplicate: false, eventId: Number(event.lastInsertRowid), reference: order.reference, total: order.total };
    });
    if (result.eventId) publishOrderCancellation(result.eventId, result.reference, result.total);
    json(ctx.res, 200, { cancelled: result.cancelled, duplicate: result.duplicate, reference: result.reference }, { "Cache-Control": "no-store" });
  });
  router.post("/api/orders", async (ctx) => {
    const ip = clientIp(ctx.req);
    rateLimit("order:" + ip, 12, 10 * 60e3);
    const body = await readJson(ctx.req);
    const clientKey = typeof body.clientKey === "string" && body.clientKey.length >= 8 && body.clientKey.length <= 80 && /^[A-Za-z0-9._-]+$/.test(body.clientKey)
      ? body.clientKey : null;
    const recovered = clientKey && existingOrderConfirmation(clientKey);
    if (recovered) { json(ctx.res, 200, recovered); return; }
    const s = getSettings();
    if (!s.orderingEnabled) throw new HttpError(503, "Online ordering is not switched on yet. Please call us to order.", { code: "ORDERING_OFF" });
    const { status, out, eventId } = placeOrder(body, ip);
    if (eventId) publishNewOrder(eventId, out.reference, out.total);
    json(ctx.res, status, out);
  });

  router.post("/api/coupons/validate", async (ctx) => {
    rateLimit("coupon:" + clientIp(ctx.req), 40, 10 * 60e3);
    const body = await readJson(ctx.req);
    const phone = body.phone ? normPhone(body.phone) : undefined;
    const q = quote({ items: v.arr(body.items, "items", { max: 60 }).map(i => ({ id: i && i.id, size: i && i.size, qty: i && i.qty })), mode: body.mode, coupon: body.code, phone });
    json(ctx.res, 200, { valid: !!q.coupon, code: q.coupon ? q.coupon.code : null, discount: q.discount, subtotal: q.subtotal, deliveryFee: q.fee, total: q.total });
  });

  router.post("/api/contact", async (ctx) => {
    const ip = clientIp(ctx.req);
    rateLimit("contact:" + ip, 5, 60 * 60e3);
    if (!getSettings().contactEnabled) throw new HttpError(503, "The message form is not switched on yet. Please call us.", { code: "CONTACT_OFF" });
    const b = await readJson(ctx.req);
    const name = v.str(b.name, "Name", { min: 2, max: 80 });
    const contact = v.str(b.contact, "Phone or email", { min: 5, max: 120 });
    const message = v.str(b.message, "Message", { min: 5, max: 1500, multiline: true });
    const n = db.prepare("SELECT COUNT(*) n FROM messages WHERE created_at > ?").get(new Date(Date.now() - 24 * 3600e3).toISOString()).n;
    if (n >= 200) throw new HttpError(429, "We are receiving too many messages right now. Please call us instead.");
    db.prepare("INSERT INTO messages(name, contact, message, ip, created_at) VALUES(?,?,?,?,?)").run(name, contact, message, ip.slice(0, 64), now());
    json(ctx.res, 201, { ok: true });
  });
}

module.exports = { register, publicMenu, publicConfig, normPhone };
