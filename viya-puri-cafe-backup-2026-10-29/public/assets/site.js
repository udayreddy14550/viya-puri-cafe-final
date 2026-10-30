(() => {
"use strict";
if (!window.VPC_CONFIG || !window.VPC_MENU) {
  document.body.insertAdjacentHTML("afterbegin", '<div style="padding:24px;text-align:center;font:600 1rem system-ui">The menu is temporarily unavailable. Please call us or try again in a moment.</div>');
  return;
}
const CFG = window.VPC_CONFIG, MENU = window.VPC_MENU;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "₹" + n;
const ITEMS = new Map(MENU.items.map(i => [i.id, i]));
const PHOTO_FOCUS = {
  "mocktails--blue-curacao": "center 35%",
  "mocktails--green-mojito": "center 30%",
  "mocktails--green-apple-mojito": "center 50%",
  "mocktails--strawberry": "center 40%",
  "mocktails--bubble-gum": "center 35%",
  "mocktails--orange": "center 50%",
  "mocktails--watermelon": "center 40%",
  "mocktails--lime-mint": "center 35%",
  "mocktails--blueberry": "center 35%",
  "burgers--classic-veg-burger": "center 55%",
  "burgers--classic-cheese-veg-burger": "center 50%",
  "burgers--chicken-burger": "center 50%",
  "burgers--chicken-cheese-burger": "center 50%",
  "burgers--aloo-tikki-burger": "center 50%",
  "pani-puri-chaat--pani-puri": "center 50%",
  "pani-puri-chaat--masala-puri": "center 50%",
  "pani-puri-chaat--sev-puri": "center 50%",
  "pani-puri-chaat--dahi-puri": "center 50%",
  "pani-puri-chaat--chat": "center 50%",
  "pani-puri-chaat--dahi-chat": "center 50%",
  "pani-puri-chaat--pav-bhaaji": "center 55%",
  "desserts--butterscotch": "center 50%",
  "desserts--chocolate": "center 50%",
  "desserts--strawberry": "center 45%",
  "desserts--american-nuts": "center 50%",
  "desserts--belgium-choco": "center 40%",
  "thick-shakes--butterscotch-shake": "center 50%",
  "thick-shakes--strawberry-shake": "center 40%",
  "thick-shakes--black-currant-shake": "center 40%",
  "thick-shakes--oreo-shake": "center 25%",
  "thick-shakes--kitkat-shake": "center 25%",
  "thick-shakes--chocolate-shake": "center 45%",
  "thick-shakes--belgium-shake": "center 30%",
  "lassi--sweet-lassi": "center 50%",
  "lassi--butterscotch-lassi": "center 55%",
  "lassi--black-currant-lassi": "center 50%",
  "lassi--mango-lassi": "center 40%",
  "lassi--strawberry-lassi": "center 45%",
  "lassi--rose-lassi": "center 45%",
  "lassi--watermelon-lassi": "center 45%",
  "beverages--milk": "center 40%",
  "beverages--tea": "center 55%",
  "beverages--lemon-tea": "center 55%",
  "beverages--green-tea": "center 100%",
  "beverages--ginger-tea": "center 50%",
  "beverages--sonti-tea": "center 55%",
  "beverages--ilachi-tea": "center 50%",
  "beverages--rose-milk": "center 50%",
  "beverages--coffee": "center 55%",
  "beverages--chocolate-milk": "center 50%"
};
const CAT_NAME = new Map(MENU.categories.map(c => [c.id, c.name]));
const STORE = "vpc.cart.v2";
const PENDING_ORDER_KEY = "vpc.pendingOrderKey";
const state = { cat: "all", q: "", sel: {}, cart: {}, coupon: "", couponMsg: "", mode: "delivery", confirmClear: false };
const account = { busy: false, loading: false, searched: false, error: "", cancelMessage: "", cancelingReference: null, phone: "", orders: [], page: 1, pages: 0, total: 0, selectedReference: null };

/* ---------- storage (cart saved in this browser; validated on load) ---------- */
function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "{}"), out = {};
    for (const [k, q] of Object.entries(raw.cart || raw)) {
      const [id, sid] = k.split("|"), it = ITEMS.get(id);
      if (it && it.sizes.some(s => s.id === sid) && Number.isInteger(q) && q > 0) out[k] = Math.min(q, 20);
    }
    state.cart = out;
  } catch (e) { state.cart = {}; }
}
function saveCart() { try { localStorage.setItem(STORE, JSON.stringify({ cart: state.cart, mode: state.mode })); } catch (e) {} }

/* ---------- helpers ---------- */
const key = (id, sid) => id + "|" + sid;
const sizeOf = (it, sid) => it.sizes.find(s => s.id === sid) || it.sizes[0];
const curSize = it => sizeOf(it, state.sel[it.id]);
const fmtTime = hhmm => { const [h, m] = hhmm.split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM"); };
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("on"), 2200); }
const phoneNorm = v => { let d = String(v).replace(/[\s\-()]/g, ""); if (/^\+?91\d{10}$/.test(d)) d = d.replace(/^\+?91/, ""); else if (/^0\d{10}$/.test(d)) d = d.slice(1); return d; };
const validPhone = d => /^[6-9]\d{9}$/.test(d);

/* ---------- opening hours in the café's timezone ---------- */
function nowInTz() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  return (+p.find(x => x.type === "hour").value % 24) * 60 + +p.find(x => x.type === "minute").value;
}
function hoursStatus() {
  const [oh, om] = CFG.hours.open.split(":").map(Number), [ch, cm] = CFG.hours.close.split(":").map(Number);
  const o = oh * 60 + om, c = ch * 60 + cm, n = nowInTz();
  const open = o < c ? n >= o && n < c : n >= o || n < c;
  return open ? { open, text: "Open now · until " + fmtTime(CFG.hours.close) }
    : { open, text: "Closed now · opens " + (n < o ? "today " : "tomorrow ") + fmtTime(CFG.hours.open) };
}
function updateStatus() { const s = hoursStatus(), e = $("#status"); e.textContent = s.text; e.dataset.open = s.open; }

