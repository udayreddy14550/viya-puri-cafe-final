import { h, mount, clear, api, money, toast, busy, modal, confirmDialog, empty, skeleton, errorBox, field, showFieldError, debounce } from "/admin/assets/ui.js";

let data = null;
const ui = { q: "", cat: "all", avail: "all", sort: "manual" };

export async function render(root, { params }) {
  if (params.get("filter") === "available") ui.avail = "available"; else if (params.get("filter") === "soldout") ui.avail = "soldout"; else if (params.has("filter")) ui.avail = "all";
  const load = async () => {
    mount(root, skeleton(6));
    try { data = await api("GET", "/menu"); } catch (e) { return mount(root, errorBox(e, load)); }
    draw();
  };
  const draw = () => {
    const catName = id => (data.categories.find(c => c.id === id) || {}).name || "";
    let items = data.items.filter(i => (ui.cat === "all" || i.categoryId === ui.cat) && (ui.avail === "all" || (ui.avail === "available") === i.available) && (!ui.q || (i.name + " " + catName(i.categoryId)).toLowerCase().includes(ui.q.toLowerCase())));
    if (ui.sort === "name") items = [...items].sort((a, b) => a.name.localeCompare(b.name));
    if (ui.sort === "price") items = [...items].sort((a, b) => Math.min(...a.sizes.map(s => s.price)) - Math.min(...b.sizes.map(s => s.price)));
    if (ui.sort === "updated") items = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const search = h("input", { type: "search", id: "mq", value: ui.q, placeholder: "Search items", "aria-label": "Search items" });
    search.addEventListener("input", debounce(() => { ui.q = search.value; draw(); const s = document.getElementById("mq"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250));
    const sel = (id, label, val, opts, set) => { const s = h("select", { id }, opts.map(([v, t]) => h("option", { value: v, selected: v === val }, t))); s.addEventListener("change", () => { set(s.value); draw(); }); return h("div", { class: "field" }, h("label", { for: id }, label), s); };
    mount(root,
      h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Menu"), h("p", {}, `${data.items.length} items in ${data.categories.length} categories. Saved changes appear on the website straight away.`)),
        h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, h("button", { class: "btn ghost", type: "button", onclick: () => categoriesDialog(load) }, "Categories"), h("button", { class: "btn primary", type: "button", onclick: () => editor(null, load) }, "Add item"))),
      h("div", { class: "toolbar", style: { marginBottom: "16px" } }, h("div", { class: "field grow" }, h("label", { for: "mq" }, "Search"), search),
        sel("mc", "Category", ui.cat, [["all", "All categories"], ...data.categories.map(c => [c.id, c.name])], v => (ui.cat = v)),
        sel("ma", "Availability", ui.avail, [["all", "All"], ["available", "Available"], ["soldout", "Sold out"]], v => (ui.avail = v)),
        sel("ms", "Sort", ui.sort, [["manual", "Menu order"], ["name", "Name"], ["price", "Lowest price"], ["updated", "Recently changed"]], v => (ui.sort = v))),
      items.length ? h("div", { class: "menu-grid" }, items.map(i => card(i, catName(i.categoryId), load)))
        : data.items.length ? empty("No items match", "Try a different search or filter.", h("button", { class: "btn ghost sm", type: "button", onclick: () => { Object.assign(ui, { q: "", cat: "all", avail: "all" }); draw(); } }, "Clear filters"))
        : empty("The menu is empty", "Add your first item to show it on the website.", h("button", { class: "btn primary", type: "button", onclick: () => editor(null, load) }, "Add item")));
  };
  await load();
  if (params.get("new")) editor(null, load);
}

