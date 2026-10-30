# Viya Puri Café: website + admin dashboard

Your existing website, now backed by a real server and database, with a secure admin area at **`/admin/login`**.
Menu, prices, photos, availability, settings, coupons and orders are stored in SQLite and survive restarts.
Menu changes appear on the customer website as soon as you press Save.

**No `npm install` is needed.** The server uses only what ships with Node.js (**Node 22.13 or newer**).

## 1. Run it in VS Code (step by step)

### What to download and install (one time)
| Download | Why | Where |
|---|---|---|
| **Node.js 22.13 or newer** (choose the **LTS** installer; it includes `npm`) | Runs the server and the built-in SQLite database | https://nodejs.org |
| **Visual Studio Code** | Editor / terminal | https://code.visualstudio.com |
| *(optional)* VS Code extension **SQLite Viewer** (`qwtel.sqlite-viewer`) | Lets you look inside `data/viya.db` | VS Code → Extensions (VS Code will suggest it) |

That's all. **There are no frameworks or packages to install**: no Express, React, MongoDB, Docker or `npm install`.
The project is plain Node.js (built-in `http`, `crypto` and `node:sqlite`), SQLite, and plain HTML / CSS / JavaScript in the browser.
Check Node after installing (close and reopen VS Code first): `node -v` must print `v22.13.0` or higher.