/* ---------- pricing ---------- */
function couponCheck(code, sub) {
  if (!code) return { disc: 0, msg: "" };
  const c = CFG.coupons.find(x => x.code === code && x.active);
  if (!c) return { disc: 0, msg: "That coupon code isn't valid.", bad: true };
  if (c.starts && new Date(c.starts + "T00:00:00+05:30") > new Date()) return { disc: 0, msg: `${c.code} is not active yet.`, bad: true };
  if (c.expires && new Date(c.expires + "T23:59:59+05:30") < new Date()) return { disc: 0, msg: "That coupon has expired.", bad: true };
  if (sub < c.min) return { disc: 0, msg: `${c.code} needs an item total of at least ${money(c.min)}.`, bad: true };
  const raw = c.type === "flat" ? c.amount : Math.round(sub * c.percent / 100);
  return { disc: Math.max(0, Math.min(raw, c.max == null ? Infinity : c.max, sub)), msg: "" };
}
function lines() {
  return Object.entries(state.cart).map(([k, qty]) => {
    const [id, sid] = k.split("|"), it = ITEMS.get(id), sz = sizeOf(it, sid);
    return { k, it, sz, qty, total: sz.price * qty };
  });
}
function totals() {
  const L = lines(), sub = L.reduce((a, l) => a + l.total, 0), count = L.reduce((a, l) => a + l.qty, 0);
  const cp = couponCheck(state.coupon, sub), after = sub - cp.disc;
  const basis = CFG.delivery.freeAboveBasis === "itemTotal" ? sub : after;
  const free = basis > CFG.delivery.freeAbove;
  const fee = !count ? 0 : (free ? 0 : CFG.delivery.fee);
  return { L, sub, count, disc: cp.disc, couponMsg: cp.msg, couponBad: cp.bad, fee, free, total: after + fee, toFree: Math.max(0, CFG.delivery.freeAbove + 1 - basis), soldOut: L.filter(l => !l.it.available), belowMin: state.mode === "delivery" && sub < CFG.delivery.minOrder };
}

/* ---------- photos ---------- */
function photoHTML(it, eager) {
  const ph = `<div class="ph">${esc(it.name)}<br><span class="fine" style="font-weight:500">Photo coming soon</span></div>`;
  return it.img ? `<img src="${esc(it.img)}" alt="${esc(it.name)}" style="object-position:${PHOTO_FOCUS[it.id] || "center 50%"}" ${eager ? "" : 'loading="lazy"'} width="600" height="600" data-photo>` + `<div class="ph" hidden>${esc(it.name)}</div>` : ph;
}
document.addEventListener("error", e => {
  const t = e.target;
  if (t.tagName === "IMG" && t.hasAttribute("data-photo")) { t.hidden = true; const ph = t.nextElementSibling; if (ph) ph.hidden = false; }
}, true);

/* ---------- menu cards ---------- */
function badgesFor(it) {
  const b = [];
  if (!it.available) b.push('<span class="badge sold">Sold out</span>');
  else {
    if (CFG.bestsellers.includes(it.id)) b.push('<span class="badge">Bestseller</span>');
    if (CFG.newItems.includes(it.id)) b.push('<span class="badge">New</span>');
    if (CFG.featured.includes(it.id)) b.push('<span class="badge">Featured</span>');
  }
  return b.join("");
}
function cardHTML(it) {
  const sz = curSize(it), k = key(it.id, sz.id), q = state.cart[k] || 0;
  const sizes = it.sizes.length > 1 ? `<div class="sizes" role="group" aria-label="Size for ${esc(it.name)}">${it.sizes.map(s => `<button type="button" class="size" data-size="${esc(s.id)}" data-item="${esc(it.id)}" aria-pressed="${s.id === sz.id}">${esc(s.label)}<br>${money(s.price)}</button>`).join("")}</div>` : "";
  const buy = !it.available ? `<span class="fine" style="font-weight:600">Currently unavailable</span>`
    : q ? `<div class="qty" role="group" aria-label="Quantity of ${esc(it.name)}"><button type="button" data-qty="${esc(k)}" data-d="-1" aria-label="Decrease ${esc(it.name)}">−</button><output>${q}</output><button type="button" data-qty="${esc(k)}" data-d="1" aria-label="Increase ${esc(it.name)}">+</button></div>`
    : `<button type="button" class="btn btn-primary btn-sm" data-add="${esc(k)}" aria-label="Add ${esc(it.name)}${it.sizes.length > 1 ? ", " + esc(sz.label) : ""} to cart">Add</button>`;
  return `<article class="card" data-card="${esc(it.id)}" data-sold="${!it.available}" style="--tint:${esc(it.tint)}">
    <div class="photo">${photoHTML(it)}<div class="badges">${badgesFor(it)}</div></div>
    <div class="card-body">
      <h3><span class="vd ${it.veg ? "" : "nv"}" role="img" aria-label="${it.veg ? "Vegetarian" : "Non-vegetarian"}"></span>${esc(it.name)}</h3>
      ${sizes}
      <div class="buy"><span class="price">${money(sz.price)}</span>${buy}</div>
    </div></article>`;
}
function refreshCards(id, focusSel) {
  const it = ITEMS.get(id), host = document.activeElement && document.activeElement.closest("#grid,#featGrid");
  $$(`[data-card="${CSS.escape(id)}"]`).forEach(el => { el.outerHTML = cardHTML(it); });
  if (focusSel) { const root = host ? document.getElementById(host.id) : document; const f = $(focusSel, root) || $(focusSel); f && f.focus(); }
}
function renderMenu() {
  const q = state.q.trim().toLowerCase();
  const L = MENU.items.filter(i => (state.cat === "all" || CAT_NAME.get(state.cat) === i.cat) && (!q || (i.name + " " + i.cat).toLowerCase().includes(q)));
  $("#grid").innerHTML = L.length ? L.map(cardHTML).join("") : `<div class="empty"><strong>Nothing matches “${esc(state.q.trim())}”</strong>Try a different spelling, or clear the search and pick a category.<br><button class="btn btn-ghost btn-sm" type="button" data-clear-search style="margin-top:14px">Show all items</button></div>`;
  $("#menuCount").textContent = L.length + (L.length === 1 ? " item" : " items");
  $("#chips").innerHTML = [["all", "All"], ...MENU.categories.map(c => [c.id, c.name])].map(([id, n]) => `<button type="button" class="chip" data-cat="${esc(id)}" aria-pressed="${state.cat === id}">${esc(n)}</button>`).join("");
}