function card(i, cat, reload) {
  const range = i.sizes.length ? (i.sizes.length > 1 ? `${money(Math.min(...i.sizes.map(s => s.price)))} – ${money(Math.max(...i.sizes.map(s => s.price)))}` : money(i.sizes[0].price)) : "No price";
  const sw = h("input", { type: "checkbox", checked: i.available, "aria-label": `${i.name} is available` });
  sw.addEventListener("change", async () => {
    const want = sw.checked; sw.disabled = true;
    try { await api("PATCH", `/menu/items/${encodeURIComponent(i.id)}/availability`, { available: want }); i.available = want; toast(`${i.name} is now ${want ? "available" : "sold out"}.`); reload(); }
    catch (e) { sw.checked = !want; toast(e.message, "bad"); } finally { sw.disabled = false; }
  });
  return h("article", { class: "item-card", "data-sold": String(!i.available) },
    i.image ? h("img", { src: i.image, alt: "", loading: "lazy" }) : h("div", { class: "ph" }, "No photo"),
    h("div", { class: "body" },
      h("h3", {}, h("span", { class: "vd" + (i.veg ? "" : " nv"), role: "img", "aria-label": i.veg ? "Vegetarian" : "Non-vegetarian" }), i.name),
      h("div", { class: "muted small" }, cat + " · " + range), i.description ? h("p", { class: "small" }, i.description) : null,
      h("div", { class: "muted small" }, i.sizes.map(s => `${s.label} ${money(s.price)}`).join(" · ")),
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
        h("label", { class: "switch" }, sw, i.available ? "Available" : "Sold out"),
        h("span", { style: { display: "flex", gap: "6px" } }, h("button", { class: "btn ghost sm", type: "button", onclick: () => editor(i, reload) }, "Edit"),
          h("button", { class: "btn ghost sm", type: "button", onclick: () => remove(i, reload) }, "Delete")))));
}

async function remove(i, reload) {
  if (!(await confirmDialog({ title: "Delete this item?", message: `“${i.name}” will be removed from the menu and the website. Past orders keep their record of it. This can't be undone.`, confirmText: "Delete item", danger: true }))) return;
  try { await api("DELETE", `/menu/items/${encodeURIComponent(i.id)}`); toast(`Deleted “${i.name}”.`); reload(); } catch (e) { toast(e.message, "bad"); }
}

