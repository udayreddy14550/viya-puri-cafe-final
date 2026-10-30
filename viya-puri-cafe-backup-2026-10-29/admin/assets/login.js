"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const f = $("f"), msg = $("msg"), go = $("go");
  const fieldErr = (id, text) => { const e = $("e-" + id), input = $(id === "pw" ? "pw" : id); e.hidden = !text; e.textContent = text || ""; input.setAttribute("aria-invalid", text ? "true" : "false"); };
  const banner = (text, kind) => { msg.hidden = !text; msg.className = "notice " + (kind || "bad"); msg.textContent = text || ""; };

  $("toggle").addEventListener("click", e => {
    const b = e.currentTarget, show = $("pw").type === "password";
    $("pw").type = show ? "text" : "password"; b.textContent = show ? "Hide" : "Show"; b.setAttribute("aria-pressed", String(show));
  });

  // if a session already exists, go straight to the dashboard (the server decides; this is only a convenience)
  fetch("/api/admin/session", { credentials: "same-origin" }).then(r => r.json()).then(j => { if (j.authenticated) location.replace("/admin"); }).catch(() => {});

  f.addEventListener("submit", async e => {
    e.preventDefault(); banner("");
    const email = $("email").value.trim(), password = $("pw").value;
    let bad = false;
    if (!email) { fieldErr("email", "Enter your email address."); bad = true; }
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { fieldErr("email", "Enter a valid email address, like name@example.com."); bad = true; } else fieldErr("email", "");
    if (!password) { fieldErr("pw", "Enter your password."); bad = true; } else fieldErr("pw", "");
    if (bad) { ($("email").getAttribute("aria-invalid") === "true" ? $("email") : $("pw")).focus(); return; }
    go.disabled = true; go.textContent = "Signing in…";
    try {
      const r = await fetch("/api/admin/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { location.assign(j.redirect || "/admin"); return; }
      banner(j.message || "Sign in failed. Please try again.");
      $("pw").value = ""; $("pw").focus();
    } catch { banner("Could not reach the server. Check your connection and try again."); }
    go.disabled = false; go.textContent = "Sign in";
  });
})();