/* ---------- homepage sections ---------- */
function renderHome() {
  const bar = $("#announce"); if (CFG.announcement) { bar.textContent = CFG.announcement; bar.hidden = false; }
  const img = id => ITEMS.get(id);
  const collage = (ids, eagerFirst = false) => ids.map(id => img(id)).filter(it => it && it.img).map((it, index) => {
    const eager = eagerFirst && index === 0;
    return `<figure style="--tint:${esc(it.tint)}"><img src="${esc(it.img)}" alt="${esc(it.name)}" width="600" height="600" decoding="async" ${eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} data-photo><div class="ph" hidden>${esc(it.name)}</div></figure>`;
  }).join("");
  $("#heroCollage").innerHTML = collage([
    "pani-puri-chaat--dahi-puri",
    "burgers--classic-cheese-veg-burger",
    "thick-shakes--oreo-shake",
    "mocktails--green-apple-mojito"
  ], true);
  $("#aboutCollage").innerHTML = collage(["lassi--mango-lassi", "mocktails--blue-curacao", "pani-puri-chaat--pav-bhaaji"]);
  $("#heroFacts").innerHTML = `<span>Around ${CFG.prepMinutes} min to prepare</span><span>Open daily ${fmtTime(CFG.hours.open)} – ${fmtTime(CFG.hours.close)}</span>` + (CFG.delivery.enabled ? `<span>Home delivery</span>` : "");
  // categories
  $("#catGrid").innerHTML = MENU.categories.map(c => {
    const items = MENU.items.filter(i => i.cat === c.name), first = items.find(i => i.img);
    return `<button type="button" class="cat-tile" data-cat-jump="${esc(c.id)}" style="--tint:#e6c08e">${first ? `<img src="${esc(first.img)}" alt="" loading="lazy" width="600" height="600" data-photo>` : ""}<span>${esc(c.name)}<small>${items.length} items</small></span></button>`;
  }).join("");
  // featured
  const feat = CFG.featured.map(id => ITEMS.get(id)).filter(Boolean);
  if (feat.length) { $("#featured").hidden = false; $("#featGrid").innerHTML = feat.map(cardHTML).join(""); }
  // delivery
  const d = CFG.delivery;
  $("#delivText").textContent = d.enabled ? `Orders above ${money(d.freeAbove)} ship free. Below that, delivery is ${money(d.fee)}.` : "Delivery is not available right now. Please call us.";
  $("#delivNote").hidden = d.confirmed;
  $("#delivList").innerHTML = [`Around ${CFG.prepMinutes} minutes to prepare`, "Pay " + CFG.payments.map(p => p.label.toLowerCase()).join(" or ")].map(t => `<li>${esc(t)}</li>`).join("");
  $("#deliv-title").textContent = d.enabled ? `Free home delivery above ${money(d.freeAbove)}` : "Delivery paused right now";
  // offers
  const active = CFG.coupons.filter(c => c.active);
  $("#offerGrid").innerHTML =
    `<div class="offer"><h3>Free home delivery</h3><p>On every order above <b>${money(d.freeAbove)}</b>. Otherwise delivery is ${money(d.fee)}.</p></div>` +
    "" +
    active.map(c => `<div class="offer"><code>${esc(c.code)}</code><h3>${c.type === "flat" ? money(c.amount) : c.percent + "%"} off</h3><p>${c.type !== "flat" && c.max != null ? "Up to " + money(c.max) + " off on" : "Off"} orders of ${money(c.min)} or more${c.expires ? ", valid until " + esc(c.expires) : ""}. One coupon per order.</p></div>`).join("") +
    (active.length ? "" : `<div class="offer"><h3>Coupons</h3><p>No coupon codes are running right now. Check back soon.</p></div>`);
  // gallery & reviews
  if (CFG.gallery.length) { $("#gallery").hidden = false; $("#galleryGrid").innerHTML = CFG.gallery.map(g => `<img src="${esc(g.src)}" alt="${esc(g.alt || "Viya Puri Café")}" loading="lazy" data-photo>`).join(""); }
  if (CFG.reviews.length) { $("#reviews").hidden = false; $("#reviewGrid").innerHTML = CFG.reviews.map(r => `<figure class="review" style="margin:0"><blockquote style="margin:0 0 10px">“${esc(r.text)}”</blockquote><figcaption><b>${esc(r.name)}</b>${r.source ? " · " + esc(r.source) : ""}</figcaption></figure>`).join(""); }
  // contact + footer
  const addr = CFG.address.map(esc).join("<br>");
  $("#cAddr").innerHTML = addr; $("#fAddr").innerHTML = addr + " · " + esc(CFG.phoneDisplay);
  $("#cPhone").innerHTML = `<a href="tel:${esc(CFG.phone)}">${esc(CFG.phoneDisplay)}</a>`;
  $("#cHours").textContent = `Open daily ${fmtTime(CFG.hours.open)} – ${fmtTime(CFG.hours.close)}`;
  $("#cBtns").innerHTML = `<a class="btn btn-primary btn-sm" href="tel:${esc(CFG.phone)}">Call ${esc(CFG.phoneDisplay)}</a><a class="btn btn-ghost btn-sm" href="${esc(CFG.mapsUrl)}" target="_blank" rel="noopener">Get directions</a>` + (CFG.whatsapp ? `<a class="btn btn-ghost btn-sm" href="https://wa.me/${esc(CFG.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>` : "");
  const soc = [["Instagram", CFG.social.instagram], ["Facebook", CFG.social.facebook]].filter(s => s[1]);
  $("#fSocial").innerHTML = soc.map(s => `<a href="${esc(s[1])}" target="_blank" rel="noopener">${s[0]}</a>`).join(" · ");
  renderContactPanel();
}
function renderContactPanel() {
  const p = $("#contactPanel");
  if (!CFG.contactEnabled) { p.innerHTML = `<h3>Questions or feedback?</h3><p class="lead" style="font-size:1rem">Call us on <a href="tel:${esc(CFG.phone)}">${esc(CFG.phoneDisplay)}</a>${CFG.whatsapp ? " or message us on WhatsApp" : ""}. The online message form will be switched on once our inbox is connected.</p>`; return; }
  p.innerHTML = `<h3>Send us a message</h3><form id="contactForm" novalidate class="panel" style="padding:0;border:0;background:none">
    <div class="field"><label for="cfName">Name</label><input id="cfName" autocomplete="name" required></div>
    <div class="field"><label for="cfContact">Phone or email</label><input id="cfContact" autocomplete="tel" required></div>
    <div class="field"><label for="cfMsg">Message</label><textarea id="cfMsg" required></textarea></div>
    <div class="hp" aria-hidden="true"><label for="cfWeb">Leave blank</label><input id="cfWeb" tabindex="-1" autocomplete="off"></div>
    <div id="cfOut" role="status"></div><button class="btn btn-primary" type="submit" id="cfBtn">Send message</button></form>`;
}
async function sendContact(form) {
  const out = $("#cfOut"), btn = $("#cfBtn"), v = id => $("#" + id).value.trim();
  if ($("#cfWeb").value) return;
  if (v("cfName").length < 2 || v("cfContact").length < 5 || v("cfMsg").length < 5) { out.innerHTML = '<p class="err">Please fill in your name, a phone or email, and a message.</p>'; return; }
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const r = await fetch(CFG.apiBase + "/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v("cfName"), contact: v("cfContact"), message: v("cfMsg") }) });
    if (!r.ok) throw new Error();
    form.reset(); out.innerHTML = '<p class="notice ok">Thanks. We received your message.</p>';
  } catch (e) { out.innerHTML = '<p class="notice bad">We could not send your message. Please try again or call us.</p>'; }
  btn.disabled = false; btn.textContent = "Send message";
}

