#!/usr/bin/env node
"use strict";
/* Fills in descriptions for existing menu items from seed/descriptions.json.
 * Only items whose description is currently EMPTY are touched, so anything you wrote yourself in the admin is never overwritten.
 *   npm run add-descriptions
 */
const fs = require("node:fs"), path = require("node:path");
const { db, now, audit, migrate } = require("../server/db");
const cfg = require("../server/config");
migrate();
const map = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, "seed", "descriptions.json"), "utf8"));
const upd = db.prepare("UPDATE menu_items SET description = ?, updated_at = ? WHERE id = ? AND TRIM(description) = ''");
let changed = 0, missing = 0;
for (const [id, text] of Object.entries(map)) {
  const r = upd.run(text, now(), id);
  if (r.changes) changed++; else if (!db.prepare("SELECT 1 FROM menu_items WHERE id = ?").get(id)) missing++;
}
if (changed) audit("cli", "update", "menu", null, `Added descriptions to ${changed} menu items`);
console.log(`Descriptions added: ${changed}. Already had a description (left alone): ${Object.keys(map).length - changed - missing}. Not on your menu: ${missing}.`);
