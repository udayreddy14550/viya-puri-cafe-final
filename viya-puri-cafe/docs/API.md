# API reference

JSON over HTTPS. Errors: `{ "ok": false, "message": "...", "field"?: "..." }`. Admin routes need the `vpc_admin` cookie; every non-GET admin request also needs header `X-CSRF-Token` (returned by login / `GET /api/admin/session`) and a same-origin `Origin`.

## Public (existing site conventions: `apiBase: "/api"`)
| Method & path | Purpose |
|---|---|
| `GET /my-orders` | Customer phone-based order lookup page |
| `GET /api/public/bootstrap.js` | Script that sets `window.VPC_CONFIG` and `window.VPC_MENU` from the database (ETag, no-cache) |
| `GET /api/public/menu`, `GET /api/public/config` | Same data as JSON |
| `POST /api/customer/orders/lookup` `{phone,page?}` | Returns paginated order details matching the normalized checkout phone; rate limited and `Cache-Control: no-store` |
| `POST /api/customer/orders/cancel` `{phone,reference}` | Cancels a matching Pending order only; phone/reference are validated, rate limited, no-store; retries on an already cancelled matching order are idempotent |
| `POST /api/orders` | Place an order. Body as sent by the site: `clientKey, mode, coupon, payment:"cod", expectedTotal, items:[{id,size,qty}], customer:{name,phone}, address:{line,locality,landmark,pincode}, note`. Returns `201` with the persisted reference, item names/quantities, verified totals, payment method/status, delivery details and order status. Retrying with the same `clientKey` returns the persisted confirmation with `duplicate:true`; `{clientKey}` alone is sufficient to reconcile an uncertain result. `503` while ordering is off, `409` if prices/availability changed, `400` invalid input/coupon |
| `POST /api/coupons/validate` | `{code, mode, items, phone?}` → `{valid, discount, deliveryFee, total}` or an error message |
| `POST /api/contact` | `{name, contact, message}`; `503` while the form is off |
| `GET /api/health` | `{ok:true}` |

## Admin (all under `/api/admin`)
| Method & path | Purpose |
|---|---|
| `POST /login` `{email,password}` | Sign in (rate limited, lockout). Sets cookie; returns `csrfToken` |
| `GET /session` | `{authenticated, email?, role?, csrfToken?}` (always 200; `authenticated:false` when signed out) |
| `GET /order-events` | Authenticated Server-Sent Events stream. Emits `new_order` or `order_cancelled` with event ID, reference and total only; supports `Last-Event-ID` and initial `?since=<event-id>` replay. The order details remain available only through `GET /orders/:referenceOrId`. |
| `POST /logout` | Destroys the server session |
| `POST /password` `{currentPassword,newPassword}` | Change password; other sessions end |
| `GET /staff` · `POST /staff` `{email,password}` | Owner-only staff account listing and creation |
| `PATCH /staff/:id/active` `{active}` | Owner-only activation/deactivation; deactivation revokes all sessions |
| `PUT /staff/:id/password` `{password}` | Owner-only password reset; revokes all staff sessions |
| `GET /dashboard` | Counts, sales, 7-day series, recent orders/updates, top items |
| `GET /menu` | Categories + all items |
| `POST /menu/items` · `PUT /menu/items/:id` · `DELETE /menu/items/:id` | Create / replace / delete. Body: `name, description, categoryId, veg, available, tint, photoType, image, sizes:[{id?,label,price}]` |
| `PATCH /menu/items/:id/availability` `{available}` | Available / sold out |
| `POST /menu/categories` · `PUT /menu/categories/:id` `{name,sortOrder}` · `DELETE /menu/categories/:id` | Categories (delete only when empty) |
| `POST /uploads` (multipart field `file`) | JPEG/PNG/WebP ≤ 3 MB → `{url}` |
| `GET /orders?status&payment&mode&from&to&q&sort&page&pageSize` | Search/filter orders (+ status counts) |
| `GET /orders/:referenceOrId` | Order with items and history |
| `PATCH /orders/:id/status` `{status,note?}` | pending→…→completed or cancelled; final states locked |
| `PATCH /orders/:id/payment` `{paymentStatus}` | `paid`/`unpaid` (explicit; not for cancelled orders) |
| `GET /settings` · `PUT /settings` | Partial update of café settings (validated) |
| `GET/POST /coupons` · `PUT/DELETE /coupons/:code` · `PATCH /coupons/:code/active` | Coupon management |
| `GET /reports?from&to` | Totals, by day, by status/type, popular items |
| `GET /messages` · `PATCH/DELETE /messages/:id` | Contact-form messages |

Pages: `/admin/login` (public), `/admin`, `/admin/receipt/:reference` (session required, otherwise redirect to login).

Existing administrators become `owner` during the automatic schema migration. Owners retain full admin access. Staff are denied by default at the API boundary and are explicitly permitted only the order-event stream, order listing/details/status/payment operations, logout, and changing their own password. In the dashboard they see the Orders page only. Manage staff from **Staff accounts** as an owner; provide new/reset passwords to staff securely.

Customer phone lookup and cancellation do not use SMS or a customer session. The phone number is submitted in the POST body, never in the URL. **Anyone who knows a number can retrieve matching orders and delivery details, and cancel matching orders that are still Pending**, because the phone is the only check; rate limits and `no-store` responses do not verify ownership. Cancellation is limited to Pending orders, is recorded in order history, and is idempotent on retries. Use SMS-verified access if stronger privacy is required.

The order event ID is the existing auto-incremented `order_events.id` for the committed `created` record; no order-event migration is required. Streams send keepalives every 15 seconds and are limited to 40 total / 5 per admin ID per server process. A reverse proxy must pass through `text/event-stream` without buffering and allow idle connections longer than 15 seconds.
