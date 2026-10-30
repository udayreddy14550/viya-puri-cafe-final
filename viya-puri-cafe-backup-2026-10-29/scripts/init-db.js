#!/usr/bin/env node
"use strict";
/* Creates the database schema (idempotent) and, on a brand-new database only, loads the café's existing menu, settings and coupons from /seed. */
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const cfg = require("../server/config");
const { migrate, seedIfEmpty, db } = require("../server/db");

// First run: create .env from .env.example with a freshly generated SESSION_SECRET (never overwrites an existing .env)
const envFile = path.join(cfg.ROOT, ".env"), example = path.join(cfg.ROOT, ".env.example");
if (!fs.existsSync(envFile) && fs.existsSync(example)) {
  fs.writeFileSync(envFile, fs.readFileSync(example, "utf8").replace("replace-with-a-long-random-string", crypto.randomBytes(48).toString("base64url")), { mode: 0o600 });
  console.log("Created .env with a new random SESSION_SECRET.");
}
migrate();
const seeded = seedIfEmpty();
const n = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`Database ready at ${cfg.dbPath}`);
console.log(seeded ? "Loaded the existing menu, settings and coupons." : "Database already contained data, nothing was overwritten.");
console.log(`  categories: ${n("categories")}, menu items: ${n("menu_items")}, coupons: ${n("coupons")}, admins: ${n("admins")}`);
if (!n("admins")) console.log("Next step: npm run create-admin");
