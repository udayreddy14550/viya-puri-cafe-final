import { h, $, mount, api, session, toast, busy, skeleton, errorBox, confirmDialog } from "/admin/assets/ui.js";
import { startOrderAlerts } from "/admin/assets/order-alerts.js";

const ICON = {
  dashboard: "M3 12 12 3l9 9M5 10v10h5v-6h4v6h5V10", menu: "M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 3c-2 2-3 5-3 8h3v10",
  orders: "M6 3h12l2 4v14H4V7zM4 7h16M9 11h6", offers: "M3 12 12 3h9v9l-9 9zM16 8h.01", reports: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  messages: "M3 5h18v14H3zM3 7l9 7 9-7", settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1-2-1-1-2h-4l-1 2-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 2h4l1-2 2-1 2 1 2-4-2-1z",
  staff: "M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 8v6M23 11h-6",
};
const svg = d => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); return s; };

const ROUTES = [
  { id: "dashboard", label: "Dashboard", mod: "/admin/assets/v-dashboard.js" },
  { id: "menu", label: "Menu", mod: "/admin/assets/v-menu.js" },
  { id: "orders", label: "Orders", mod: "/admin/assets/v-orders.js", pill: "pending" },
  { id: "offers", label: "Offers & coupons", mod: "/admin/assets/v-coupons.js", icon: "offers" },
  { id: "reports", label: "Reports", mod: "/admin/assets/v-reports.js" },
  { id: "messages", label: "Messages", mod: "/admin/assets/v-messages.js", pill: "messages" },
  { id: "staff", label: "Staff accounts", mod: "/admin/assets/v-staff.js", icon: "staff", ownerOnly: true },
  { id: "settings", label: "Café settings", mod: "/admin/assets/v-settings.js", icon: "settings" },
];
const view = $("#view"), app = $("#app");
let cleanup = null, token = 0;
const visibleRoutes = () => session.role === "staff" ? ROUTES.filter(r => r.id === "orders") : ROUTES;

function buildNav(pills = {}) {
  const cur = location.hash.replace(/^#\//, "").split("?")[0] || (session.role === "staff" ? "orders" : "dashboard");
  mount($("#nav"), ...visibleRoutes().map(r => h("a", { href: "#/" + r.id, "aria-current": r.id === cur ? "page" : null }, svg(ICON[r.icon || r.id]), r.label,
    r.pill && pills[r.pill] ? h("span", { class: "pill", "aria-label": pills[r.pill] + " waiting" }, String(pills[r.pill])) : null)));
}
export async function refreshPills() {
  if (session.role === "staff") {
    try { const d = await api("GET", "/orders?pageSize=5"); buildNav({ pending: d.counts.pending }); } catch {}
    return;
  }
  try { const d = await api("GET", "/dashboard"); buildNav({ pending: d.orders.pending, messages: d.unreadMessages }); } catch {}
}
export const navigate = hash => { location.hash = hash; };

async function route() {
  const my = ++token;
  const [id, query = ""] = (location.hash.replace(/^#\//, "") || (session.role === "staff" ? "orders" : "dashboard")).split("?");
  if (session.role === "staff" && id !== "orders") { location.hash = "#/orders"; return; }
  const routes = visibleRoutes();
  const r = routes.find(x => x.id === id) || routes[0];
  if (typeof cleanup === "function") { try { cleanup(); } catch {} } cleanup = null;
  closeNav(); buildNav(); document.title = r.label + " · Viya Puri Café";
  mount(view, skeleton(5));
  try {
    const mod = await import(r.mod);
    if (my !== token) return;
    mount(view);
    cleanup = await mod.render(view, { params: new URLSearchParams(query), refreshPills });
    view.focus({ preventScroll: true }); window.scrollTo(0, 0);
  } catch (e) { if (my === token) mount(view, errorBox(e, route)); }
}

function openNav() { app.dataset.nav = "open"; $("#menuBtn").setAttribute("aria-expanded", "true"); }
function closeNav() { app.dataset.nav = "closed"; $("#menuBtn").setAttribute("aria-expanded", "false"); }
$("#menuBtn").addEventListener("click", () => (app.dataset.nav === "open" ? closeNav() : openNav()));
$("#scrim").addEventListener("click", closeNav);
document.addEventListener("keydown", e => { if (e.key === "Escape" && app.dataset.nav === "open") closeNav(); });

$("#logout").addEventListener("click", e => busy(e.currentTarget, async () => {
  await api("POST", "/logout");
  location.assign("/admin/login");
}));

(async () => {
  try {
    const s = await fetch("/api/admin/session", { credentials: "same-origin" });
    const j = await s.json().catch(() => ({}));
    if (!s.ok || !j.authenticated) return location.replace("/admin/login");
    session.csrf = j.csrfToken; session.email = j.email; session.role = j.role;
    $("#who").textContent = (session.role === "staff" ? "Staff · " : "Owner · ") + j.email;
    startOrderAlerts();
    window.addEventListener("hashchange", route);
    if (!location.hash) location.hash = session.role === "staff" ? "#/orders" : "#/dashboard";
    await route(); refreshPills();
  } catch { mount(view, errorBox(new Error("Could not reach the server."), () => location.reload())); }
})();