function editor(item, reload) {
  const isNew = !item;
  const st = { image: item?.image || null, file: null, sizes: (item?.sizes || [{ label: "Regular", price: "" }]).map(s => ({ ...s })) };
  const name = h("input", { type: "text", "data-field": "name", maxlength: 80, value: item?.name || "", required: true });
  const desc = h("textarea", { "data-field": "description", maxlength: 400, placeholder: "Optional. A short line about the item." }); desc.value = item?.description || "";
  const cat = h("select", { "data-field": "categoryId" }, data.categories.map(c => h("option", { value: c.id, selected: c.id === (item?.categoryId || (ui.cat !== "all" ? ui.cat : data.categories[0]?.id)) }, c.name)));
  const veg = h("select", { "data-field": "veg" }, h("option", { value: "1", selected: item ? item.veg : true }, "Vegetarian"), h("option", { value: "0", selected: item ? !item.veg : false }, "Non-vegetarian"));
  const photoType = h("select", { "data-field": "photoType" }, h("option", { value: "actual", selected: (item?.photoType || "actual") === "actual" }, "Photo of our own dish"), h("option", { value: "representative", selected: item?.photoType === "representative" }, "Representative image (stock or illustrative)"));
  const tint = h("input", { type: "color", "data-field": "tint", value: item?.tint || "#e6c08e", "aria-label": "Placeholder colour", style: { minHeight: "42px", padding: "2px" } });
  const avail = h("input", { type: "checkbox", checked: item ? item.available : true });
  const file = h("input", { type: "file", id: "pf", accept: "image/jpeg,image/png,image/webp", "data-field": "image" });
  const sizesBox = h("div", { class: "sizes-edit" });
  const preview = h("div", { class: "preview", "aria-label": "Preview" });
  const fileNote = h("span", { class: "hint" }, "JPEG, PNG or WebP, up to 3 MB. Square photos look best.");

  const drawSizes = () => {
    clear(sizesBox);
    st.sizes.forEach((s, idx) => {
      const l = h("input", { type: "text", value: s.label, maxlength: 30, "aria-label": `Size ${idx + 1} name`, placeholder: "e.g. Medium" }), p = h("input", { type: "number", value: s.price, min: 0, step: 1, inputmode: "numeric", "aria-label": `Price for ${s.label || "size " + (idx + 1)}`, placeholder: "₹" });
      l.addEventListener("input", () => { s.label = l.value; drawPreview(); }); p.addEventListener("input", () => { s.price = p.value; drawPreview(); });
      sizesBox.append(h("div", { class: "size-row" }, l, p, h("button", { class: "btn ghost sm", type: "button", disabled: st.sizes.length === 1, "aria-label": `Remove size ${idx + 1}`, onclick: () => { st.sizes.splice(idx, 1); drawSizes(); drawPreview(); } }, "Remove")));
    });
    sizesBox.append(h("button", { class: "btn ghost sm", type: "button", disabled: st.sizes.length >= 8, onclick: () => { st.sizes.push({ label: "", price: "" }); drawSizes(); } }, "Add another size"));
  };
  let objUrl = null;
  const drawPreview = () => {
    const src = objUrl || st.image;
    const first = st.sizes[0] || {};
    mount(preview, src ? h("img", { src, alt: "" }) : h("div", { class: "ph", style: { "--tint": tint.value } }, "No photo yet"),
      h("div", { class: "pb" }, h("b", {}, h("span", { class: "vd" + (veg.value === "1" ? "" : " nv") }), name.value || "Item name"), desc.value ? h("span", { class: "small muted" }, desc.value) : null,
        h("div", { class: "small muted" }, st.sizes.filter(s => s.label || s.price !== "").map(s => `${s.label || "?"} ${s.price === "" ? "" : money(s.price)}`).join(" · ") || "Add a size and price"),
        avail.checked ? h("span", { class: "badge ok" }, "Available") : h("span", { class: "badge bad" }, "Sold out")));
    preview.style.setProperty("--tint", tint.value);
  };
  [name, desc, veg, tint, avail].forEach(e => e.addEventListener("input", drawPreview));
  file.addEventListener("change", () => {
    const f = file.files[0]; st.file = null; if (objUrl) URL.revokeObjectURL(objUrl); objUrl = null;
    if (f) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast("Choose a JPEG, PNG or WebP image.", "bad"); file.value = ""; }
      else if (f.size > 3 * 1024 * 1024) { toast("That image is over 3 MB. Choose a smaller one.", "bad"); file.value = ""; }
      else { st.file = f; objUrl = URL.createObjectURL(f); }
    }
    drawPreview();
  });
  drawSizes(); drawPreview();

  const form = h("form", { novalidate: true, class: "editor" },
    h("div", { style: { display: "grid", gap: "14px", minWidth: 0 } },
      field("Name", name), field("Description", desc),
      h("div", { class: "grid2" }, field("Category", cat), field("Type", veg)),
      h("div", { class: "field" }, h("span", { class: "label" }, "Sizes and prices"), h("span", { class: "hint" }, "Each size has its own price in rupees. Items with one size show just one price."), sizesBox, h("span", { class: "err", hidden: true, "data-err": "sizes" }), h("input", { type: "hidden", "data-field": "sizes" })),
      h("div", { class: "grid2" }, field("Photo", file, { hint: undefined }), field("Photo label", photoType)), fileNote,
      item?.image && h("button", { class: "link", type: "button", style: { justifySelf: "start" }, onclick: () => { st.image = null; st.file = null; file.value = ""; if (objUrl) URL.revokeObjectURL(objUrl); objUrl = null; drawPreview(); toast("Photo will be removed when you save."); } }, "Remove current photo"),
      h("div", { class: "grid2" }, field("Placeholder colour", tint, { hint: "Shown while a photo loads or if there isn't one." }), h("div", { class: "field" }, h("span", { class: "label" }, "Availability"), h("label", { class: "switch" }, avail, "Available to order")))),
    h("div", { style: { display: "grid", gap: "8px", alignContent: "start" } }, h("span", { class: "label" }, "Preview (as customers see it)"), preview, h("p", { class: "small muted" }, "Nothing changes on the website until you press Save.")));

  const save = h("button", { class: "btn primary", type: "button" }, isNew ? "Add to menu" : "Save changes");
  const m = modal({ title: isNew ? "Add menu item" : `Edit ${item.name}`, body: form, wide: true, footer: [h("button", { class: "btn ghost", type: "button", onclick: () => m.close() }, "Cancel"), save] });
  m.el.addEventListener("close", () => { if (objUrl) URL.revokeObjectURL(objUrl); });
  save.addEventListener("click", () => busy(save, async () => {
    try {
      if (st.file) { const fd = new FormData(); fd.append("file", st.file); const up = await api("POST", "/uploads", fd); st.image = up.url; st.file = null; }
      const body = { name: name.value, description: desc.value, categoryId: cat.value, veg: veg.value === "1", available: avail.checked, tint: tint.value, photoType: photoType.value, image: st.image,
        sizes: st.sizes.map(s => ({ id: s.id, label: s.label, price: s.price === "" ? "" : Number(s.price) })) };
      await api(isNew ? "POST" : "PUT", isNew ? "/menu/items" : `/menu/items/${encodeURIComponent(item.id)}`, body);
      toast(isNew ? `“${name.value}” was added and is live on the website.` : "Changes saved. The website now shows them.");
      m.close(); reload();
    } catch (e) { if (!showFieldError(form, e)) throw e; toast(e.message, "bad"); }
  }));
}