### Commands
1. Unzip `viya-puri-cafe.zip`. In VS Code: **File → Open Folder…** and choose the `viya-puri-cafe` folder.
2. Open the terminal: **Terminal → New Terminal** (shortcut ``Ctrl+` ``). Then run these one at a time:

```bash
npm run setup          # creates .env (with a random secret) and the database, and loads your 50 menu items, settings and coupons
npm run create-admin   # asks for your email, then a password (typing is hidden; 12+ characters)
npm start              # starts the website
```

3. Open in your browser: **http://127.0.0.1:3000** (customer site) and **http://127.0.0.1:3000/admin/login** (admin).
4. Stop the server with `Ctrl+C` in the terminal.

Other commands: `npm run dev` (restarts automatically when you edit server files), `npm test` (automated tests), `npm run add-descriptions` (see below).
You can also use **Terminal → Run Task…** (`1. Set up database`, `2. Create admin user`, `3. Start server`, `Run tests`) or press **F5** to run/debug the server.

**Windows PowerShell, non-interactive admin creation** (if the hidden prompt gives trouble):
```powershell
$env:ADMIN_EMAIL="you@example.com"; $env:ADMIN_PASSWORD="Your-Strong-Pass-123!"; npm run create-admin; Remove-Item Env:ADMIN_PASSWORD
```
macOS/Linux: `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='Your-Strong-Pass-123!' npm run create-admin`

### Troubleshooting
| Message | Fix |
|---|---|
| "This app needs Node.js 22.13 or newer" | Install the current LTS from nodejs.org, then close and reopen VS Code. |
| `npm` / `node` is not recognised | Node isn't installed or the terminal was open during install. Reopen VS Code. |
| "Port 3000 is already in use" | The server is already running in another terminal, or set `PORT=3001` in `.env`. |
| Forgot the admin password | Run `npm run create-admin` again with the same email; it resets the password. |
| Want to start over | Stop the server, delete `data/viya.db*` and the files in `uploads/`, run `npm run setup` again. |

### Creating the first administrator
There is **no registration page or endpoint**. Admins are created only by running `npm run create-admin` on the server.
Running it again for an existing email **resets that password** and signs out its sessions.
Passwords must be 12+ characters and mix three of: lower, upper, numbers, symbols. Credentials are never stored in any HTML/JS file.

### `.env`
`npm run setup` creates `.env` for you with a random `SESSION_SECRET`. Everything else has a sensible default; see `.env.example` for each option.

### Item descriptions
All 50 items have a short description (shown on the website cards and editable in **Menu → Edit**). New installs get them automatically.
If you ran an earlier version, run `npm run add-descriptions` once: it fills only blank descriptions and never overwrites wording you wrote yourself.
Please read them over: they are written from the item names, so check anything specific (for example whether the Desserts are ice-cream scoops).

## 2. What was changed in your original site
Your single 2.3 MB HTML file was split, with design, CSS, layout, copy and behaviour unchanged:

| Original | Now |
|---|---|
| inline `VPC_CONFIG` + `VPC_MENU` data blocks (with 50 base64 photos) | loaded from the database via `/api/public/bootstrap.js`; photos extracted to `uploads/menu/*.webp` |
| inline JS | `public/assets/site.js` (same code; needed for a strict Content-Security-Policy) |
| base64 logo (twice) | `public/assets/logo.webp` |

Small documented changes to the site code: coupons support fixed-amount discounts and start dates; the item description (new, optional) is shown on cards;
the coupon *Apply* button also asks the server; a friendly message shows if the menu cannot load; a footer "Staff login" link.
**One bug fix:** the original phone cleaner turned valid mobile numbers beginning "91" (e.g. 9123456789) into invalid ones. Fixed on site and server.

**Ordering and the contact form remain OFF**, exactly as in your original config, and payment stays **cash on delivery only**.
They are now real (implemented and tested), so you can switch them on yourself in *Café settings → Website features* when ready.
While off, the server itself refuses orders/messages (HTTP 503) and the site tells customers to call.

### Item descriptions
All 50 items now have a short description (shown on the website cards and editable in **Menu → Edit**). New installs get them automatically.
If you already ran the app before this update, run `npm run add-descriptions` once: it fills only items whose description is blank and never overwrites wording you wrote yourself.
Please read them over: they are written from the item names, so check anything specific (for example whether the Desserts are ice-cream scoops, and the ingredients in the burgers and chaats).

## 3. Using the dashboard
* **Dashboard**: menu counts, available/sold out, orders, pending, sales (cancelled excluded), 7-day chart, recent orders and recent changes.
* **Menu**: add/edit/delete items (delete asks for confirmation), per-size prices, description, category, veg/non-veg, photo upload with live preview, photo label, availability switch on every card, search/filter/sort. *Categories* button manages categories (only empty ones can be deleted).
* **Orders**: filter by status/date/payment/type, search by order number, name or phone; open an order to see customer, address, items, totals, history; move it through Pending → Confirmed → Preparing → Ready → Completed, or Cancel; **Print receipt**.
  *Payment*: cash-on-delivery orders start as **Unpaid** and are never auto-marked paid. Use **Mark cash received** (with confirmation) only once you actually hold the cash.
  Completed and Cancelled are final.
* **Staff accounts** (owner only): create separate staff sign-ins, reset passwords, and deactivate/reactivate accounts. Existing administrator accounts become owners automatically when the app starts after this update; no order or account data is deleted. Staff can access Orders and update order/payment statuses only; access to dashboards, reports, menu, settings, and account management is denied by the server, not just hidden in the interface. Deactivation and password resets immediately revoke the staff member's existing sessions.
* **Offers & coupons**: create/edit/enable/disable/delete; percent or fixed amount, max discount, minimum order, start/expiry date, total and per-customer usage limits.
  *Review of your originals:* **WELCOME10** (10% up to ₹50, min ₹150) and **CAFE20** (20% up to ₹80, min ₹250) were `active:false` on your site, so they are imported **disabled**. WELCOME10 had no first-order rule: set "Uses per customer" to 1 if it should be once per phone number.
* **Reports**: any date range; orders, sales (cancelled excluded), average order, completed sales, cash received, day-by-day table, popular items (shown when ≥5 counted orders), status and order-type split.
* **Messages**: contact-form messages (when enabled).
* **Café settings**: name, tagline, announcement banner, phones, WhatsApp, maps/social links, address, hours, prep time, home delivery (fee, free-above, minimum, pincodes), website feature switches, and your own password.

## 4. Security summary
Passwords hashed with **scrypt** (N=32768, per-user salt, constant-time compare); generic login errors and dummy hashing so emails can't be enumerated;
per-IP and per-email rate limits plus account lock after 5 failures (15 min); server-side sessions (random 256-bit id, only an HMAC of it is stored), cookie `HttpOnly; SameSite=Strict; Secure` (Secure on in production), 12 h lifetime and 2 h idle timeout, new session at login, destroyed on logout and on password change;
CSRF token on every state-changing admin request plus Origin / Fetch-Metadata check; **every** `/api/admin/*` route is authorised on the server, with owner-only access by default and explicit order-only staff permissions (admin pages/scripts are served only with a valid session);
all SQL parameterised; all input validated, length-limited and stripped of control characters, and all output built with `textContent`/escaped (no stored XSS);
uploads limited to JPEG/PNG/WebP by *file signature* (not name/type), ≤3 MB, random file names, served with `nosniff`, SVG refused;
strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, HSTS in production; order totals, availability and coupons are always recomputed on the server.
Secrets live only in environment variables; `.env`, the database and uploads are git-ignored.

## 5. Deployment (production checklist)
1. Linux server with Node ≥ 22.13. Copy the project; run `npm run setup` and `npm run create-admin`.
2. `.env`: `NODE_ENV=production`, a real `SESSION_SECRET` (the server refuses to start without one), `HOST=127.0.0.1`, `TRUST_PROXY=true`, `PUBLIC_ORIGIN=https://your-domain`.
3. **Serve over HTTPS** with a reverse proxy that forwards `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` (Caddy: `your-domain { reverse_proxy 127.0.0.1:3000 }`; or nginx + certbot). Production mode redirects HTTP→HTTPS and sets Secure cookies and HSTS.
4. Run under a process manager (systemd/pm2) as a non-root user; the app needs write access only to `data/` and `uploads/`.
5. **Back up `data/` and `uploads/`** regularly (e.g. `sqlite3 data/viya.db ".backup backup.db"` + copy `uploads/`).
6. Run one instance (rate limits are in memory; SQLite is single-writer).
7. Update the static address/phone inside `public/index.html`'s `<head>` (JSON-LD / social tags) if they change; these are not driven by settings.

## 6. Testing
`npm test` runs the end-to-end tests (real HTTP, throw-away database): login success/failure, lockout and rate limit, CSRF/cross-origin refusal, unauthenticated access to every admin area, menu CRUD and size prices, public-menu reflection, persistence across restart, upload type/size/content checks and path traversal, server-side order pricing (client prices ignored, price-change and sold-out rejection, idempotency), customer order lookup and Pending-only cancellation by checkout phone, cancellation notifications to connected owner/staff sessions with replay and duplicate prevention, authenticated order-event streaming/replay and deduplication, coupon expiry/start/minimum/total & per-customer limits, order status rules, payment never auto-marked, reports excluding cancelled orders, settings validation, password change and logout invalidating sessions, `.env` parsing, and that private files (`.env`, source, database) are never served.

`test/browser/` holds two optional Playwright suites that drive the real website in Chromium (`pip install playwright && playwright install chromium`; start the server on a *throw-away* database with PORT=3111 and an admin `owner@example.com` / `Correct-Horse-9!`, then `python test/browser/customer.py` and `python test/browser/admin.py`):
* **customer.py**: page load, no broken images/ids/links, category filters, search, size prices, cart add/remove/clear/persist, ordering-off behaviour, coupon errors, checkout validation, out-of-area pincode, successful order confirmation and idempotent double-click, contact form, sold-out items, 5 screen widths.
* **admin.py**: login/logout and gating, every view, menu search/filter/sort/edit/delete (with confirmation), categories, coupons create/disable/delete (and their effect on the site), settings (and their effect on the site), new-order alert/list update without refresh, order search/filter/sort/cancel/full status flow, report and dashboard totals compared with the database, password change, mobile layout.

## 7. New order alerts and manual test
When an order is committed or a customer cancels a Pending order, signed-in owner and staff dashboards with an active event connection receive authenticated SSE `new_order` or `order_cancelled` events. Cancellation alerts use a distinct visual/desktop notification and do not play the new-order chime. The existing order history table stores each event ID, so a connected admin tab can reconnect and replay events it missed. Opening the dashboard without a saved tab cursor starts at the current event sequence: historical events do not show as new alerts. Customer retries reuse their checkout idempotency key and receive the existing persisted order.

1. Sign in at `/admin/login`, open **Order alert settings**, select **Enable order sound alerts**, and press **Test sound** once to initialise audio in that browser tab. Sound preference is saved in that browser; browsers can suspend audio after restart, so use **Test sound** again if needed. The original Web Audio chime uses a conservative 0.12 gain and has no separate volume setting.
2. Select **Enable desktop notifications** if wanted. Permission is requested only after clicking that button. If permission is denied or unsupported, the always-on in-dashboard alert still works.
3. In **Café settings → Website features**, enable online ordering. Open the customer site in a separate tab, add an available menu item, and complete checkout with cash on delivery.
4. Verify the customer sees **Your order has been placed!**, the reference, item/quantity, totals, delivery fee, COD/payment-pending status and pending order status. The cart should be cleared only after this confirmation. If the browser reports an uncertain result, the safe retry reuses its checkout key; that key is stored in this tab's session storage so it can also reconcile after a reload without storing customer details there.
5. Without refreshing the admin tab, verify the new-order alert shows its reference and total, the dashboard/order counts refresh, and **View order** opens its full details. Dismiss it, then test the order status workflow. Re-submit the same checkout only through the safe retry shown after an uncertain network result; it uses the original idempotency key.
6. To test reconnection, temporarily disconnect the admin tab's network, place a separate customer order, then restore the connection. The event stream replays the missed event and the order list reconciles from the database.
7. With ordering disabled or invalid checkout data, verify no order confirmation appears and the cart remains available.

The order-alert feature needs no provider configuration or schema migration: the existing `order_events` auto-increment key is the persisted cursor. Sound preference and the last-seen event cursor are browser-side settings; they do not contain customer data.

## 8. Find orders using the checkout phone
Customers can open **My Orders** from the site header or visit `/my-orders`. They enter the mobile number used at checkout to see orders placed with that number. No account, password, SMS code or order reference is needed. The results include order items, totals, payment state, delivery details and café status updates.

**Privacy warning:** this lookup uses the phone number as the only check. Anyone who knows a customer's number may be able to view all matching orders and delivery details. The number is submitted in a POST body (not a URL), the response is not cached, and requests are rate limited, but those measures do not prove that the visitor owns that number. Use SMS verification if private customer-only access is required.

Manual test: place orders with a test mobile number, open `/my-orders`, enter that number and choose **Find my orders**. Verify that only matching orders appear with their details. Try another number and confirm the first number's orders are not returned.

Customers can cancel an order only while its status is **Pending**. The matching order card has a **Cancel order** button and confirmation step. Cancellation updates its status and order history; any connected signed-in owner/staff admin dashboard receives an in-dashboard and, if enabled, desktop notification. The phone number is the only identity check, so anyone who knows it can cancel that number's still-Pending order. An order already Confirmed or later cannot be cancelled online; contact the café instead. No SMS or out-of-browser alert is sent.

## 9. Deployment and notification limitations
SSE requires a hosting path that permits persistent HTTP responses. The handler sends keepalives every 15 seconds and `X-Accel-Buffering: no`; for nginx, disable proxy buffering for the API stream and set a proxy read timeout comfortably above 15 seconds. Verify the behavior through the actual production proxy. This repository's tests exercise the local Node server, not a production proxy or browser autoplay/desktop permission behavior.

Run one server process, as already recommended for this SQLite app. The durable event sequence allows reconnect/replay, but live fan-out is in process memory; if you later deploy multiple Node workers or replicas, add shared pub/sub (such as Redis) or route all SSE connections and order creation to the same worker. Orders remain stored even if all notification connections are closed or full.

Optional SMS/WhatsApp alerts are not implemented. To enable out-of-browser delivery later, integrate a real provider with server-side credentials and an owner-configured destination, then document provider/template requirements, retries, deduplication and message charges. Browser notifications are not a substitute for that channel.

## 10. Completed features and known limitations
Be aware of:
* **Password hashing is scrypt, not Argon2id/bcrypt**, because those need third-party packages (no npm access was available to build/test with). scrypt is a memory-hard, OWASP-recognised algorithm; swapping is isolated to `server/security.js`.
* Uses Node's built-in SQLite, which Node still labels experimental.
* Not tested here: a real HTTPS reverse-proxy deployment, Safari/Firefox, or Google Fonts loading (the sandbox was offline; fonts fall back gracefully).
* Owner-managed staff accounts are separate from owners: staff can manage orders only. Password reset is performed by the owner from **Staff accounts** or by the server operator using the CLI for an owner account.
* Customers with the site already open see menu changes after reloading. Prices are whole rupees. Photos are stored as uploaded (not resized).
* "Featured / New / Bestseller" picks are kept from your original config (and cleaned when an item is deleted) but have no editing screen yet.
* Online payments (UPI/cards) are not implemented; cash on delivery only.