/* ---------- cart ---------- */
function setQty(k, d) {
  const n = Math.max(0, Math.min(20, (state.cart[k] || 0) + d));
  if (n) state.cart[k] = n; else delete state.cart[k];
  saveCart(); updateBadge();
}
function updateBadge() {
  const n = Object.values(state.cart).reduce((a, b) => a + b, 0);
  const c = $("#cartCount"); c.textContent = n; c.hidden = !n;
  const t = $("#tabCount"); t.textContent = n; t.hidden = !n;
}
function renderCart(focusSel) {
  const t = totals(); updateBadge();
  const body = $("#cartBody"), foot = $("#cartFoot");
  if (!t.count) {
    body.innerHTML = `<div class="center"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/></svg><b style="color:var(--brand);font:600 1.3rem var(--display)">Your cart is empty</b><span>Add something tasty from the menu.</span><button class="btn btn-primary" type="button" data-close-cart>Browse the menu</button></div>`;
    foot.innerHTML = ""; foot.hidden = true; return;
  }
  foot.hidden = false;
  body.innerHTML = t.L.map(l => `<div class="line" style="--tint:${esc(l.it.tint)}">
    ${l.it.img ? `<img src="${esc(l.it.img)}" alt="" width="64" height="64" data-photo>` : `<div class="thumb"></div>`}
    <div class="line-info"><b>${esc(l.it.name)}</b><small>${l.it.sizes.length > 1 ? esc(l.sz.label) + " · " : ""}${money(l.sz.price)} each</small>${l.it.available ? "" : `<small class="err" style="display:block">Sold out. Remove to continue.</small>`}
      <button class="link-btn" type="button" data-remove="${esc(l.k)}">Remove</button></div>
    <div class="line-end"><div class="qty" role="group" aria-label="Quantity of ${esc(l.it.name)}"><button type="button" data-qty="${esc(l.k)}" data-d="-1" aria-label="Decrease ${esc(l.it.name)}">−</button><output>${l.qty}</output><button type="button" data-qty="${esc(l.k)}" data-d="1" aria-label="Increase ${esc(l.it.name)}">+</button></div><b>${money(l.total)}</b></div></div>`).join("")
    + (state.confirmClear
      ? `<div class="notice" role="alert">Remove all items from your cart? <button class="link-btn" type="button" data-clear-yes>Yes, clear cart</button> · <button class="link-btn" type="button" data-clear-no>Keep items</button></div>`
      : `<div><button class="link-btn" type="button" data-clear>Clear cart</button></div>`);
  const hasCoupons = CFG.coupons.some(c => c.active);
  const modes = [];
  const hint = state.mode === "delivery" ? (t.free ? `<div class="notice ok">You get free home delivery.</div>` : `<div><div class="fine" style="margin-bottom:6px">Add ${money(t.toFree)} more for free delivery (above ${money(CFG.delivery.freeAbove)})</div><div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="${CFG.delivery.freeAbove}" aria-valuenow="${Math.min(CFG.delivery.freeAbove, t.sub - t.disc)}"><i style="width:${Math.min(100, (t.sub - t.disc) / CFG.delivery.freeAbove * 100)}%"></i></div></div>`) : "";
  foot.innerHTML = `
    ${modes.length > 1 ? `<div class="seg" role="group" aria-label="Order type">${modes.map(([id, n]) => `<button type="button" data-mode="${id}" aria-pressed="${state.mode === id}">${n}</button>`).join("")}</div>` : ""}
    ${hint}
    ${hasCoupons ? `<form class="coupon" id="couponForm"><label class="sr" for="cp">Coupon code</label><input id="cp" placeholder="Coupon code" value="${esc(state.coupon)}" autocomplete="off"><button class="btn btn-ghost btn-sm" type="submit">Apply</button></form>${t.couponMsg ? `<p class="err" role="alert">${esc(t.couponMsg)}</p>` : ""}` : ""}
    <div class="bill"><div><span>Item total</span><span>${money(t.sub)}</span></div>${t.disc ? `<div class="disc"><span>Discount (${esc(state.coupon)})</span><span>−${money(t.disc)}</span></div>` : ""}<div><span>Delivery fee</span><span>${t.fee ? money(t.fee) : "Free"}</span></div><div class="total"><span>To pay</span><span>${money(t.total)}</span></div></div>
    ${t.belowMin ? `<p class="err">Minimum order for delivery is ${money(CFG.delivery.minOrder)}.</p>` : ""}
    <button class="btn btn-primary btn-block" type="button" data-checkout ${t.soldOut.length || t.belowMin ? "disabled" : ""}>Checkout · ${money(t.total)}</button>`;
  if (focusSel) { const f = $(focusSel, $("#cartDlg")); f ? f.focus() : $("#cartTitle").focus(); }
}
function openCart() { renderCart(); const d = $("#cartDlg"); if (!d.open) d.showModal(); }
function closeCart() { $("#cartDlg").close(); }

