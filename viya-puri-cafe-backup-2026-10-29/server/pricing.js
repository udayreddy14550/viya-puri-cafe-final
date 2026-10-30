"use strict";
/* Authoritative price, coupon and delivery calculation. The browser's numbers are never trusted. */
const { db, getSettings } = require("./db");
const { HttpError } = require("./http");

const money = n => "₹" + n;
const localDate = (tz, d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function couponUsage(code, phone) {
  const total = db.prepare("SELECT COUNT(*) n FROM orders WHERE coupon_code = ? AND status != 'cancelled'").get(code).n;
  const byPhone = phone ? db.prepare("SELECT COUNT(*) n FROM orders WHERE coupon_code = ? AND status != 'cancelled' AND customer_phone = ?").get(code, phone).n : 0;
  return { total, byPhone };
}

/** Is this coupon usable right now? (used by the public bootstrap to hide exhausted coupons) */
function couponUsable(c, tz) {
  if (!c.active) return false;
  const today = localDate(tz);
  if (c.starts_on && today < c.starts_on) return false;
  if (c.expires_on && today > c.expires_on) return false;
  if (c.usage_limit != null && couponUsage(c.code).total >= c.usage_limit) return false;
  return true;
}

function discountFor(c, subtotal) {
  let d = c.type === "percent" ? Math.round(subtotal * c.value / 100) : c.value;
  if (c.max_discount != null) d = Math.min(d, c.max_discount);
  return Math.max(0, Math.min(d, subtotal));
}

/** Returns {ok:true, coupon, discount} or {ok:false, message}. */
function evaluateCoupon(rawCode, subtotal, { phone } = {}) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: true, coupon: null, discount: 0 };
  const s = getSettings();
  const c = db.prepare("SELECT * FROM coupons WHERE code = ?").get(code);
  if (!c || !c.active) return { ok: false, message: "That coupon code isn't valid." };
  const today = localDate(s.timezone);
  if (c.starts_on && today < c.starts_on) return { ok: false, message: `${c.code} isn't active yet. It starts on ${c.starts_on}.` };
  if (c.expires_on && today > c.expires_on) return { ok: false, message: "That coupon has expired." };
  if (subtotal < c.min_order) return { ok: false, message: `${c.code} needs an item total of at least ${money(c.min_order)}.` };
  const use = couponUsage(c.code, phone);
  if (c.usage_limit != null && use.total >= c.usage_limit) return { ok: false, message: "That coupon has reached its usage limit." };
  if (c.per_customer_limit != null && phone && use.byPhone >= c.per_customer_limit) return { ok: false, message: "You have already used this coupon." };
  return { ok: true, coupon: c, discount: discountFor(c, subtotal) };
}

function deliveryFee(settings, mode, subtotal, afterDiscount) {
  const d = settings.delivery;
  const basis = d.freeAboveBasis === "itemTotal" ? subtotal : afterDiscount;
  return basis > d.freeAbove ? 0 : d.fee;
}

/**
 * Build a quote from cart lines [{id,size,qty}] using DB prices.
 * Throws HttpError for unknown/sold-out items or bad quantities.
 */
function quote({ items, mode, coupon, phone }) {
  const s = getSettings();
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, "Your cart is empty.");
  if (items.length > 60) throw new HttpError(400, "That is too many different items for one order.");
  if (mode !== "delivery") throw new HttpError(400, "We deliver only. Choose delivery.");
  if (!s.delivery.enabled) throw new HttpError(400, "Delivery is not available right now.");

  const merged = new Map();
  for (const it of items) {
    if (!it || typeof it.id !== "string" || typeof it.size !== "string") throw new HttpError(400, "One of the cart items is invalid.");
    const qty = it.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, "Each item quantity must be between 1 and 20.");
    const k = it.id + "|" + it.size;
    merged.set(k, Math.min(20, (merged.get(k) || 0) + qty));
  }
  const q = db.prepare(`SELECT i.id, i.name, i.available, c.name AS category, z.size_id, z.label, z.price
    FROM menu_items i JOIN categories c ON c.id = i.category_id JOIN item_sizes z ON z.item_id = i.id WHERE i.id = ? AND z.size_id = ?`);
  const lines = [];
  for (const [k, qty] of merged) {
    const [id, size] = k.split("|");
    const r = q.get(id, size);
    if (!r) throw new HttpError(409, "An item in your cart is no longer on the menu. Please refresh the page and review your cart.", { code: "ITEM_GONE" });
    if (!r.available) throw new HttpError(409, `${r.name} is sold out. Remove it from your cart to continue.`, { code: "SOLD_OUT" });
    lines.push({ item_id: r.id, item_name: r.name, category_name: r.category, size_id: r.size_id, size_label: r.label, unit_price: r.price, qty, line_total: r.price * qty });
  }
  const subtotal = lines.reduce((a, l) => a + l.line_total, 0);
  if (subtotal < s.delivery.minOrder) throw new HttpError(400, `The minimum order for delivery is ${money(s.delivery.minOrder)}.`);
  const cp = evaluateCoupon(coupon, subtotal, { phone });
  if (!cp.ok) throw new HttpError(400, cp.message, { code: "COUPON" });
  const after = subtotal - cp.discount;
  const fee = deliveryFee(s, mode, subtotal, after);
  return { lines, subtotal, discount: cp.discount, coupon: cp.coupon, fee, total: after + fee };
}

module.exports = { evaluateCoupon, couponUsable, couponUsage, discountFor, deliveryFee, quote, localDate, money };
