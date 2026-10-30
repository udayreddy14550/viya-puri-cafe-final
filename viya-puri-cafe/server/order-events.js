"use strict";
const { db } = require("./db");
const { getSession } = require("./security");

const streams = new Set();
const MAX_STREAMS = 40;
const MAX_ADMIN_STREAMS = 5;
const KEEPALIVE_MS = 15_000;

const latestOrderEventId = () => Number(db.prepare("SELECT COALESCE(MAX(id), 0) id FROM order_events WHERE kind IN ('created', 'customer_cancelled')").get().id);

function frame(event, id, data) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function closeStream(stream) {
  if (stream.closed) return;
  stream.closed = true;
  clearInterval(stream.timer);
  streams.delete(stream);
  if (!stream.res.destroyed && !stream.res.writableEnded) {
    try { stream.res.end(); } catch (error) { console.warn("[order-events] could not close a disconnected stream:", error.message); }
  }
}

function expireStream(stream) {
  if (!stream.closed) write(stream, "event: auth_expired\ndata: {}\n\n");
  closeStream(stream);
}

function write(stream, text) {
  if (stream.closed || stream.res.destroyed || stream.res.writableEnded) {
    closeStream(stream);
    return false;
  }
  try {
    if (!stream.res.write(text)) {
      closeStream(stream);
      return false;
    }
    return true;
  } catch {
    closeStream(stream);
    return false;
  }
}

function replayOrderEvents(stream, cursor) {
  let after = cursor;
  for (;;) {
    const batch = db.prepare(`SELECT e.id, e.kind, o.reference, o.total
      FROM order_events e JOIN orders o ON o.id = e.order_id
      WHERE e.kind IN ('created', 'customer_cancelled') AND e.id > ?
      ORDER BY e.id LIMIT 250`).all(after);
    if (!batch.length) return true;
    for (const event of batch) {
      const type = event.kind === "created" ? "new_order" : "order_cancelled";
      if (!write(stream, frame(type, event.id, { reference: event.reference, total: event.total }))) return false;
    }
    after = Number(batch[batch.length - 1].id);
    if (batch.length < 250) return true;
  }
}

function openOrderStream(ctx) {
  const { req, res, admin } = ctx;
  const adminStreams = [...streams].filter(stream => stream.adminId === admin.id).length;
  if (streams.size >= MAX_STREAMS || adminStreams >= MAX_ADMIN_STREAMS) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "15", "Cache-Control": "no-store" });
    res.end("Too many active notification connections.");
    return;
  }

  const latest = latestOrderEventId();
  const headerCursor = req.headers["last-event-id"];
  const queryCursor = ctx.url.searchParams.get("since");
  const requestedCursor = headerCursor != null ? headerCursor : queryCursor;
  const parsedCursor = requestedCursor != null && /^\d{1,15}$/.test(String(requestedCursor)) ? Number(requestedCursor) : latest;
  const cursor = Math.min(Number.isSafeInteger(parsedCursor) ? parsedCursor : latest, latest);
  const stream = { adminId: admin.id, req, res, closed: false, timer: null };

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  streams.add(stream);
  res.on("close", () => closeStream(stream));
  res.on("error", () => closeStream(stream));

  if (!write(stream, `event: ready\ndata: ${JSON.stringify({ cursor: latest })}\n\n`)) return;
  if (!replayOrderEvents(stream, cursor)) return;

  stream.timer = setInterval(() => {
    if (!getSession(req)) return expireStream(stream);
    write(stream, `: keepalive ${Date.now()}\n\n`);
  }, KEEPALIVE_MS);
  stream.timer.unref();
}

function publishOrderEvent(type, eventId, reference, total) {
  if (!Number.isSafeInteger(Number(eventId)) || !reference || !Number.isSafeInteger(Number(total))) return;
  if (!["new_order", "order_cancelled"].includes(type)) return;
  const payload = frame(type, Number(eventId), { reference: String(reference), total: Number(total) });
  for (const stream of streams) {
    try {
      if (!getSession(stream.req)) { expireStream(stream); continue; }
      write(stream, payload);
    }
    catch (error) { console.error("[order-events] live publication failed; the event remains available for replay:", error.message); }
  }
}

const publishNewOrder = (eventId, reference, total) => publishOrderEvent("new_order", eventId, reference, total);
const publishOrderCancellation = (eventId, reference, total) => publishOrderEvent("order_cancelled", eventId, reference, total);

function closeOrderStreams() {
  for (const stream of [...streams]) closeStream(stream);
}

module.exports = { openOrderStream, publishNewOrder, publishOrderCancellation, closeOrderStreams };
