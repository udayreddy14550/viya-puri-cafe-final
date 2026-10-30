import { h, mount, api, money, dt, badge, empty, skeleton, errorBox, toast } from "/admin/assets/ui.js";

const stat = (k, n, s, href) => h(href ? "a" : "div", { class: "stat", href, style: { textDecoration: "none" } }, h("span", { class: "k" }, k), h("span", { class: "n" }, String(n)), s ? h("span", { class: "s" }, s) : null);

export async function render(root, { refreshPills } = {}) {
  let highlightRef = "", highlightTimer, stop = false;
  const load = async (quiet = false) => {
    if (!quiet) mount(root, skeleton(6));
    let d;
    try { d = await api("GET", "/dashboard"); }
    catch (e) { if (!quiet) mount(root, errorBox(e, load)); else toast("Dashboard could not refresh after the order alert: " + e.message, "bad"); return; }
    if (stop) return;
    const max = Math.max(1, ...d.sales.last7.map(x => x.sales));
    mount(root,
      h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Dashboard"), h("p", {}, "How the café is doing, from real orders and menu data.")),
        h("a", { class: "btn primary", href: "#/menu?new=1" }, "Add menu item")),
      !d.orderingEnabled ? h("div", { class: "notice info", style: { marginBottom: "16px" } }, "Online ordering is switched off, so customers can't place orders yet. Turn it on in ", h("a", { href: "#/settings" }, "Café settings"), " when you're ready to receive them.") : null,
      h("div", { class: "cards" },
        stat("Menu items", d.menu.total, `${d.menu.categories} categories`, "#/menu"),
        stat("Available", d.menu.available, "Shown as orderable", "#/menu?filter=available"),
        stat("Sold out", d.menu.unavailable, "Hidden from ordering", "#/menu?filter=soldout"),
        stat("Orders", d.orders.total, `${d.orders.today} today`, "#/orders"),
        stat("Pending", d.orders.pending, `${d.orders.inProgress} being prepared`, "#/orders?status=pending"),
        stat("Total sales", money(d.sales.total), "Excludes cancelled orders", "#/reports"),
        stat("Today's sales", money(d.sales.today), `Average order ${money(d.sales.average)}`)),
      h("div", { class: "cols" },
        h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Last 7 days"), h("span", { class: "muted small" }, "Sales per day")),
          h("div", { class: "bars", role: "img", "aria-label": "Sales for the last 7 days" }, d.sales.last7.map(x => h("div", { class: "bar", title: `${x.date}: ${money(x.sales)} from ${x.orders} orders` },
            h("div", { class: "col" + (x.sales ? "" : " zero"), style: { height: Math.max(2, Math.round(x.sales / max * 100)) + "%" } }),
            h("span", {}, new Date(x.date + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" })), h("b", {}, x.sales ? money(x.sales) : "–")))),
          d.sales.last7.every(x => !x.orders) ? h("p", { class: "muted small" }, "No orders in the last 7 days yet.") : null),
        h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Popular items")),
          d.topItems.length ? h("div", { class: "list" }, d.topItems.map(t => h("div", {}, h("span", {}, t.name), h("b", {}, t.qty + " sold")))) : empty("No sales yet", "Popular items appear once orders come in."))),
      h("div", { class: "cols", style: { marginTop: "16px" } },
        h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Recent orders"), h("a", { href: "#/orders" }, "See all")),
          d.recentOrders.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Order", "Customer", "Total", "Status"].map(x => h("th", {}, x)))),
            h("tbody", {}, d.recentOrders.map(o => h("tr", { class: o.reference === highlightRef ? "new-order-row" : null },
              h("td", {}, h("a", { href: "#/orders?open=" + encodeURIComponent(o.reference) }, o.reference), h("div", { class: "muted small" }, dt(o.createdAt))),
              h("td", {}, o.customer.name), h("td", { class: "mono" }, money(o.total)), h("td", {}, badge(o.status)))))))
            : empty("No orders yet", d.orderingEnabled ? "New orders will show up here." : "Switch on online ordering to start receiving orders.")),
        h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Recent updates")),
          d.recentUpdates.length ? h("div", { class: "list" }, d.recentUpdates.map(u => h("div", {}, h("span", {}, u.summary, h("div", { class: "muted small" }, u.actor)), h("span", { class: "muted small nowrap" }, dt(u.createdAt))))) : empty("Nothing yet", "Changes made in this dashboard are listed here."))));
  };
  const onNewOrder = event => {
    if (!event.detail.duplicate) {
      highlightRef = event.detail.reference;
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => { highlightRef = ""; }, 5000);
    }
    load(true);
    refreshPills?.();
  };
  const onCustomerCancellation = event => {
    highlightRef = event.detail.reference;
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => { highlightRef = ""; }, 5000);
    load(true);
    refreshPills?.();
  };
  window.addEventListener("vpc:new-order", onNewOrder);
  window.addEventListener("vpc:order-cancelled", onCustomerCancellation);
  await load();
  return () => { stop = true; window.removeEventListener("vpc:new-order", onNewOrder); window.removeEventListener("vpc:order-cancelled", onCustomerCancellation); clearTimeout(highlightTimer); };
}
