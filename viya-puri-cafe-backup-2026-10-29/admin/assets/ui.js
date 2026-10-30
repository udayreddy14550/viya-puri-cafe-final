/* Shared helpers. Elements are built with textContent (never innerHTML), so server data can't inject markup. */
export const session = { csrf: "", email: "", role: "owner" };
export const TZ = "Asia/Kolkata";

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "selected" || k === "open") el[k] = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);   // CSSOM is allowed by the CSP; style="" attributes are not
    else el.setAttribute(k, v === true ? "" : v);
  }
  const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) k.forEach(add); else el.append(k.nodeType ? k : document.createTextNode(String(k))); };
  kids.forEach(add);
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...kids) => { clear(el); const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) k.forEach(add); else el.append(k.nodeType ? k : document.createTextNode(String(k))); }; kids.forEach(add); return el; };

/* ---------- API ---------- */
export class ApiError extends Error { constructor(status, body) { super(body.message || "Something went wrong."); this.status = status; this.field = body.field; this.body = body; } }
export async function api(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") opts.headers["X-CSRF-Token"] = session.csrf;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch("/api/admin" + path, opts); } catch { throw new ApiError(0, { message: "Could not reach the server. Check your connection and try again." }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.assign("/admin/login"); throw new ApiError(401, { message: "Your session has ended. Please sign in again." }); }
  if (!r.ok) throw new ApiError(r.status, j);
  return j;
}

/* ---------- formatting ---------- */
export const money = n => "₹" + Number(n || 0).toLocaleString("en-IN");
export const dt = iso => iso ? new Date(iso).toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
export const dtFull = iso => iso ? new Date(iso).toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
export const ymd = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export const STATUS_LABEL = { pending: "Pending", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready", completed: "Completed", cancelled: "Cancelled" };
export const badge = (status, text) => h("span", { class: "badge " + status }, text || STATUS_LABEL[status] || status);
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- feedback ---------- */
export function toast(text, kind = "ok") {
  const box = document.getElementById("toasts"); if (!box) return;
  const t = h("div", { class: "toast " + kind, role: kind === "bad" ? "alert" : "status" }, text);
  box.append(t); setTimeout(() => t.remove(), kind === "bad" ? 7000 : 3500);
}
export const skeleton = (n = 4) => h("div", { style: { display: "grid", gap: "10px" }, "aria-busy": "true", "aria-label": "Loading" }, Array.from({ length: n }, () => h("div", { class: "skel", style: { height: "46px" } })));
export const empty = (title, text, action) => h("div", { class: "empty" }, h("b", {}, title), text && h("p", {}, text), action);
export const errorBox = (e, retry) => h("div", { class: "empty" }, h("b", {}, "Couldn't load this"), h("p", {}, e.message), retry && h("button", { class: "btn ghost sm", type: "button", onclick: retry }, "Try again"));

export function modal({ title, body, footer, wide }) {
  const dlg = h("dialog", { "aria-labelledby": "dlg-title" });
  const close = () => { dlg.close(); };
  dlg.append(h("div", { class: "dlg" },
    h("header", {}, h("h2", { id: "dlg-title" }, title), h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: close }, "✕")),
    h("div", { class: "body" }, body), footer ? h("footer", {}, footer) : null));
  if (wide) dlg.style.maxWidth = "min(980px, calc(100vw - 24px))";
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", e => { if (e.target === dlg) close(); });
  document.body.append(dlg); dlg.showModal();
  return { el: dlg, close };
}
export function confirmDialog({ title, message, confirmText = "Confirm", danger = false, extra }) {
  return new Promise(resolve => {
    let result = false;
    const yes = h("button", { class: "btn " + (danger ? "danger" : "primary"), type: "button", onclick: () => { result = true; m.close(); } }, confirmText);
    const m = modal({ title, body: [h("p", {}, message), extra || null], footer: [h("button", { class: "btn ghost", type: "button", onclick: () => m.close() }, "Cancel"), yes] });
    m.el.addEventListener("close", () => resolve(result));
    yes.focus();
  });
}

/** Run an async action on a button: disables it, shows busy state, and reports failures honestly. */
export async function busy(btn, fn, { okMsg } = {}) {
  const label = btn.textContent; btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "Working…";
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message || "That didn't work.", "bad"); return undefined; }
  finally { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.textContent = label; }
}

export const field = (label, input, { hint, id, err } = {}) => {
  const fid = id || input.id || (input.id = "f" + Math.random().toString(36).slice(2, 8));
  return h("div", { class: "field" }, h("label", { for: fid }, label), input, hint ? h("span", { class: "hint" }, hint) : null, h("span", { class: "err", hidden: true, "data-err": fid }));
};
/** Show a server validation message against the matching field (by data-field) inside a form. */
export function showFieldError(form, e) {
  form.querySelectorAll("[data-err]").forEach(x => { x.hidden = true; });
  form.querySelectorAll("[aria-invalid]").forEach(x => x.removeAttribute("aria-invalid"));
  const target = e.field && form.querySelector(`[data-field="${CSS.escape(e.field)}"]`);
  if (!target) return false;
  target.setAttribute("aria-invalid", "true"); target.focus();
  const holder = target.closest(".field"); const s = holder && holder.querySelector("[data-err]");
  if (s) { s.hidden = false; s.textContent = e.message; }
  return true;
}
