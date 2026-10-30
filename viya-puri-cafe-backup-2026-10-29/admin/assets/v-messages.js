import { h, mount, api, dtFull, toast, confirmDialog, empty, skeleton, errorBox } from "/admin/assets/ui.js";
export async function render(root, { refreshPills }) {
  const load = async () => {
    mount(root, skeleton(3));
    let d; try { d = await api("GET", "/messages"); } catch (e) { return mount(root, errorBox(e, load)); }
    mount(root, h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Messages"), h("p", {}, "Sent from the contact form on your website."))),
      d.messages.length ? h("div", { style: { display: "grid", gap: "12px" } }, d.messages.map(m => h("article", { class: "panel" },
        h("header", {}, h("div", {}, h("b", {}, m.name), " ", !m.isRead && h("span", { class: "badge pending" }, "New"), h("div", { class: "muted small" }, m.contact + " · " + dtFull(m.createdAt))),
          h("span", { style: { display: "flex", gap: "8px" } }, h("button", { class: "btn ghost sm", type: "button", onclick: async () => { try { await api("PATCH", "/messages/" + m.id, { isRead: !m.isRead }); load(); refreshPills(); } catch (e) { toast(e.message, "bad"); } } }, m.isRead ? "Mark unread" : "Mark read"),
            h("button", { class: "btn ghost sm", type: "button", onclick: async () => { if (await confirmDialog({ title: "Delete message?", message: "This can't be undone.", confirmText: "Delete", danger: true })) try { await api("DELETE", "/messages/" + m.id); load(); refreshPills(); } catch (e) { toast(e.message, "bad"); } } }, "Delete"))),
        h("p", { style: { whiteSpace: "pre-wrap" } }, m.message)))) : empty("No messages", "Messages appear here once the contact form is switched on in Café settings."));
  };
  await load();
}
