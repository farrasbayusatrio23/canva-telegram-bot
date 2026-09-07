import { validateTelegramInitData } from "../lib/telegramAuth.js";
import { redeemRawToken } from "../lib/redeem.js";

function publicError(err) {
  const code = err?.message || "SERVER_ERROR";
  const messages = {
    EMAIL_INVALID: "Format email tidak valid.",
    TOKEN_INVALID: "Token akses tidak valid.",
    TOKEN_DISABLED: "Token akses sudah dinonaktifkan.",
    TOKEN_EXPIRED: "Token akses sudah kedaluwarsa.",
    TOKEN_USED: "Token akses sudah digunakan.",
    ACCOUNT_DISABLED: "Akun Canva tujuan sedang dinonaktifkan.",
    PACKAGE_DISABLED: "Paket sedang dinonaktifkan.",
    EMAIL_ALREADY_BOUND: "Email ini masih terikat pada akun Telegram lain. Hubungi admin."
  };
  return { code, message: messages[code] || "Terjadi kesalahan pada server." };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const { token, email, initData } = req.body || {};
    const auth = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!auth.ok) return res.status(401).json({ ok: false, error: auth.reason });

    const result = await redeemRawToken({
      rawToken: token,
      email,
      telegramUser: auth.user
    });

    return res.status(200).json({ ok: true, access: result });
  } catch (err) {
    console.error(err);
    const e = publicError(err);
    return res.status(400).json({ ok: false, error: e.code, message: e.message });
  }
}
