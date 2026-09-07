import { validateTelegramInitData } from "../lib/telegramAuth.js";
import { redeemRawToken } from "../lib/redeem.js";

function publicError(err) {
  const raw = String(err?.message || "SERVER_ERROR");
  const code = raw.toUpperCase();
  const messages = {
    EMAIL_INVALID: "Format email tidak valid.",
    TOKEN_INVALID: "Token akses tidak valid.",
    TOKEN_DISABLED: "Token akses sudah dinonaktifkan.",
    TOKEN_EXPIRED: "Token akses sudah kedaluwarsa.",
    TOKEN_USED: "Token akses sudah digunakan.",
    ACCOUNT_DISABLED: "Akun Canva tujuan sedang dinonaktifkan.",
    PACKAGE_DISABLED: "Paket sedang dinonaktifkan.",
    EMAIL_ALREADY_BOUND: "Email ini masih terikat pada akun Telegram lain. Hubungi admin.",
    SQL_NOT_READY: "Database project belum siap. Jalankan SQL schema v4 di Supabase lalu coba lagi.",
    INITDATA_INVALID: "Mini App harus dibuka dari tombol bot Telegram."
  };

  if (/expired_init_data|missing_init_data|missing_hash|bad_signature|missing_user/i.test(raw)) {
    return { code: 'INITDATA_INVALID', message: messages.INITDATA_INVALID };
  }
  if (/Could not find the function public\.redeem_canva_token|relation .*canva_access_tokens.* does not exist|relation .*canva_accounts.* does not exist/i.test(raw)) {
    return { code: 'SQL_NOT_READY', message: messages.SQL_NOT_READY };
  }
  if (/TOKEN_INVALID|TOKEN_DISABLED|TOKEN_EXPIRED|TOKEN_USED|ACCOUNT_DISABLED|PACKAGE_DISABLED|EMAIL_ALREADY_BOUND|EMAIL_INVALID/i.test(code)) {
    return { code, message: messages[code] || raw };
  }
  return { code: 'SERVER_ERROR', message: 'Terjadi kesalahan pada server. Cek log Vercel pada API /api/redeem.' };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const { token, email, initData } = req.body || {};
    const auth = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!auth.ok) throw new Error(auth.reason);

    const result = await redeemRawToken({
      rawToken: token,
      email,
      telegramUser: auth.user
    });

    return res.status(200).json({ ok: true, access: result });
  } catch (err) {
    console.error('[redeem]', err);
    const e = publicError(err);
    return res.status(400).json({ ok: false, error: e.code, message: e.message });
  }
}
