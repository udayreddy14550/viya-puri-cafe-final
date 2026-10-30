"use strict";
/* Minimal multipart/form-data parser + safe image storage (no dependencies). */
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const cfg = require("./config");
const { HttpError, readBody } = require("./http");

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new HttpError(400, "Upload the file as multipart/form-data.");
  const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
  const parts = []; let pos = buf.indexOf(boundary);
  if (pos < 0) throw new HttpError(400, "The upload could not be read.");
  while (true) {
    pos += boundary.length;
    if (buf.slice(pos, pos + 2).toString() === "--") break;           // closing boundary
    if (buf.slice(pos, pos + 2).toString() === "\r\n") pos += 2;
    const headEnd = buf.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) throw new HttpError(400, "The upload could not be read.");
    const head = buf.slice(pos, headEnd).toString("utf8");
    const next = buf.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), headEnd + 4);
    if (next < 0) throw new HttpError(400, "The upload could not be read.");
    const data = buf.slice(headEnd + 4, next);
    const cd = /content-disposition:[^\r\n]*/i.exec(head)?.[0] || "";
    parts.push({ name: /\bname="([^"]*)"/i.exec(cd)?.[1], filename: /\bfilename="([^"]*)"/i.exec(cd)?.[1], data });
    pos = next + 2;
    if (parts.length > 10) throw new HttpError(400, "Too many parts in the upload.");
  }
  return parts;
}

/** Identify an image by its first bytes. Client-provided file names and content types are never trusted. */
function sniffImage(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length > 12 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (b.length > 12 && b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
}
const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

async function handleImageUpload(req) {
  const ct = String(req.headers["content-type"] || "");
  if (!/^multipart\/form-data/i.test(ct)) throw new HttpError(415, "Upload the image as multipart/form-data.");
  const body = await readBody(req, cfg.maxUploadBytes + 16 * 1024);
  const file = parseMultipart(body, ct).find(p => p.name === "file" && p.filename !== undefined);
  if (!file || !file.data.length) throw new HttpError(400, "Choose an image file to upload.");
  if (file.data.length > cfg.maxUploadBytes) throw new HttpError(413, `That image is larger than ${Math.round(cfg.maxUploadBytes / 1048576)} MB.`);
  const kind = sniffImage(file.data);
  if (!kind) throw new HttpError(415, "Only JPEG, PNG or WebP images can be uploaded.");
  const name = crypto.randomBytes(12).toString("hex") + "." + kind.ext;
  const dir = path.join(cfg.uploadDir, "menu");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), file.data, { mode: 0o644 });
  return { url: "/uploads/menu/" + name, bytes: file.data.length, type: kind.mime };
}

/** Delete an uploaded menu image file (only inside the uploads folder). */
function removeUpload(url) {
  const m = /^\/uploads\/menu\/([A-Za-z0-9._-]+)$/.exec(url || "");
  if (!m) return;
  try { fs.unlinkSync(path.join(cfg.uploadDir, "menu", m[1])); } catch {}
}

module.exports = { handleImageUpload, removeUpload, sniffImage, MIME_BY_EXT, parseMultipart };
