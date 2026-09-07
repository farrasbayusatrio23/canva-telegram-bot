import crypto from "node:crypto";

export function makeAccessToken() {
  return `CVA-${crypto.randomBytes(24).toString("base64url")}`;
}

export function hashAccessToken(raw) {
  return crypto.createHash("sha256").update(String(raw || "").trim()).digest("hex");
}

export function tokenHint(raw) {
  const s = String(raw || "");
  return s.length <= 10 ? s : `${s.slice(0, 7)}...${s.slice(-5)}`;
}

export function looksLikeAccessToken(text) {
  return /^CVA-[A-Za-z0-9_-]{20,}$/i.test(String(text || "").trim());
}
