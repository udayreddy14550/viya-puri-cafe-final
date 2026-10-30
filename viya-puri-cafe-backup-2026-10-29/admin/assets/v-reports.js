import { h, mount, api, money, badge, empty, skeleton, errorBox, ymd, addDays, STATUS_LABEL } from "/admin/assets/ui.js";
const st = { from: addDays(ymd(), -29), to: ymd() };

export async function render(root) {
  const load = async () => {
    mount(root, skeleton(5));
    let d; try { d = await api("GET", `/reports?from=${st.from}&to=${st.to}`); } catch (e) { return draw(null, e); }
    draw(d);
  };
  const preset = (label, days) => h("button", { class: "chip", type: "button", onclick: () => { st.to = ymd(); st.from = addDays(st.to, -(days - 1)); load(); } }, label);
  const draw = (d, err) => {
    const from = h("input", { type: "date", id: "rf", value: st.from, max: ymd() }), to = h("input", { type: "date", id: "rt", value: st.to, max: ymd() });
    const go = h("button", { class: "btn primary", type: "button", onclick: () => { st.from = from.value; st.to = to.value; load(); } }, "Show report");
    const head = [h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Reports"), h("p", {}, "Calculated from your actual order records. Cancelled orders are not counted as sales."))),
      h("div", { class: "toolbar", style: { marginBottom: "16px" } }, h("div", { class: "field" }, h("label", { for: "rf" }, "From"), from), h("div", { class: "field" }, h("label", { for: "rt" }, "To"), to), go,
        h("div", { class: "chips" }, preset("Today", 1), preset("7 days", 7), preset("30 days", 30), preset("90 days", 90)))];
    if (err) return mount(root, ...head, errorBox(err, load));
    const t = d.totals, max = Math.max(1, ...d.byDay.map(x => x.sales));
    const days = d.byDay.length > 62 ? null : d.byDay;
    mount(root, ...head,
      h("div", { class: "cards" }, [["Orders placed", t.orders, `${t.cancelled} cancelled`], ["Sales", money(t.sales), `From ${t.countedOrders} orders`], ["Average order", money(t.averageOrder), ""], ["Completed sales", money(t.completedSales), "Orders marked completed"], ["Cash received", money(t.paidSales), "Marked as paid"]].map(([k, n, s]) => h("div", { class: "stat" }, h("span", { class: "k" }, k), h("span", { class: "n" }, String(n)), s && h("span", { class: "s" }, s)))),
      !t.orders ? empty("No orders in this period", "Pick a wider date range, or wait for orders to come in.") : h("div", { class: "cols" },
        h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Sales summary")),
          h("p", {}, `Between ${d.range.from} and ${d.range.to} there were ${t.orders} orders. ${t.cancelled} were cancelled, leaving ${t.countedOrders} orders worth ${money(t.sales)}. ${t.completedSales === t.sales ? "All of them are completed." : `${money(t.completedSales)} of that is from completed orders.`}`),
          days ? h("div", { class: "table-wrap", style: { maxHeight: "340px", overflow: "auto" } }, h("table", { style: { minWidth: "0" } }, h("thead", {}, h("tr", {}, ["Date", "Orders", "Sales", ""].map(x => h("th", {}, x)))), h("tbody", {}, [...days].reverse().map(x => h("tr", {}, h("td", {}, x.date), h("td", {}, String(x.orders)), h("td", { class: "mono" }, money(x.sales)), h("td", { style: { width: "35%" } }, h("div", { class: "col" + (x.sales ? "" : " zero"), style: { height: "10px", width: Math.max(2, Math.round(x.sales / max * 100)) + "%", borderRadius: "999px", background: x.sales ? "var(--accent)" : "var(--line)" } }))))))) : h("p", { class: "muted small" }, "Choose 62 days or fewer to see the day-by-day table.")),
        h("div", { style: { display: "grid", gap: "16px", alignContent: "start", minWidth: 0 } },
          h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Popular items")), d.enoughData ? h("div", { class: "list" }, d.popular.map((p, i) => h("div", {}, h("span", {}, `${i + 1}. ${p.name}`), h("span", { class: "muted small nowrap" }, `${p.qty} sold · ${money(p.revenue)}`)))) : h("p", { class: "muted small" }, "Needs at least 5 orders in the period to be meaningful. " + (d.popular.length ? "So far: " + d.popular.slice(0, 3).map(p => `${p.name} (${p.qty})`).join(", ") + "." : ""))),
          h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Orders by status")), h("div", { class: "list" }, Object.entries(d.byStatus).map(([s, n]) => h("div", {}, badge(s), h("b", {}, String(n)))))))));
  };
  await load();
}
