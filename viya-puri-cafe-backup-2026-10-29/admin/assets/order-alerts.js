import { h, money } from "/admin/assets/ui.js";

const SOUND_KEY = "vpc.admin.orderSound";
const CURSOR_KEY = "vpc.admin.orderCursor";
const SEEN_KEY = "vpc.admin.seenOrderEvents";
const REF_PATTERN = /^VPC-\d{6}-[A-Z2-9]{4}$/;

let source = null, audio = null, alertRoot = null, statusText = null;
let soundEnabled = false, soundReady = false;
const seenInMemory = new Set();

function getStorage(name) {
  try { return window[name]; } catch { return null; }
}
function readStorage(name, key, fallback) {
  try { const storage = getStorage(name); return storage ? storage.getItem(key) ?? fallback : fallback; } catch { return fallback; }
}
function writeStorage(name, key, value) {
  try { const storage = getStorage(name); if (!storage) return false; storage.setItem(key, value); return true; } catch { return false; }
}
function soundPreference() {
  return readStorage("localStorage", SOUND_KEY, "false") === "true";
}
function seenEvent(id) {
  if (seenInMemory.has(String(id))) return true;
  let seen = [];
  try { seen = JSON.parse(readStorage("localStorage", SEEN_KEY, "[]")); } catch {}
  if (!Array.isArray(seen)) seen = [];
  if (seen.includes(String(id))) return true;
  seen.push(String(id));
  seenInMemory.add(String(id));
  if (seenInMemory.size > 100) seenInMemory.delete(seenInMemory.values().next().value);
  writeStorage("localStorage", SEEN_KEY, JSON.stringify(seen.slice(-100)));
  return false;
}

async function getAudioContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error("This browser does not support audio alerts.");
  if (!audio) audio = new AudioContext();
  if (audio.state !== "running") await audio.resume();
  if (audio.state !== "running") throw new Error("The browser has not enabled audio for this page.");
  return audio;
}

async function playChime() {
  if (!soundEnabled || !soundReady) return false;
  try {
    const ctx = audio;
    if (!ctx || ctx.state !== "running") throw new Error("Audio is paused by the browser. Use Test sound to enable it again.");
    const notes = [659.25, 783.99, 987.77, 783.99];
    const start = ctx.currentTime + 0.02;
    notes.forEach((frequency, index) => {
      const at = start + index * 0.19;
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      oscillator.connect(gain); gain.connect(ctx.destination);
      oscillator.start(at); oscillator.stop(at + 0.17);
    });
    return true;
  } catch (error) {
    if (statusText) statusText.textContent = error.message || "Sound is unavailable; dashboard alerts will still appear.";
    return false;
  }
}

function openOrder(reference) {
  if (!REF_PATTERN.test(reference)) return;
  location.hash = "#/orders?open=" + encodeURIComponent(reference);
  window.focus();
}

function showAlert(order, id, type = "new_order") {
  if (!alertRoot) return;
  const key = String(id);
  const cancelled = type === "order_cancelled";
  const card = h("article", { class: "order-alert" + (cancelled ? " order-alert-cancelled" : ""), role: "alert" },
    h("div", { class: "order-alert-copy" },
      h("strong", {}, cancelled ? "ORDER CANCELLED BY CUSTOMER" : "NEW ORDER RECEIVED"),
      h("span", {}, order.reference),
      h("b", {}, money(order.total))),
    h("div", { class: "order-alert-actions" },
      h("button", { class: "btn primary sm", type: "button", onclick: () => openOrder(order.reference) }, "View order"),
      h("button", { class: "btn ghost sm", type: "button", "aria-label": "Dismiss new order alert", onclick: () => card.remove() }, "Dismiss")));
  card.dataset.eventId = key;
  alertRoot.prepend(card);
  while (alertRoot.querySelectorAll(".order-alert").length > 5) alertRoot.lastElementChild.remove();

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const notification = new Notification(cancelled ? "Order cancelled — Viya Puri Café" : "New order — Viya Puri Café", {
        body: `${order.reference} · ${money(order.total)}${cancelled ? " · Customer cancelled" : ""}`,
        tag: `vpc-order-${cancelled ? "cancelled-" : ""}${key}`,
      });
      notification.onclick = () => { notification.close(); openOrder(order.reference); };
      setTimeout(() => notification.close(), 12_000);
    } catch {
      if (statusText) statusText.textContent = "Browser notifications could not be displayed. In-dashboard alerts remain available.";
    }
  }
  if (!cancelled && soundEnabled) playChime();
}

