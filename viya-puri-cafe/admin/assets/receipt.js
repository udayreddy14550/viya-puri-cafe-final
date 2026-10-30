import { h, mount, money, dtFull } from "/admin/assets/ui.js";
const ref = decodeURIComponent(location.pathname.split("/").pop());
const root = document.getElementById("r");
document.getElementById("p").addEventListener("click", () => window.print());
const row = (a, b, cls) => h("div", { class: "row " + (cls || "") }, h("span", {}, a), h("span", {}, b));
(async () => {
  try {
    const [sres, cres] = await Promise.all([fetch("/api/admin/session", { credentials: "same-origin" }), fetch("/api/public/config")]);
    if (!sres.ok || !(await sres.json()).authenticated) return location.assign("/admin/login");
    const cfg = await cres.json();
    const r = await fetch("/api/admin/orders/" + encodeURIComponent(ref), { credentials: "same-origin" });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || "Order not found");
    const o = j.order;
    document.title = "Receipt " + o.reference;
    mount(root, h("h1", {}, cfg.name), h("div", { style: { textAlign: "center" } }, (cfg.address || []).join(", "), h("br"), cfg.phoneDisplay), h("hr"),
      row("Order", o.reference), row("Date", dtFull(o.createdAt)), row("Customer", o.customer.name), row("Phone", o.customer.phone),
      o.address ? h("div", {}, [o.address.line, o.address.locality, o.address.pincode].filter(Boolean).join(", ")) : null, h("hr"),
      ...o.items.map(i => h("div", {}, h("div", {}, `${i.name} (${i.size})`), row(`  ${i.qty} × ${money(i.price)}`, money(i.total)))), h("hr"),
      row("Items", money(o.subtotal)), o.discount ? row("Discount" + (o.coupon ? " " + o.coupon : ""), "−" + money(o.discount)) : null, row("Delivery", o.deliveryFee ? money(o.deliveryFee) : "Free"), row("TOTAL", money(o.total), "total"), h("hr"),
      row("Payment", o.paymentMethod === "cod" ? "Cash on delivery" : o.paymentMethod), row("Status", o.paymentStatus === "paid" ? "PAID" : "NOT YET PAID"), o.note ? h("div", {}, "Note: " + o.note) : null,
      h("hr"), h("div", { style: { textAlign: "center" } }, "Thank you for ordering!"));
  } catch (e) { mount(root, h("p", {}, e.message)); }
})();
