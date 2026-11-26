// Sealing the published blobs.
//
// The repo is public, so what lands in it — and in its git history, forever —
// is ciphertext. The key never enters the repo: it lives as the SITE_KEY
// secret here, and in the "#k=" fragment of the link people are given.
//
// Layout of a sealed file:   "FDE1" | iv (12 bytes) | ciphertext | tag (16 bytes)
// An unsealed file is plain gzip, which starts 1f 8b, so the viewer can tell
// the two apart without being told. No SITE_KEY set = plain gzip, as before.

import zlib from "node:zlib";
import crypto from "node:crypto";

export const MAGIC = Buffer.from("FDE1", "ascii");

// Accepts base64, base64url or 64 hex characters. Must come to 32 bytes.
export function readKey(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let buf;
  if (/^[0-9a-f]{64}$/i.test(s)) buf = Buffer.from(s, "hex");
  else buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buf.length !== 32)
    throw new Error("SITE_KEY must decode to 32 bytes, got " + buf.length +
                    ". Generate one with: openssl rand -base64 32");
  return buf;
}

export function newKey() {
  return crypto.randomBytes(32).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// JSON -> gzip -> (optionally) AES-256-GCM. Compress first: ciphertext does
// not compress, so the other order would roughly triple the download.
export function seal(value, key) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 });
  if (!key) return { buf: gz, sealed: false };
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  return { buf: Buffer.concat([MAGIC, iv, ct, c.getAuthTag()]), sealed: true };
}

// The reverse, for scripts in this repo that need to read a sealed blob back.
export function unseal(buf, key) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return JSON.parse(zlib.gunzipSync(buf).toString());
  if (!buf.slice(0, 4).equals(MAGIC)) throw new Error("not a directory blob");
  if (!key) throw new Error("this blob is sealed and SITE_KEY is not set");
  const iv = buf.slice(4, 16), rest = buf.slice(16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(rest.slice(-16));
  const gz = Buffer.concat([d.update(rest.slice(0, -16)), d.final()]);
  return JSON.parse(zlib.gunzipSync(gz).toString());
}
