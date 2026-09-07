import { getSupabase } from "./supabase.js";
import { hashAccessToken } from "./tokens.js";

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function redeemError(code, details = "") {
  const err = new Error(code);
  err.code = code;
  err.details = details;
  return err;
}

export async function redeemTokenHash({ tokenHash, telegramUser, email }) {
  const supabase = getSupabase();
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw redeemError("EMAIL_INVALID");

  const { data, error } = await supabase.rpc("redeem_canva_token_v2", {
    p_token_hash: tokenHash,
    p_telegram_user_id: telegramUser.id,
    p_telegram_username: telegramUser.username || null,
    p_telegram_first_name: telegramUser.first_name || null,
    p_email: normalized
  });

  if (error) {
    const msg = [error.code, error.message, error.details, error.hint]
      .filter(Boolean)
      .join(" | ");

    if (/TOKEN_INVALID/i.test(msg)) throw redeemError("TOKEN_INVALID", msg);
    if (/TOKEN_DISABLED/i.test(msg)) throw redeemError("TOKEN_DISABLED", msg);
    if (/TOKEN_EXPIRED/i.test(msg)) throw redeemError("TOKEN_EXPIRED", msg);
    if (/TOKEN_USED/i.test(msg)) throw redeemError("TOKEN_USED", msg);
    if (/ACCOUNT_DISABLED/i.test(msg)) throw redeemError("ACCOUNT_DISABLED", msg);
    if (/PACKAGE_DISABLED/i.test(msg)) throw redeemError("PACKAGE_DISABLED", msg);
    if (/EMAIL_ALREADY_BOUND/i.test(msg)) throw redeemError("EMAIL_ALREADY_BOUND", msg);
    if (/EMAIL_INVALID/i.test(msg)) throw redeemError("EMAIL_INVALID", msg);

    if (/PGRST202|Could not find the function|redeem_canva_token_v2/i.test(msg)) {
      throw redeemError("REDEEM_RPC_MISSING", msg);
    }

    throw redeemError("DB_REDEEM_FAILED", msg);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    throw redeemError("REDEEM_EMPTY", `RPC returned: ${JSON.stringify(data)}`);
  }

  return row;
}

export async function redeemRawToken({ rawToken, telegramUser, email }) {
  return redeemTokenHash({
    tokenHash: hashAccessToken(rawToken),
    telegramUser,
    email
  });
}
