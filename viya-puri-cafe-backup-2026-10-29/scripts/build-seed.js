#!/usr/bin/env node
"use strict";
/*
 * One-off migration helper (already run; its output is committed in /seed).
 * Reads the ORIGINAL single-file site, evaluates its VPC_CONFIG / VPC_MENU data blocks in a sandbox,
 * writes seed/seed.json and decodes every embedded base64 image into seed/images/*.webp.
 *   node scripts/build-seed.js path/to/viya-puri-cafe.html
 */
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const src = process.argv[2];
if (!src) { console.error("usage: node scripts/build-seed.js <original.html>"); process.exit(1); }
const html = fs.readFileSync(src, "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const cfgJs = scripts.find(s => s.includes("window.VPC_CONFIG ="));
const menuJs = scripts.find(s => s.includes("window.VPC_MENU="));
if (!cfgJs || !menuJs) throw new Error("Could not find VPC_CONFIG / VPC_MENU blocks");
const sandbox = { window: {} }; vm.createContext(sandbox);
vm.runInContext(cfgJs, sandbox); vm.runInContext(menuJs, sandbox);
const CFG = sandbox.window.VPC_CONFIG, MENU = sandbox.window.VPC_MENU;
const root = path.join(__dirname, "..");
fs.mkdirSync(path.join(root, "seed/images"), { recursive: true });
let n = 0;
for (const it of MENU.items) {
  const m = /^data:image\/webp;base64,(.+)$/.exec(it.img || "");
  if (m) { const file = it.id + ".webp"; fs.writeFileSync(path.join(root, "seed/images", file), Buffer.from(m[1], "base64")); it.img = "/uploads/menu/" + file; n++; }
  else it.img = it.img || null;
}
const logos = [...html.matchAll(/<img class="(?:logo-img|footer-logo)" src="data:image\/webp;base64,([^"]+)"/g)].map(m => m[1]);
if (logos.length) { fs.mkdirSync(path.join(root, "public/assets"), { recursive: true }); fs.writeFileSync(path.join(root, "public/assets/logo.webp"), Buffer.from(logos[0], "base64")); }
fs.writeFileSync(path.join(root, "seed/seed.json"), JSON.stringify({ config: CFG, menu: MENU }, null, 2));
console.log(`seed.json written; ${n} images extracted; logos found: ${logos.length} (identical: ${logos.every(l => l === logos[0])})`);