/* ---------- checkout ---------- */
const co = { step: "details", data: {}, busy: false, error: "", done: null, idem: null, payload: null, uncertain: false };
function newOrderKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (crypto.getRandomValues) crypto.getRandomValues(bytes);
  else return String(Date.now()) + Math.random();
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function savePendingOrderKey(value) {
  try { sessionStorage.setItem(PENDING_ORDER_KEY, value); } catch {}
}
function clearPendingOrderKey() {
  try { sessionStorage.removeItem(PENDING_ORDER_KEY); } catch {}
}
function openCheckout() {
  const t = totals(); if (!t.count) return;
  if (!hoursStatus().open) toast("We are closed right now. You can still review your order.");
  co.step = "details"; co.error = ""; co.done = null; co.errs = {};
  co.payload = null; co.uncertain = false;
  if (!co.idem) {
    try {
      const saved = sessionStorage.getItem(PENDING_ORDER_KEY);
      if (saved && /^[A-Za-z0-9._-]{8,80}$/.test(saved)) co.idem = saved;
    } catch {}
    if (!co.idem) co.idem = newOrderKey();
    savePendingOrderKey(co.idem);
  }
  closeCart(); renderCheckout(); const d = $("#coDlg"); if (!d.open) d.showModal();
}
function readForm() {
  const g = id => { const e = $("#" + id); return e ? e.value.trim() : ""; };
  Object.assign(co.data, { name: g("coName"), phone: g("coPhone"), line: g("coLine"), locality: g("coLocality"), landmark: g("coLandmark"), pin: g("coPin"), note: g("coNote"), payment: g("coPay") });
}
function validateCo() {
  const d = co.data, e = {};
  if (d.name.length < 2) e.coName = "Enter your name.";
  if (!validPhone(phoneNorm(d.phone))) e.coPhone = "Enter a valid 10-digit Indian mobile number.";
  if (state.mode === "delivery") {
    if (d.line.length < 5) e.coLine = "Enter your house or street address.";
    if (d.locality.length < 2) e.coLocality = "Enter your locality.";
    if (!/^\d{6}$/.test(d.pin)) e.coPin = "Enter a 6-digit pincode.";
    else if (CFG.delivery.pincodes.length && !CFG.delivery.pincodes.includes(d.pin)) e.coPin = "Sorry, we do not deliver to this pincode yet. Please call us to check.";
  }
  co.errs = e; return !Object.keys(e).length;
}
const fld = (id, label, val, o = {}) => `<div class="field"><label for="${id}">${label}${o.opt ? ' <span class="hint">(optional)</span>' : ""}</label>${o.area ? `<textarea id="${id}" ${o.attr || ""}${co.errs[id] ? ' aria-invalid="true"' : ""}>${esc(val)}</textarea>` : `<input id="${id}" value="${esc(val)}" ${o.attr || ""}${co.errs[id] ? ' aria-invalid="true"' : ""}>`}${co.errs[id] ? `<span class="err" role="alert">${co.errs[id]}</span>` : ""}${o.hint ? `<span class="hint">${o.hint}</span>` : ""}</div>`;
function summaryHTML(t) {
  return `<div class="bill">${t.L.map(l => `<div><span>${l.qty} × ${esc(l.it.name)}${l.it.sizes.length > 1 ? " (" + esc(l.sz.label) + ")" : ""}</span><span>${money(l.total)}</span></div>`).join("")}
  <div style="border-top:1px solid var(--line);padding-top:8px"><span>Item total</span><span>${money(t.sub)}</span></div>${t.disc ? `<div class="disc"><span>Discount (${esc(state.coupon)})</span><span>−${money(t.disc)}</span></div>` : ""}
  <div><span>Delivery fee</span><span>${t.fee ? money(t.fee) : "Free"}</span></div><div class="total"><span>To pay</span><span>${money(t.total)}</span></div></div>`;
}
function renderCheckout() {
  const body = $("#coBody"), t = totals(), d = co.data;
  if (co.done) {
    const o = co.done, paymentLabel = CFG.payments.find(p => p.id === o.paymentMethod)?.label || o.paymentMethod;
    $("#coTitle").textContent = "Order confirmation";
    body.innerHTML = `<div class="order-confirmation">
      <div class="confirmation-mark" aria-hidden="true">✓</div>
      <h2>Your order has been placed!</h2>
      <p>Thank you for ordering from Viya Puri Café.</p>
      <div><div class="fine">Order reference</div><div class="ref">${esc(o.reference)}</div></div>
      <div class="confirmation-items">${o.items.map(i => `<div><span>${i.qty} × ${esc(i.name)}${i.size ? " (" + esc(i.size) + ")" : ""}</span></div>`).join("")}</div>
      <div class="bill"><div><span>Item total</span><span>${money(o.subtotal)}</span></div>${o.discount ? `<div class="disc"><span>Discount</span><span>−${money(o.discount)}</span></div>` : ""}
        <div><span>Delivery fee</span><span>${o.deliveryFee ? money(o.deliveryFee) : "Free"}</span></div><div class="total"><span>Order total</span><span>${money(o.total)}</span></div></div>
      <div class="confirmation-meta">
        <p><b>Payment:</b> ${esc(paymentLabel)} · ${o.paymentStatus === "paid" ? "Paid" : "Payment pending"}</p>
        <p><b>Order status:</b> ${esc(({ pending: "Pending", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready", completed: "Completed", cancelled: "Cancelled" })[o.orderStatus] || o.orderStatus)}</p>
        <p><b>${o.mode === "pickup" ? "Pickup" : "Delivery"}:</b> ${o.mode === "pickup" ? "Collect your order from the café." : esc([o.address?.line, o.address?.locality, o.address?.landmark, o.address?.pincode].filter(Boolean).join(", "))}</p>
      </div>
      <p class="fine">Keep this reference. To ask about your order, call <a href="tel:${esc(CFG.phone)}">${esc(CFG.phoneDisplay)}</a>.</p>
      <a class="btn btn-ghost btn-block" href="/my-orders">My Orders · Track an order</a>
      <button class="btn btn-primary btn-block" type="button" data-menu>Return to menu</button>
      </div>`; return;
  }
  if (co.step === "details") {
    $("#coTitle").textContent = "Your details";
    body.innerHTML = `<div class="steps"><span aria-current="step">1 Details</span><span>2 Review</span></div>
      <form id="coForm" novalidate style="display:grid;gap:12px">
      ${fld("coName", "Name", d.name || "", { attr: 'autocomplete="name"' })}
      ${fld("coPhone", "Mobile number", d.phone || "", { attr: 'inputmode="numeric" autocomplete="tel" placeholder="10-digit number"' })}
      ${state.mode === "delivery" ? `${fld("coLine", "House / street address", d.line || "", { area: 1, attr: 'rows="2" autocomplete="street-address"' })}
        <div class="two">${fld("coLocality", "Locality", d.locality || "")}${fld("coPin", "Pincode", d.pin || "", { attr: 'inputmode="numeric" maxlength="6" autocomplete="postal-code"' })}</div>
        ${fld("coLandmark", "Landmark", d.landmark || "", { opt: 1 })}`
      : ""}
      ${fld("coNote", "Delivery instructions", d.note || "", { opt: 1, area: 1, attr: 'rows="2"' })}
      <div class="field"><label for="coPay">Payment</label><select id="coPay">${CFG.payments.map(p => `<option value="${esc(p.id)}" ${p.id === d.payment ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select><span class="hint">Online payment (UPI / cards) is not available yet.</span></div>
      <button class="btn btn-primary btn-block" type="submit">Review order</button></form>`;
    return;
  }
  $("#coTitle").textContent = "Review your order";
  body.innerHTML = `<div class="steps"><span>1 Details</span><span aria-current="step">2 Review</span></div>${summaryHTML(t)}
    <div class="panel" style="padding:14px;gap:4px;font-size:.92rem"><b>${esc(d.name)}</b><span>${esc(phoneNorm(d.phone))}</span>${state.mode === "delivery" ? `<span>${esc(d.line)}, ${esc(d.locality)} – ${esc(d.pin)}${d.landmark ? " (near " + esc(d.landmark) + ")" : ""}</span>` : ""}${d.note ? `<span class="fine">Note: ${esc(d.note)}</span>` : ""}</div>
    ${co.error ? `<div class="notice ${co.uncertain ? "info" : "bad"}" role="alert">${esc(co.error)}</div>` : ""}
    ${CFG.orderingEnabled ? "" : `<div class="notice" role="status">Online ordering is not switched on yet, so we cannot send this order. Please call <a href="tel:${esc(CFG.phone)}">${esc(CFG.phoneDisplay)}</a> to order. Your cart is saved.</div>`}
    <div style="display:grid;gap:10px">
      ${CFG.orderingEnabled ? `<button class="btn btn-primary btn-block" type="button" data-place ${co.busy ? "disabled" : ""}>${co.busy ? "Checking order…" : co.uncertain ? "Check order status safely" : "Place order · " + money(t.total)}</button>` : `<a class="btn btn-primary btn-block" href="tel:${esc(CFG.phone)}">Call ${esc(CFG.phoneDisplay)} to order</a>`}
      <button class="btn btn-ghost btn-block" type="button" data-edit ${co.busy || co.uncertain ? "disabled" : ""}>Edit details</button></div>`;
}
async function placeOrder() {
  if (co.busy) return; const t = totals(); co.busy = true; co.error = ""; renderCheckout();
  const d = co.data, ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  if (!co.payload) co.payload = { clientKey: co.idem, mode: state.mode, coupon: state.coupon || null, payment: d.payment || CFG.payments[0].id, expectedTotal: t.total,
    items: t.L.map(l => ({ id: l.it.id, size: l.sz.id, qty: l.qty })),
    customer: { name: d.name, phone: phoneNorm(d.phone) },
    address: state.mode === "delivery" ? { line: d.line, locality: d.locality, landmark: d.landmark, pincode: d.pin } : null, note: d.note };
  try {
    const r = await fetch(CFG.apiBase + "/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(co.payload), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.reference || !Array.isArray(j.items)) {
      co.uncertain = r.status >= 500 || r.ok;
      co.error = co.uncertain
        ? "We couldn't confirm whether the café received this order. Your cart is saved. Check its status safely; the same secure request will be reused."
        : j.message || "The café could not accept this order. Your cart is saved. Please review the message and try again.";
      if (!co.uncertain && r.status >= 400 && r.status < 500) co.payload = null;
    }
    else { co.done = j; state.cart = {}; state.coupon = ""; co.idem = null; co.payload = null; co.uncertain = false; co.data = {}; clearPendingOrderKey(); saveCart(); updateBadge(); $$("[data-card]").forEach(el => refreshCards(el.dataset.card)); }
  } catch (e) {
    co.uncertain = true;
    co.error = "We couldn't confirm whether the café received this order. Your cart is saved. Check its status safely; the same secure request will be reused.";
  }
  clearTimeout(timer); co.busy = false; renderCheckout();
}

/* ---------- customer order lookup ---------- */
const customerStatusLabels = { pending: "Pending", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready", completed: "Completed", cancelled: "Cancelled" };
const customerStatusSteps = ["Order placed", "Accepted", "Preparing", "Ready", "Completed"];
async function customerApi(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "We could not complete that request. Please try again.");
  return data;
}
async function lookupCustomerOrders(form, page = 1) {
  if (account.busy) return;
  const values = form ? Object.fromEntries(new FormData(form).entries()) : {};
  const phone = phoneNorm(values.phone || account.phone);
  if (!validPhone(phone)) {
    account.error = "Enter a valid 10-digit Indian mobile number.";
    renderAccount();
    return;
  }
  account.phone = phone; account.busy = true; account.error = ""; account.searched = true;
  account.cancelMessage = ""; account.cancelMessageError = false; renderAccount();
  try {
    const data = await customerApi("/api/customer/orders/lookup", {
      method: "POST",
      body: JSON.stringify({ phone, page }),
    });
    account.orders = data.orders; account.page = data.page; account.pages = data.pages; account.total = data.total;
    if (!account.orders.some(order => order.reference === account.selectedReference)) account.selectedReference = null;
  } catch (error) { account.error = error.message; }
  account.busy = false; renderAccount();
}
function orderDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function orderProgress(order) {
  if (order.status === "cancelled") return '<p class="notice bad">This order was cancelled.</p>';
  const active = { pending: 0, confirmed: 1, preparing: 2, ready: 3, completed: 4 }[order.status] ?? 0;
  return `<div class="order-progress" aria-label="Order progress">${customerStatusSteps.map((label, index) => `<div class="order-progress-step ${index <= active ? "done" : ""}" ${index === active ? 'aria-current="step"' : ""}>${esc(label)}</div>`).join("")}</div>
    <p class="fine">The café updates your order through its existing Pending → Confirmed → Preparing → Ready → Completed workflow.</p>`;
}
function orderDetailHTML(order) {
  if (!order) return "";
  const address = order.address ? [order.address.line, order.address.locality, order.address.landmark, order.address.pincode].filter(Boolean).join(", ") : "Pickup from the café";
  const events = (order.timeline || []).filter(event => event.kind === "created" || event.kind === "status" || event.kind === "customer_cancelled");
  return `<article class="order-detail" aria-live="polite">
    <div class="order-card-head"><div><span class="eyebrow">Order ID</span><h2>${esc(order.reference)}</h2><p class="order-card-meta">Order date & time · ${esc(orderDate(order.createdAt))}</p></div><button class="btn btn-ghost btn-sm" type="button" data-close-order-detail>Close</button></div>
    ${orderProgress(order)}
    <h3 class="orders-section-title">Items</h3><div class="order-card-items">${order.items.map(item => `<div class="order-card-item"><span>${item.qty} × ${esc(item.name)}${item.size ? " (" + esc(item.size) + ")" : ""} · ${money(item.unitPrice)} each</span><b>${money(item.lineTotal)}</b></div>`).join("")}</div>
    <h3 class="orders-section-title">Price breakdown</h3><div class="order-breakdown">
      <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>${order.discount ? `<div><span>Discount${order.coupon ? " (" + esc(order.coupon) + ")" : ""}</span><span>−${money(order.discount)}</span></div>` : ""}
      <div><span>Delivery fee</span><span>${order.deliveryFee ? money(order.deliveryFee) : "Free"}</span></div><div><b>Total</b><b>${money(order.total)}</b></div></div>
    <h3 class="orders-section-title">Payment & delivery</h3><div class="order-card-items">
      <div><b>Payment</b> ${esc(order.paymentMethod === "cod" ? "Cash on delivery" : order.paymentMethod)} · ${order.paymentStatus === "paid" ? "Paid" : "Payment pending"}</div>
      <div><b>Order status</b> ${esc(customerStatusLabels[order.status] || order.status)}</div>
      <div><b>Name</b> ${esc(order.customer.name)}</div><div><b>Mobile</b> ${esc(order.customer.phone)}</div><div><b>${order.mode === "pickup" ? "Pickup" : "Delivery address"}</b> ${esc(address)}</div>
    </div>
    ${events.length ? `<h3 class="orders-section-title">Order updates</h3><ol>${events.map(event => `<li>${esc(event.kind === "created" ? "Order placed" : customerStatusLabels[event.to] || event.to)} · ${esc(orderDate(event.createdAt))}</li>`).join("")}</ol>` : ""}
  </article>`;
}
function renderOrderCards(orders) {
  if (!orders.length) return '<div class="order-empty">There are no orders saved for this mobile number yet.</div>';
  return `<div class="order-cards">${orders.map(order => `<article class="order-card">
    <div class="order-card-head"><div><span class="eyebrow">Order</span><h3>${esc(order.reference)}</h3><div class="order-card-meta">Placed · ${esc(orderDate(order.createdAt))}</div></div>
    <span class="order-status">${esc(customerStatusLabels[order.status] || order.status)}</span></div>
    <div class="order-card-items">${order.items.map(item => `<div class="order-card-item"><span>${item.qty} × ${esc(item.name)}${item.size ? " (" + esc(item.size) + ")" : ""}</span><b>${money(item.lineTotal)}</b></div>`).join("")}</div>
    <div class="order-card-head"><span class="order-card-meta">${order.paymentStatus === "paid" ? "Paid" : "Payment pending"} · ${esc(order.paymentMethod === "cod" ? "Cash on delivery" : order.paymentMethod)}</span><b>${money(order.total)}</b></div>
    <div class="order-card-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-order-detail="${esc(order.reference)}">${account.selectedReference === order.reference ? "Hide details" : "View details"}</button>
      ${order.status === "pending" ? `<button class="btn btn-danger btn-sm" type="button" data-cancel-order="${esc(order.reference)}" ${account.cancelingReference === order.reference ? "disabled" : ""}>${account.cancelingReference === order.reference ? "Cancelling…" : "Cancel order"}</button>` : ""}
    </div>
  </article>`).join("")}</div>`;
}
function renderAccount() {
  const host = $("#ordersContent");
  host.innerHTML = `<div class="orders-auth"><span class="eyebrow">Order lookup</span><h2>Find orders by phone number</h2>
      <p class="fine">Enter the mobile number used at checkout. Anyone who knows this number may be able to view its orders and delivery details, and cancel orders that are still Pending.</p>
      <form id="customerPhoneLookupForm" novalidate>
        <label class="field"><span>Checkout mobile number</span><input name="phone" inputmode="tel" autocomplete="tel" value="${esc(account.phone)}" placeholder="10-digit Indian mobile number" required></label>
        <p class="orders-auth-message ${account.error ? "error" : ""}" role="${account.error ? "alert" : "status"}">${esc(account.error)}</p>
        <button class="btn btn-primary btn-block" type="submit" ${account.busy ? "disabled" : ""}>${account.busy ? account.cancelingReference ? "Cancelling order…" : "Finding orders…" : account.searched ? "Search again" : "Find my orders"}</button>
      </form></div>
    ${account.cancelMessage ? `<p class="orders-auth-message ${account.cancelMessageError ? "error" : ""}" role="${account.cancelMessageError ? "alert" : "status"}">${esc(account.cancelMessage)}</p>` : ""}
    ${account.searched && !account.error && !account.busy ? `<p class="fine" role="status">${account.total} order${account.total === 1 ? "" : "s"} found for this number.</p>${renderOrderCards(account.orders)}` : ""}
    ${account.busy ? `<p class="fine" role="status">${account.cancelingReference ? "Cancelling order…" : "Finding orders…"}</p>` : ""}
    ${account.pages > 1 ? `<nav class="orders-pagination" aria-label="Order pages">
      <button class="btn btn-ghost btn-sm" type="button" data-customer-page="${account.page - 1}" ${account.page <= 1 || account.busy ? "disabled" : ""}>Previous</button>
      <span>Page ${account.page} of ${account.pages}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-customer-page="${account.page + 1}" ${account.page >= account.pages || account.busy ? "disabled" : ""}>Next</button>
    </nav>` : ""}`;
  const selectedOrder = account.orders.find(order => order.reference === account.selectedReference);
  if (selectedOrder) host.insertAdjacentHTML("beforeend", orderDetailHTML(selectedOrder));
}
async function cancelCustomerOrder(reference) {
  const order = account.orders.find(item => item.reference === reference);
  if (!order || order.status !== "pending" || account.busy) return;
  if (!window.confirm(`Cancel order ${reference}? Only Pending orders can be cancelled online.`)) return;
  account.busy = true;
  account.cancelingReference = reference;
  account.cancelMessage = "";
  account.cancelMessageError = false;
  renderAccount();
  try {
    const result = await customerApi("/api/customer/orders/cancel", {
      method: "POST",
      body: JSON.stringify({ phone: account.phone, reference }),
    });
    order.status = "cancelled";
    order.updatedAt = new Date().toISOString();
    order.timeline = [...(order.timeline || []), { kind: "customer_cancelled", from: "pending", to: "cancelled", createdAt: order.updatedAt }];
    account.cancelMessage = result.duplicate ? `Order ${reference} is already cancelled.` : `Order ${reference} has been cancelled. The café has been notified.`;
    try {
      const data = await customerApi("/api/customer/orders/lookup", {
        method: "POST", body: JSON.stringify({ phone: account.phone, page: account.page }),
      });
      account.orders = data.orders; account.page = data.page; account.pages = data.pages; account.total = data.total;
    } catch {}
  } catch (error) {
    try {
      const data = await customerApi("/api/customer/orders/lookup", {
        method: "POST", body: JSON.stringify({ phone: account.phone, page: account.page }),
      });
      account.orders = data.orders; account.page = data.page; account.pages = data.pages; account.total = data.total;
      const latest = account.orders.find(item => item.reference === reference);
      if (latest?.status === "cancelled") {
        account.cancelMessage = `Order ${reference} is cancelled. Its latest status has been confirmed.`;
      } else {
        account.cancelMessage = error.message || "We could not confirm the cancellation. Please check the order status and try again.";
        account.cancelMessageError = true;
      }
    } catch {
      account.cancelMessage = "We could not confirm whether the order was cancelled. Search your orders again before retrying.";
      account.cancelMessageError = true;
    }
  } finally {
    account.busy = false;
    account.cancelingReference = null;
    renderAccount();
  }
}
/* The server re-checks every coupon (expiry, limits, eligibility); the browser's check above is only a preview. */
async function serverCheckCoupon(code) {
  try {
    const r = await fetch(CFG.apiBase + "/coupons/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, mode: state.mode, items: lines().map(l => ({ id: l.it.id, size: l.sz.id, qty: l.qty })) }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.valid) { toast("Coupon applied"); return; }
    state.coupon = ""; renderCart(); toast(j.message || "That coupon could not be applied.");
  } catch (e) { toast("Could not check the coupon right now. It will be checked again when you place the order."); }
}

function initScrollEffects() {
  if (!("IntersectionObserver" in window)) return;
  const targets = $$("main > section:not(#my-orders):not([hidden]) .sec-head, .cat-tile, #featGrid .card, #grid .card, .band, .offer, .about-grid > *, .contact-grid > *");
  if (!targets.length) return;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
  document.body.classList.add("has-scroll-reveal");
  for (const target of targets) {
    target.classList.add("scroll-reveal");
    observer.observe(target);
  }
}

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("button,a"); if (!t) return; const ds = t.dataset;
  if (ds.cat !== undefined) { state.cat = ds.cat; renderMenu(); const c = $(`.chip[data-cat="${CSS.escape(ds.cat)}"]`); c && c.focus(); }
  else if (ds.catJump !== undefined) { state.cat = ds.catJump; state.q = ""; $("#q").value = ""; renderMenu(); $("#menu").scrollIntoView(); }
  else if (ds.clearSearch !== undefined) { state.q = ""; $("#q").value = ""; state.cat = "all"; renderMenu(); $("#q").focus(); }
  else if (ds.size) { state.sel[ds.item] = ds.size; refreshCards(ds.item, `.size[data-size="${CSS.escape(ds.size)}"]`); }
  else if (ds.add) { const id = ds.add.split("|")[0]; setQty(ds.add, 1); refreshCards(id, `[data-qty="${CSS.escape(ds.add)}"][data-d="1"]`); toast("Added to cart"); }
  else if (ds.qty) {
    const id = ds.qty.split("|")[0], inCart = $("#cartDlg").contains(t); setQty(ds.qty, +ds.d);
    refreshCards(id, state.cart[ds.qty] ? `[data-qty="${CSS.escape(ds.qty)}"][data-d="${ds.d}"]` : `[data-add="${CSS.escape(ds.qty)}"]`);
    if ($("#cartDlg").open) renderCart(inCart && state.cart[ds.qty] ? `[data-qty="${CSS.escape(ds.qty)}"][data-d="${ds.d}"]` : null);
  }
  else if (ds.remove) { setQty(ds.remove, -99); refreshCards(ds.remove.split("|")[0]); renderCart(); }
  else if (ds.clear !== undefined) { state.confirmClear = true; renderCart("[data-clear-no]"); }
  else if (ds.clearNo !== undefined) { state.confirmClear = false; renderCart("[data-clear]"); }
  else if (ds.clearYes !== undefined) { state.cart = {}; state.coupon = ""; state.confirmClear = false; saveCart(); $$("[data-card]").forEach(el => refreshCards(el.dataset.card)); renderCart(); toast("Cart cleared"); }
  else if (ds.mode) { state.mode = ds.mode; saveCart(); renderCart(`[data-mode="${ds.mode}"]`); }
  else if (ds.closeCart !== undefined) { closeCart(); $("#menu").scrollIntoView(); }
  else if (ds.checkout !== undefined) openCheckout();
  else if (ds.edit !== undefined) { co.step = "details"; co.error = ""; renderCheckout(); }
  else if (ds.place !== undefined) placeOrder();
  else if (ds.menu !== undefined) { $("#coDlg").close(); $("#menu").scrollIntoView({ behavior: "smooth" }); }
  else if (ds.orderDetail) {
    account.selectedReference = account.selectedReference === ds.orderDetail ? null : ds.orderDetail;
    renderAccount();
  }
  else if (ds.cancelOrder) cancelCustomerOrder(ds.cancelOrder);
  else if (ds.closeOrderDetail !== undefined) { account.selectedReference = null; renderAccount(); }
  else if (ds.customerPage) lookupCustomerOrders(null, Number(ds.customerPage));
  else if (t.id === "openCart" || t.id === "tabCart") openCart();
  else if (t.id === "heroOrder") { totals().count ? openCart() : ($("#menu").scrollIntoView(), toast("Pick something from the menu")); }
  else if (t.id === "closeCart") closeCart();
  else if (t.id === "closeCo") $("#coDlg").close();
});
document.addEventListener("submit", e => {
  e.preventDefault(); const f = e.target;
  if (f.id === "couponForm") { const c = $("#cp").value.trim().toUpperCase(); state.coupon = c; renderCart("#cp"); const t = totals(); if (c && !t.couponMsg) { if (CFG.orderingEnabled) serverCheckCoupon(c); else toast("Coupon applied"); } }
  else if (f.id === "coForm") { readForm(); if (validateCo()) { co.step = "review"; renderCheckout(); $("#coBody").scrollTop = 0; } else { renderCheckout(); const first = $(Object.keys(co.errs).map(k => "#" + k).join(",")); first && first.focus(); } }
  else if (f.id === "customerPhoneLookupForm") lookupCustomerOrders(f);
  else if (f.id === "contactForm") sendContact(f);
});
$("#q").addEventListener("input", e => { state.q = e.target.value; renderMenu(); });
// close dialogs when the dark backdrop is clicked
["cartDlg", "coDlg"].forEach(id => $("#" + id).addEventListener("click", e => { if (e.target.id === id) e.target.close(); }));
$("#coDlg").addEventListener("close", () => { if (co.done) { co.done = null; } });

/* ---------- init ---------- */
const customerPage = location.pathname === "/my-orders";
document.body.classList.toggle("customer-page", customerPage);
$("#my-orders").hidden = !customerPage;
if (customerPage) {
  $$('a[href^="#"]').forEach(link => { link.href = "/" + link.getAttribute("href"); });
}
loadCart();
renderHome(); renderMenu(); updateBadge(); updateStatus();
if (customerPage) renderAccount();
else initScrollEffects();
setInterval(updateStatus, 30000);
})();
