import { getSupabase } from "./supabase.js";
import { hashAccessToken } from "./tokens.js";

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export async function redeemTokenHash({
  tokenHash,
  telegramUser,
  email
}) {
  const supabase = getSupabase();
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw new Error("EMAIL_INVALID");

  const { data, error } = await supabase.rpc("redeem_canva_token", {
    p_token_hash: tokenHash,
    p_telegram_user_id: telegramUser.id,
    p_telegram_username: telegramUser.username || null,
    p_telegram_first_name: telegramUser.first_name || null,
    p_email: normalized
  });

  if (error) {
    const msg = `${error.message || ""} ${error.details || ""}`.trim();
    if (/TOKEN_INVALID/i.test(msg)) throw new Error("TOKEN_INVALID");
    if (/TOKEN_DISABLED/i.test(msg)) throw new Error("TOKEN_DISABLED");
    if (/TOKEN_EXPIRED/i.test(msg)) throw new Error("TOKEN_EXPIRED");
    if (/TOKEN_USED/i.test(msg)) throw new Error("TOKEN_USED");
    if (/ACCOUNT_DISABLED/i.test(msg)) throw new Error("ACCOUNT_DISABLED");
    if (/PACKAGE_DISABLED/i.test(msg)) throw new Error("PACKAGE_DISABLED");
    if (/EMAIL_ALREADY_BOUND/i.test(msg)) throw new Error("EMAIL_ALREADY_BOUND");
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("REDEEM_EMPTY");
  return row;
}

export async function redeemRawToken({ rawToken, telegramUser, email }) {
  return redeemTokenHash({
    tokenHash: hashAccessToken(rawToken),
    telegramUser,
    email
  });
}
