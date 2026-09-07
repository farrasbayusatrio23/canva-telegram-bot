import crypto from "node:crypto";

export function validateTelegramInitData(initData, botToken, maxAgeSeconds = 3600) {
  if (!initData || !botToken) return { ok: false, reason: "missing_init_data" };

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { ok: false, reason: "missing_hash" };
  params.delete("hash");

  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || Math.abs(now - authDate) > maxAgeSeconds) {
    return { ok: false, reason: "expired_init_data" };
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  let a;
  let b;
  try {
    a = Buffer.from(receivedHash, "hex");
    b = Buffer.from(calculatedHash, "hex");
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user?.id) return { ok: false, reason: "missing_user" };

  return { ok: true, user, authDate };
}

export function getAdminIds() {
  return new Set(
    String(process.env.ADMIN_TELEGRAM_IDS || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean)
      .map(String)
  );
}

export function isAdminTelegramId(id) {
  return getAdminIds().has(String(id));
}
