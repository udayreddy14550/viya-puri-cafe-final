import { h, api, dt, toast, busy, field, modal, confirmDialog } from "/admin/assets/ui.js";

const passwordHint = "At least 12 characters; mix at least three of lowercase, uppercase, numbers and symbols.";

async function load(view) {
  view.replaceChildren(h("div", { class: "skel", style: { height: "46px" } }));
  const { staff } = await api("GET", "/staff");
  const email = h("input", { type: "email", name: "email", autocomplete: "off", required: true, maxlength: 254 });
  const password = h("input", { type: "password", name: "password", autocomplete: "new-password", required: true, minlength: 12, maxlength: 200 });
  const createForm = h("form", { class: "panel staff-create" },
    h("header", {}, h("h2", {}, "Add a staff account")),
    h("p", { class: "muted small" }, "Staff can view and update orders only. They cannot access café settings, reports, menu management, or staff accounts."),
    h("div", { class: "staff-form-grid" },
      field("Email address", email),
      field("Temporary password", password, { hint: passwordHint })),
    h("button", { class: "btn primary", type: "submit" }, "Create staff account"));
  createForm.addEventListener("submit", e => {
    e.preventDefault();
    const button = createForm.querySelector('button[type="submit"]');
    busy(button, async () => {
      await api("POST", "/staff", { email: email.value, password: password.value });
      createForm.reset();
      await load(view);
      toast("Staff account created.");
    });
  });

  const rows = staff.map(account => h("tr", {},
    h("td", {}, h("strong", {}, account.email)),
    h("td", {}, h("span", { class: "badge " + (account.active ? "ok" : "cancelled") }, account.active ? "Active" : "Inactive")),
    h("td", {}, account.lastLoginAt ? dt(account.lastLoginAt) : "Never"),
    h("td", {}, dt(account.createdAt)),
    h("td", { class: "actions" },
      h("button", { class: "btn ghost sm", type: "button", onclick: () => resetPassword(account, view) }, "Reset password"),
      " ",
      h("button", { class: "btn " + (account.active ? "danger" : "ghost") + " sm", type: "button", onclick: () => toggleActive(account, view) }, account.active ? "Deactivate" : "Reactivate"))));
  const table = h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, ...["Staff account", "Status", "Last sign in", "Created", ""].map(title => h("th", {}, title)))),
    h("tbody", {}, rows.length ? rows : [h("tr", {}, h("td", { colspan: "5" }, "No staff accounts yet."))])));
  const list = h("section", { class: "panel" }, h("header", {}, h("h2", {}, "Staff accounts"), h("span", { class: "muted small" }, `${staff.length} account${staff.length === 1 ? "" : "s"}`)), table);
  view.replaceChildren(h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Staff accounts"), h("p", { class: "muted" }, "Create and manage accounts for staff who handle orders."))), createForm, list);
}

async function toggleActive(account, view) {
  const active = !account.active;
  const confirmed = await confirmDialog({
    title: active ? "Reactivate staff account?" : "Deactivate staff account?",
    message: active
      ? `${account.email} will be able to sign in and manage orders again.`
      : `${account.email} will be signed out immediately and will no longer be able to sign in.`,
    confirmText: active ? "Reactivate" : "Deactivate",
    danger: !active,
  });
  if (!confirmed) return;
  try {
    await api("PATCH", `/staff/${account.id}/active`, { active });
    toast(active ? "Staff account reactivated." : "Staff account deactivated.");
    await load(view);
  } catch (error) { toast(error.message, "bad"); }
}

function resetPassword(account, view) {
  const input = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 12, maxlength: 200 });
  const form = h("form", {}, field("New temporary password", input, { hint: passwordHint }),
    h("p", { class: "muted small" }, "The staff member will be signed out of all devices. Give the new password to them securely."));
  const dialog = modal({
    title: `Reset password for ${account.email}`,
    body: form,
    footer: [
      h("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"),
      h("button", { class: "btn primary", type: "submit", form: "staff-password-form" }, "Reset password"),
    ],
  });
  form.id = "staff-password-form";
  form.addEventListener("submit", e => {
    e.preventDefault();
    const button = dialog.el.querySelector('button[type="submit"]');
    busy(button, async () => {
      await api("PUT", `/staff/${account.id}/password`, { password: input.value });
      dialog.close();
      toast("Password reset. The staff member must sign in with the new password.");
      await load(view);
    });
  });
  input.focus();
}

export async function render(view) {
  await load(view);
}
