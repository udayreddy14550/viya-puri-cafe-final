#!/usr/bin/env node
"use strict";
/*
 * Creates (or resets the password of) an administrator. This is the ONLY way to create admins:
 * there is no public registration endpoint. Run it on the server.
 *   npm run create-admin                       (interactive; password is typed hidden)
 *   ADMIN_EMAIL=.. ADMIN_PASSWORD=.. npm run create-admin     (non-interactive; avoid shell history)
 */
const readline = require("node:readline");
const { db, migrate, now, audit } = require("../server/db");
const { hashPassword, passwordProblem } = require("../server/security");
migrate();

function ask(q, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); else if (/[\r\n]/.test(s)) process.stdout.write("\n"); }; }
    rl.question(q, a => { rl.close(); resolve(a); });
  });
}
(async () => {
  let email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || "";
  const interactive = !(email && pw);
  if (!email) email = (await ask("Admin email: ")).trim().toLowerCase();
  if (!/^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 254) { console.error("That does not look like a valid email address."); process.exit(1); }
  if (!pw) {
    pw = await ask("Password (min 12 characters, hidden): ", true);
    const again = await ask("Repeat password: ", true);
    if (pw !== again) { console.error("The passwords do not match."); process.exit(1); }
  }
  const problem = passwordProblem(pw, email);
  if (problem) { console.error("Password rejected: " + problem); process.exit(1); }
  const hash = await hashPassword(pw);
  const existing = db.prepare("SELECT id FROM admins WHERE email = ?").get(email);
  if (existing) {
    db.prepare("UPDATE admins SET password_hash = ?, active = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?").run(hash, existing.id);
    db.prepare("DELETE FROM sessions WHERE admin_id = ?").run(existing.id);   // old sessions end when the password is reset
    audit("cli", "password", "admin", existing.id, `Password reset for ${email} via command line`);
    console.log(`Password updated for ${email}. Existing sessions were signed out.`);
  } else {
    const r = db.prepare("INSERT INTO admins(email, password_hash, created_at) VALUES(?,?,?)").run(email, hash, now());
    audit("cli", "create", "admin", r.lastInsertRowid, `Created administrator ${email} via command line`);
    console.log(`Administrator created: ${email}\nSign in at /admin/login`);
  }
  if (!interactive) console.log("Tip: clear ADMIN_PASSWORD from your shell history / environment now.");
})();