function categoriesDialog(reload) {
  const body = h("div", { style: { display: "grid", gap: "14px" } });
  const m = modal({ title: "Menu categories", body, footer: [h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Done")] });
  m.el.addEventListener("close", reload);
  const draw = async () => {
    try { data = await api("GET", "/menu"); } catch (e) { return mount(body, errorBox(e, draw)); }
    const addName = h("input", { type: "text", maxlength: 40, placeholder: "New category name", "aria-label": "New category name" });
    const add = h("button", { class: "btn primary sm", type: "button" }, "Add category");
    add.addEventListener("click", () => busy(add, async () => { await api("POST", "/menu/categories", { name: addName.value }); toast("Category added."); draw(); }));
    mount(body, h("p", { class: "muted small" }, "Categories group the menu on the website. Lower order numbers show first."),
      h("div", { class: "table-wrap" }, h("table", { style: { minWidth: "0" } }, h("thead", {}, h("tr", {}, ["Name", "Order", "Items", ""].map(x => h("th", {}, x)))),
        h("tbody", {}, data.categories.map(c => {
          const n = h("input", { type: "text", value: c.name, maxlength: 40, "aria-label": "Category name" }), o = h("input", { type: "number", value: c.sortOrder, min: 0, style: { width: "80px" }, "aria-label": `Order for ${c.name}` });
          const sv = h("button", { class: "btn ghost sm", type: "button" }, "Save"), del = h("button", { class: "btn ghost sm", type: "button" }, "Delete");
          sv.addEventListener("click", () => busy(sv, async () => { await api("PUT", `/menu/categories/${encodeURIComponent(c.id)}`, { name: n.value, sortOrder: Number(o.value) }); toast("Category saved."); draw(); }));
          del.addEventListener("click", async () => { if (!(await confirmDialog({ title: "Delete category?", message: `Delete “${c.name}”? Only empty categories can be deleted.`, confirmText: "Delete", danger: true }))) return; try { await api("DELETE", `/menu/categories/${encodeURIComponent(c.id)}`); toast("Category deleted."); draw(); } catch (e) { toast(e.message, "bad"); } });
          return h("tr", {}, h("td", {}, n), h("td", {}, o), h("td", {}, String(c.itemCount)), h("td", { class: "actions" }, sv, " ", del));
        })))),
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, h("div", { style: { flex: "1 1 200px" } }, addName), add));
  };
  draw();
}