function buildControls() {
  const details = h("details", { class: "order-alert-settings" });
  const sound = h("input", { type: "checkbox", checked: soundEnabled, id: "order-sound-enabled" });
  const soundLabel = h("label", { for: "order-sound-enabled" }, sound, "Enable order sound alerts");
  statusText = h("p", { class: "order-alert-status", role: "status", "aria-live": "polite" },
    soundEnabled ? "Sound preference saved. Use Test sound to enable audio in this tab." : "Sound is off. Enable it here; browser audio requires this interaction. Muted tabs may silence sound.");
  sound.addEventListener("change", async () => {
    if (!sound.checked) {
      soundEnabled = false;
      writeStorage("localStorage", SOUND_KEY, "false");
      statusText.textContent = "Order sound alerts are off.";
      return;
    }
    try {
      await getAudioContext();
      soundEnabled = true;
      soundReady = true;
      writeStorage("localStorage", SOUND_KEY, "true");
      statusText.textContent = "Order sound alerts are enabled on this device.";
      await playChime();
    } catch (error) {
      sound.checked = false; soundEnabled = false;
      soundReady = false;
      writeStorage("localStorage", SOUND_KEY, "false");
      statusText.textContent = error.message || "Sound is unavailable; in-dashboard alerts remain active.";
    }
  });
  const test = h("button", { class: "btn ghost sm", type: "button", onclick: async () => {
    try {
      const wasEnabled = soundEnabled;
      await getAudioContext();
      soundReady = true;
      soundEnabled = true;
      const played = await playChime();
      soundEnabled = wasEnabled;
      statusText.textContent = played ? (wasEnabled ? "Test sound requested." : "Test sound requested. Turn on order sound alerts to hear new orders.") : "Sound is unavailable; dashboard alerts remain active.";
    } catch (error) { statusText.textContent = error.message || "Sound is unavailable; dashboard alerts remain active."; }
  } }, "Test sound");
  const desktopStatus = h("p", { class: "order-alert-status", role: "status" });
  const desktopButton = h("button", { class: "btn ghost sm", type: "button" }, "Enable desktop notifications");
  const updateDesktopStatus = () => {
    if (!("Notification" in window)) {
      desktopButton.disabled = true;
      desktopStatus.textContent = "Desktop notifications are not supported. In-dashboard alerts remain available.";
    } else if (Notification.permission === "granted") {
      desktopButton.disabled = true;
      desktopButton.textContent = "Desktop notifications enabled";
      desktopStatus.textContent = "New orders can appear in browser notifications.";
    } else if (Notification.permission === "denied") {
      desktopButton.disabled = true;
      desktopStatus.textContent = "Notifications are blocked for this site. Use in-dashboard alerts or change site permissions in your browser.";
    } else {
      desktopButton.disabled = false;
      desktopStatus.textContent = "Enable notifications only on this device; permission is requested after you choose.";
    }
  };
  desktopButton.addEventListener("click", async () => {
    if (!("Notification" in window) || Notification.permission !== "default") return updateDesktopStatus();
    try { await Notification.requestPermission(); }
    catch { desktopStatus.textContent = "The browser could not enable notifications. In-dashboard alerts remain available."; }
    updateDesktopStatus();
  });
  updateDesktopStatus();

  details.append(h("summary", {}, "Order alert settings"), h("div", { class: "order-alert-controls" },
    soundLabel, h("div", { class: "order-alert-buttons" }, test, desktopButton), statusText, desktopStatus));
  const settings = document.getElementById("order-alert-settings");
  if (settings) settings.append(details);
  alertRoot = h("div", { class: "order-alert-list", "aria-live": "polite" });
  document.body.append(alertRoot);
}

function savedCursor() {
  try {
    const value = JSON.parse(readStorage("sessionStorage", CURSOR_KEY, "null"));
    if (value && Number.isSafeInteger(value.id) && Date.now() - value.savedAt < 12 * 60 * 60 * 1000) return value.id;
  } catch {}
  return null;
}

export function startOrderAlerts() {
  soundEnabled = soundPreference();
  buildControls();
  const cursor = savedCursor();
  const url = "/api/admin/order-events" + (cursor == null ? "" : "?since=" + encodeURIComponent(cursor));
  source = new EventSource(url, { withCredentials: true });
  source.addEventListener("ready", () => {
    if (statusText) statusText.textContent = soundEnabled && !soundReady
      ? "Connected. Sound preference is saved; use Test sound to enable audio in this tab."
      : soundEnabled ? "Connected. Sound alerts are enabled on this device; a muted tab may still silence audio." : "Connected. In-dashboard alerts are on; sound is off.";
  });
  const handleOrderEvent = (event, type) => {
    let order;
    try { order = JSON.parse(event.data); } catch { return; }
    const id = Number(event.lastEventId);
    if (!Number.isSafeInteger(id) || id < 1 || typeof order.reference !== "string" || !REF_PATTERN.test(order.reference) || !Number.isSafeInteger(order.total)) return;
    writeStorage("sessionStorage", CURSOR_KEY, JSON.stringify({ id, savedAt: Date.now() }));
    const duplicate = seenEvent(id);
    const eventName = type === "new_order" ? "vpc:new-order" : "vpc:order-cancelled";
    window.dispatchEvent(new CustomEvent(eventName, { detail: { ...order, eventId: String(id), duplicate } }));
    if (!duplicate) showAlert(order, id, type);
  };
  source.addEventListener("new_order", event => handleOrderEvent(event, "new_order"));
  source.addEventListener("order_cancelled", event => handleOrderEvent(event, "order_cancelled"));
  source.addEventListener("auth_expired", () => {
    source?.close();
    location.replace("/admin/login");
  });
  source.onopen = () => { if (statusText) statusText.textContent = "Connected. Waiting for new orders."; };
  source.onerror = () => { if (statusText) statusText.textContent = "Connection interrupted. The dashboard will try to reconnect; orders remain safely stored."; };
  return () => {
    source?.close(); source = null;
    alertRoot?.remove(); alertRoot = null;
    document.getElementById("order-alert-settings")?.replaceChildren();
    audio?.close(); audio = null;
    soundReady = false;
  };
}
