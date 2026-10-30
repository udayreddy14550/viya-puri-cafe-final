import { h, mount, api, money, toast, busy, modal, confirmDialog, empty, skeleton, errorBox, field, showFieldError } from "/admin/assets/ui.js";

export async function render(root) {
  const load = async () => {
    mount(root, skeleton(4));
    let d; try { d = await api("GET", "/coupons"); } catch (e) { return mount(root, errorBox(e, load)); }
    mount(root,
      h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Offers & coupons"), h("p", {}, "Every coupon is checked again on the server when a customer orders, so edits here always win.")), h("button", { class: "btn primary", type: "button", onclick: () => edit(null, load) }, "New coupon")),
      d.coupons.some(c => !c.active) ? h("div", { class: "notice info", style: { marginBottom: "16px" } }, "Disabled coupons are hidden from the website. WELCOME10 and CAFE20 came from your original site and were switched off there, so they are disabled until you enable them. WELCOME10 has no first-order limit yet: set “Uses per customer” to 1 if it should only work once per phone number.") : null,
      d.coupons.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Code", "Offer", "Minimum order", "Valid", "Used", "Status", ""].map(x => h("th", {}, x)))),
        h("tbody", {}, d.coupons.map(c => h("tr", {}, h("td", {}, h("b", {}, c.code), c.description ? h("div", { class: "muted small" }, c.description) : null),
          h("td", {}, c.type === "percent" ? `${c.value}% off` + (c.maxDiscount ? `, up to ${money(c.maxDiscount)}` : "") : `${money(c.value)} off`), h("td", {}, c.minOrder ? money(c.minOrder) : "None"),
          h("td", { class: "small" }, c.startsOn || c.expiresOn ? `${c.startsOn || "Any time"} → ${c.expiresOn || "No expiry"}` : "Always"), h("td", {}, c.used + (c.usageLimit ? ` / ${c.usageLimit}` : "")),
          h("td", {}, h("span", { class: "badge " + (c.active ? "ok" : "") }, c.active ? "Enabled" : "Disabled")),
          h("td", { class: "actions" }, (() => { const b = h("button", { class: "btn ghost sm", type: "button" }, c.active ? "Disable" : "Enable"); b.addEventListener("click", () => busy(b, async () => { await api("PATCH", `/coupons/${encodeURIComponent(c.code)}/active`, { active: !c.active }); toast(`${c.code} ${c.active ? "disabled" : "enabled"}.`); load(); })); return b; })(), " ",
            h("button", { class: "btn ghost sm", type: "button", onclick: () => edit(c, load) }, "Edit"), " ",
            h("button", { class: "btn ghost sm", type: "button", onclick: async () => { if (await confirmDialog({ title: "Delete coupon?", message: `${c.code} will stop working. Past orders keep their record.`, confirmText: "Delete", danger: true })) try { await api("DELETE", `/coupons/${encodeURIComponent(c.code)}`); toast("Coupon deleted."); load(); } catch (e) { toast(e.message, "bad"); } } }, "Delete")))))))
        : empty("No coupons yet", "Create one to offer a discount.", h("button", { class: "btn primary", type: "button", onclick: () => edit(null, load) }, "New coupon")));
  };
  await load();
}

function edit(c, reload) {
  const isNew = !c;
  const code = h("input", { type: "text", "data-field": "code", maxlength: 20, value: c?.code || "", disabled: !isNew, autocapitalize: "characters" });
  const type = h("select", { "data-field": "type" }, h("option", { value: "percent", selected: !c || c.type === "percent" }, "Percentage off"), h("option", { value: "flat", selected: c?.type === "flat" }, "Fixed amount off (₹)"));
  const val = h("input", { type: "number", min: 1, "data-field": "value", value: c?.value ?? "" });
  const max = h("input", { type: "number", min: 1, "data-field": "maxDiscount", value: c?.maxDiscount ?? "" });
  const min = h("input", { type: "number", min: 0, "data-field": "minOrder", value: c?.minOrder ?? 0 });
  const from = h("input", { type: "date", "data-field": "startsOn", value: c?.startsOn || "" }), to = h("input", { type: "date", "data-field": "expiresOn", value: c?.expiresOn || "" });
  const lim = h("input", { type: "number", min: 1, "data-field": "usageLimit", value: c?.usageLimit ?? "" }), per = h("input", { type: "number", min: 1, "data-field": "perCustomerLimit", value: c?.perCustomerLimit ?? "" });
  const desc = h("input", { type: "text", maxlength: 120, "data-field": "description", value: c?.description || "" });
  const active = h("input", { type: "checkbox", checked: c ? c.active : true });
  const maxF = field("Maximum discount (₹)", max, { hint: "Optional cap for percentage coupons." });
  const sync = () => { maxF.hidden = type.value !== "percent"; val.setAttribute("aria-label", type.value === "percent" ? "Percent off" : "Amount off"); }; type.addEventListener("change", sync); sync();
  const form = h("form", { novalidate: true, style: { display: "grid", gap: "14px" } }, h("div", { class: "grid2" }, field("Code", code, { hint: "Letters, numbers, - and _. Customers type this in." }), field("Description", desc)),
    h("div", { class: "grid3" }, field("Discount type", type), field("Value", val, { hint: "Percent (1–100) or rupees." }), maxF),
    h("div", { class: "grid3" }, field("Minimum order (₹)", min), field("Valid from", from), field("Valid until", to, { hint: "Last day it works." })),
    h("div", { class: "grid2" }, field("Total uses allowed", lim, { hint: "Leave blank for unlimited." }), field("Uses per customer", per, { hint: "Counted by phone number. Blank for unlimited." })),
    h("label", { class: "switch" }, active, "Enabled (visible on the website)"));
  const save = h("button", { class: "btn primary", type: "button" }, isNew ? "Create coupon" : "Save changes");
  const m = modal({ title: isNew ? "New coupon" : "Edit " + c.code, body: form, footer: [h("button", { class: "btn ghost", type: "button", onclick: () => m.close() }, "Cancel"), save] });
  const num = i => (i.value === "" ? null : Number(i.value));
  save.addEventListener("click", () => busy(save, async () => {
    const body = { code: code.value.trim().toUpperCase(), description: desc.value, type: type.value, value: num(val), maxDiscount: type.value === "percent" ? num(max) : null, minOrder: num(min) ?? 0, startsOn: from.value || null, expiresOn: to.value || null, usageLimit: num(lim), perCustomerLimit: num(per), active: active.checked };
    try { await api(isNew ? "POST" : "PUT", isNew ? "/coupons" : `/coupons/${encodeURIComponent(c.code)}`, body); toast(isNew ? "Coupon created." : "Coupon saved."); m.close(); reload(); }
    catch (e) { if (!showFieldError(form, e)) throw e; toast(e.message, "bad"); }
  }));
}
