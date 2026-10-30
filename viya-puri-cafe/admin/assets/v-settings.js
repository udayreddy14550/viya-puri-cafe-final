import { h, mount, api, toast, busy, confirmDialog, skeleton, errorBox, field, showFieldError, session } from "/admin/assets/ui.js";

export async function render(root) {
  let s;
  try { s = (await api("GET", "/settings")).settings; } catch (e) { return mount(root, errorBox(e, () => render(root))); }
  const t = (key, val, o = {}) => h("input", { type: o.type || "text", "data-field": key, value: val ?? "", maxlength: o.max || 200, ...o.attrs });
  const name = t("name", s.name), tag = t("tagline", s.tagline), ann = t("announcement", s.announcement, { max: 200 });
  const phone = t("phone", s.phone, { attrs: { inputmode: "tel", placeholder: "+919014753530" } }), phoneD = t("phoneDisplay", s.phoneDisplay), wa = t("whatsapp", s.whatsapp, { attrs: { placeholder: "919014753530" } });
  const maps = t("mapsUrl", s.mapsUrl, { type: "url", max: 500 }), ig = t("social", s.social?.instagram, { type: "url", max: 500 }), fb = t("social", s.social?.facebook, { type: "url", max: 500 });
  const addr = h("textarea", { "data-field": "address", rows: 3 }); addr.value = (s.address || []).join("\n");
  const open = t("hours", s.hours.open, { type: "time" }), close = t("hours", s.hours.close, { type: "time" }), prep = t("prepMinutes", s.prepMinutes, { type: "number", attrs: { min: 1, max: 240 } });
  const dEn = h("input", { type: "checkbox", checked: s.delivery.enabled }), dFree = t("delivery", s.delivery.freeAbove, { type: "number", attrs: { min: 0 } }), dFee = t("delivery", s.delivery.fee, { type: "number", attrs: { min: 0 } }), dMin = t("delivery", s.delivery.minOrder, { type: "number", attrs: { min: 0 } });
  const dBasis = h("select", { "data-field": "delivery" }, h("option", { value: "afterDiscount", selected: s.delivery.freeAboveBasis === "afterDiscount" }, "Total after coupon discount"), h("option", { value: "itemTotal", selected: s.delivery.freeAboveBasis === "itemTotal" }, "Item total before discount"));
  const pins = h("textarea", { "data-field": "delivery", rows: 2, placeholder: "e.g. 522001, 522002" }); pins.value = (s.delivery.pincodes || []).join(", ");
  const dConfirmed = h("input", { type: "checkbox", checked: s.delivery.confirmed });
  const ordOn = h("input", { type: "checkbox", checked: s.orderingEnabled }), conOn = h("input", { type: "checkbox", checked: s.contactEnabled });
  const sw = (i, l) => h("label", { class: "switch" }, i, l);

  const save = h("button", { class: "btn primary", type: "submit" }, "Save settings");
  const form = h("form", { novalidate: true, style: { display: "grid", gap: "16px" } },
    h("section", { class: "panel" }, h("h2", {}, "Café details"), h("div", { class: "grid2" }, field("Café name", name), field("Tagline", tag)), field("Announcement banner", ann, { hint: "Shown at the top of the website. Leave blank for none." }),
      h("div", { class: "grid3" }, field("Phone (for calls)", phone, { hint: "Digits with optional +." }), field("Phone (as shown)", phoneD), field("WhatsApp number", wa, { hint: "Digits only, with country code." })),
      field("Address", addr, { hint: "One line per row (up to 4)." }), field("Google Maps link", maps),
      h("div", { class: "grid2" }, field("Instagram link", ig), field("Facebook link", fb))),
    h("section", { class: "panel" }, h("h2", {}, "Opening hours"), h("div", { class: "grid3" }, field("Opens", open), field("Closes", close), field("Preparation time (minutes)", prep))),
    h("section", { class: "panel" }, h("h2", {}, "Home delivery"), h("div", { style: { display: "flex", gap: "24px", flexWrap: "wrap" } }, sw(dEn, "Home delivery")),
      h("div", { class: "grid3" }, field("Free delivery above (₹)", dFree), field("Delivery fee (₹)", dFee), field("Minimum order for delivery (₹)", dMin)), field("Free delivery is judged on", dBasis),
      field("Deliver only to these pincodes", pins, { hint: "Comma separated, 6 digits each. Leave blank to accept any pincode." }), sw(dConfirmed, "I have confirmed the delivery area and fee with the café")),
    h("section", { class: "panel" }, h("h2", {}, "Website features"), h("p", { class: "muted small" }, "These stay off until you switch them on. Payment is cash on delivery only."),
      sw(ordOn, "Accept online orders"), sw(conOn, "Show a working contact form (messages appear under Messages)")),
    h("div", { style: { display: "flex", justifyContent: "flex-end" } }, save));

  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (ordOn.checked && !s.orderingEnabled && !(await confirmDialog({ title: "Start accepting online orders?", message: "Customers will be able to place cash-on-delivery orders on the website straight away. Check your delivery area, fee and hours first, and make sure someone is watching the Orders page.", confirmText: "Yes, accept orders" }))) return;
    const body = { name: name.value, tagline: tag.value, announcement: ann.value, phone: phone.value.replace(/[\s-]/g, ""), phoneDisplay: phoneD.value, whatsapp: wa.value.replace(/[\s+-]/g, ""), mapsUrl: maps.value, social: { instagram: ig.value, facebook: fb.value },
      address: addr.value.split("\n").map(x => x.trim()).filter(Boolean), hours: { open: open.value, close: close.value }, prepMinutes: Number(prep.value),
      delivery: { enabled: dEn.checked, freeAbove: Number(dFree.value), freeAboveBasis: dBasis.value, fee: Number(dFee.value), minOrder: Number(dMin.value), pincodes: pins.value.split(/[\s,]+/).filter(Boolean), confirmed: dConfirmed.checked },
      orderingEnabled: ordOn.checked, contactEnabled: conOn.checked };
    await busy(save, async () => { try { const r = await api("PUT", "/settings", body); s = r.settings; toast("Settings saved. The website now shows them."); } catch (er) { if (!showFieldError(form, er)) throw er; toast(er.message, "bad"); } });
  });

  const cur = h("input", { type: "password", autocomplete: "current-password", "data-field": "currentPassword" }), nw = h("input", { type: "password", autocomplete: "new-password", "data-field": "newPassword" }), rep = h("input", { type: "password", autocomplete: "new-password" });
  const pwBtn = h("button", { class: "btn ghost", type: "submit" }, "Change password");
  const pwForm = h("form", { class: "panel", novalidate: true }, h("h2", {}, "Your account"), h("p", { class: "muted small" }, "Signed in as " + session.email + ". Changing your password signs out your other devices."),
    h("div", { class: "grid3" }, field("Current password", cur), field("New password", nw, { hint: "At least 12 characters, mixing three of: lower, upper, numbers, symbols." }), field("Repeat new password", rep)), h("div", {}, pwBtn));
  pwForm.addEventListener("submit", e => { e.preventDefault(); busy(pwBtn, async () => {
    if (nw.value !== rep.value) return toast("The new passwords don't match.", "bad");
    try { await api("POST", "/password", { currentPassword: cur.value, newPassword: nw.value }); cur.value = nw.value = rep.value = ""; toast("Password changed."); } catch (er) { if (!showFieldError(pwForm, er)) throw er; toast(er.message, "bad"); } }); });

  mount(root, h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Café settings"), h("p", {}, "Contact details, hours, delivery rules and website features. Menu categories are managed on the Menu page."))), form, h("div", { style: { height: "16px" } }), pwForm);
}
