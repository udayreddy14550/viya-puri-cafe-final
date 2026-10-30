import { h, mount, api, money, dt, dtFull, badge, toast, busy, modal, confirmDialog, empty, skeleton, errorBox, debounce, STATUS_LABEL } from "/admin/assets/ui.js";

const f = { q: "", status: "", payment: "", from: "", to: "", sort: "newest", page: 1 };
const FLOW = ["pending", "confirmed", "preparing", "ready", "completed"];

export async function render(root, { params, refreshPills }) {
  if (params.has("status")) { Object.assign(f, { status: params.get("status") || "", page: 1 }); }
  let counts = {}, stop = false, highlightRef = "", highlightTimer;
  const load = async (quiet) => {
    if (!quiet) mount(root, skeleton(6));
    const qs = new URLSearchParams({ sort: f.sort, page: f.page }); for (const k of ["q", "status", "payment", "from", "to"]) if (f[k]) qs.set(k, f[k]);
    let d; try { d = await api("GET", "/orders?" + qs); } catch (e) { if (quiet) { toast("Orders could not refresh after the order alert: " + e.message, "bad"); return; } return mount(root, errorBox(e, () => load())); }
    if (stop) return; counts = d.counts; draw(d);
  };
  const inp = (id, label, type, key, extra = {}) => { const i = h("input", { type, id, value: f[key], ...extra }); i.addEventListener(type === "search" ? "input" : "change", debounce(() => { f[key] = i.value; f.page = 1; load(true).then(() => type === "search" && document.getElementById(id)?.focus()); }, type === "search" ? 350 : 0)); return h("div", { class: "field" + (extra.grow ? " grow" : "") }, h("label", { for: id }, label), i); };
  const sel = (id, label, key, opts) => { const s = h("select", { id }, opts.map(([v, t]) => h("option", { value: v, selected: f[key] === v }, t))); s.addEventListener("change", () => { f[key] = s.value; f.page = 1; load(true); }); return h("div", { class: "field" }, h("label", { for: id }, label), s); };
  const draw = d => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0), pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    mount(root,
      h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Orders"), h("p", {}, `${total} orders in total.`)), h("button", { class: "btn ghost", type: "button", onclick: () => load() }, "Refresh")),
      h("div", { class: "chips", role: "group", "aria-label": "Filter by status", style: { marginBottom: "14px" } }, [["", "All", total], ...Object.keys(STATUS_LABEL).map(s => [s, STATUS_LABEL[s], counts[s] || 0])].map(([v, t, n]) =>
        h("button", { class: "chip", type: "button", "aria-pressed": String(f.status === v), onclick: () => { f.status = v; f.page = 1; load(true); } }, `${t} (${n})`))),
      h("div", { class: "toolbar", style: { marginBottom: "16px" } }, inp("oq", "Search", "search", "q", { placeholder: "Order number, name or phone", grow: true }), inp("of", "From", "date", "from"), inp("ot", "To", "date", "to"),
        sel("op", "Payment", "payment", [["", "Any"], ["unpaid", "Unpaid"], ["paid", "Paid"]]), sel("os", "Sort", "sort", [["newest", "Newest first"], ["oldest", "Oldest first"], ["total", "Highest total"]])),
      d.orders.length ? [h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Order", "Placed", "Customer", "Items", "Total", "Payment", "Status", ""].map(x => h("th", {}, x)))),
        h("tbody", {}, d.orders.map(o => h("tr", { class: o.reference === highlightRef ? "new-order-row" : null }, h("td", { class: "nowrap" }, h("b", {}, o.reference)), h("td", { class: "nowrap small" }, dt(o.createdAt)), h("td", {}, o.customer.name, h("div", { class: "muted small" }, o.customer.phone)),
          h("td", {}, String(o.itemCount)), h("td", { class: "mono" }, money(o.total)), h("td", {}, badge(o.paymentStatus, (o.paymentMethod === "cod" ? "COD · " : "") + (o.paymentStatus === "paid" ? "Paid" : "Unpaid"))), h("td", {}, badge(o.status)),
          h("td", { class: "actions" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => open(o.reference) }, "View"))))))),
        h("div", { class: "pager", style: { marginTop: "12px" } }, h("span", { class: "muted small" }, `Page ${d.page} of ${pages} · ${d.total} matching`), h("span", { style: { display: "flex", gap: "8px" } },
          h("button", { class: "btn ghost sm", type: "button", disabled: d.page <= 1, onclick: () => { f.page--; load(true); } }, "Previous"), h("button", { class: "btn ghost sm", type: "button", disabled: d.page >= pages, onclick: () => { f.page++; load(true); } }, "Next")))]
        : total ? empty("No orders match", "Try clearing the filters.", h("button", { class: "btn ghost sm", type: "button", onclick: () => { Object.assign(f, { q: "", status: "", payment: "", from: "", to: "", page: 1 }); load(); } }, "Clear filters")) : empty("No orders yet", "Orders placed on the website will appear here."));
  };
  const open = async ref => {
    const body = h("div", {}, skeleton(4)); const m = modal({ title: "Order " + ref, body, wide: true }); m.el.addEventListener("close", () => { load(true); refreshPills(); });
    const show = async () => {
      let o; try { o = (await api("GET", "/orders/" + encodeURIComponent(ref))).order; } catch (e) { return mount(body, errorBox(e, show)); }
      const next = FLOW[FLOW.indexOf(o.status) + 1], final = ["completed", "cancelled"].includes(o.status);
      const setStatus = async (to, btn) => {
        if (to === "cancelled" || to === "completed") { const note = h("input", { type: "text", maxlength: 200, placeholder: "Note (optional)", "aria-label": "Note" }); if (!(await confirmDialog({ title: to === "cancelled" ? "Cancel this order?" : "Mark as completed?", message: to === "cancelled" ? "A cancelled order is left out of sales totals and can't be changed afterwards." : "A completed order can't be changed afterwards.", confirmText: to === "cancelled" ? "Cancel order" : "Mark completed", danger: to === "cancelled", extra: note }))) return; var n = note.value; }
        await busy(btn, async () => { await api("PATCH", `/orders/${encodeURIComponent(o.reference)}/status`, { status: to, note: n }); toast(`Order is now ${STATUS_LABEL[to].toLowerCase()}.`); await show(); });
      };
      const pay = h("button", { class: "btn ghost sm", type: "button" }, "Mark cash received");
      pay.addEventListener("click", async () => { if (!(await confirmDialog({ title: "Confirm payment received", message: `Only confirm once you've actually received ${money(o.total)} in cash. This is recorded against your account.`, confirmText: "Yes, cash received" }))) return; busy(pay, async () => { await api("PATCH", `/orders/${encodeURIComponent(o.reference)}/payment`, { paymentStatus: "paid" }); toast("Payment recorded."); await show(); }); });
      const stBtns = FLOW.slice(0, -1).includes(o.status) || o.status === "ready" ? [] : [];
      mount(body,
        h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } }, badge(o.status), badge(o.paymentStatus, o.paymentStatus === "paid" ? "Paid" : "Payment not received"), h("span", { class: "muted small" }, "Placed " + dtFull(o.createdAt))),
        h("div", { class: "grid2" },
          h("section", { class: "panel" }, h("h3", {}, "Customer"), h("div", {}, h("b", {}, o.customer.name)), h("a", { href: "tel:" + o.customer.phone }, o.customer.phone),
            o.address ? h("div", { class: "small" }, [o.address.line, o.address.locality, o.address.landmark && "Near " + o.address.landmark, o.address.pincode].filter(Boolean).join(", ")) : h("div", { class: "small muted" }, "No address on this order."), o.note ? h("div", { class: "notice info" }, "Note: " + o.note) : null),
          h("section", { class: "panel" }, h("h3", {}, "Payment"), h("div", {}, o.paymentMethod === "cod" ? "Cash on delivery" : o.paymentMethod), h("div", { class: "small muted" }, o.paymentStatus === "paid" ? "Paid " + dtFull(o.paidAt) : "Not marked as paid. Cash is collected on handover."), o.paymentStatus === "unpaid" && o.status !== "cancelled" ? pay : null)),
        h("div", { class: "table-wrap" }, h("table", { style: { minWidth: "420px" } }, h("thead", {}, h("tr", {}, ["Item", "Size", "Price", "Qty", "Total"].map(x => h("th", {}, x)))),
          h("tbody", {}, o.items.map(i => h("tr", {}, h("td", {}, i.name), h("td", {}, i.size), h("td", { class: "mono" }, money(i.price)), h("td", {}, String(i.qty)), h("td", { class: "mono" }, money(i.total))))))),
        h("div", { class: "list" }, h("div", {}, h("span", {}, "Items"), h("span", { class: "mono" }, money(o.subtotal))), o.discount ? h("div", {}, h("span", {}, "Discount" + (o.coupon ? ` (${o.coupon})` : "")), h("span", { class: "mono" }, "−" + money(o.discount))) : null,
          h("div", {}, h("span", {}, "Delivery"), h("span", { class: "mono" }, o.deliveryFee ? money(o.deliveryFee) : "Free")), h("div", {}, h("b", {}, "Total"), h("b", { class: "mono" }, money(o.total)))),
        h("section", { class: "panel" }, h("h3", {}, "Update status"),
          final ? h("p", { class: "muted small" }, `This order is ${o.status} and can't be changed.`) : h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            ...FLOW.filter(s => s !== "pending" && FLOW.indexOf(s) > FLOW.indexOf(o.status)).map(s => { const b = h("button", { class: "btn " + (s === next ? "primary" : "ghost") + " sm", type: "button" }, "Mark " + STATUS_LABEL[s].toLowerCase()); b.addEventListener("click", () => setStatus(s, b)); return b; }),
            (() => { const b = h("button", { class: "btn danger sm", type: "button" }, "Cancel order"); b.addEventListener("click", () => setStatus("cancelled", b)); return b; })())),
        h("section", { class: "panel" }, h("h3", {}, "History"), h("div", { class: "list" }, o.events.map(e => h("div", {}, h("span", {}, e.kind === "created" ? "Order placed by customer" : e.kind === "payment" ? `Payment ${e.from} → ${e.to}` : `Status ${e.from} → ${e.to}`, e.note ? ` (${e.note})` : "", h("div", { class: "muted small" }, e.actor)), h("span", { class: "muted small nowrap" }, dtFull(e.createdAt)))))),
        h("div", {}, h("a", { class: "btn ghost", href: "/admin/receipt/" + encodeURIComponent(o.reference), target: "_blank", rel: "noopener" }, "Print receipt")));
    };
    show();
  };
  const onNewOrder = event => {
    if (!event.detail.duplicate) {
      highlightRef = event.detail.reference;
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => { highlightRef = ""; }, 5000);
    }
    load(true);
    refreshPills();
  };
  const onCustomerCancellation = event => {
    highlightRef = event.detail.reference;
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => { highlightRef = ""; }, 5000);
    load(true);
    refreshPills();
  };
  window.addEventListener("vpc:new-order", onNewOrder);
  window.addEventListener("vpc:order-cancelled", onCustomerCancellation);
  await load();
  if (params.get("open")) open(params.get("open"));
  return () => { stop = true; window.removeEventListener("vpc:new-order", onNewOrder); window.removeEventListener("vpc:order-cancelled", onCustomerCancellation); clearTimeout(highlightTimer); };
}
