import { getSupabase } from "../lib/supabase.js";
import { sendMessage } from "../lib/telegram.js";
import { hashAccessToken, looksLikeAccessToken } from "../lib/tokens.js";
import { isValidEmail, normalizeEmail, redeemTokenHash } from "../lib/redeem.js";
import { isAdminTelegramId } from "../lib/telegramAuth.js";

function formatDate(v) {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(v));
  } catch {
    return String(v || "-");
  }
}

function errorText(code) {
  const map = {
    EMAIL_INVALID: "Format email tidak valid.",
    TOKEN_INVALID: "Token tidak valid.",
    TOKEN_DISABLED: "Token sudah dinonaktifkan.",
    TOKEN_EXPIRED: "Token sudah kedaluwarsa.",
    TOKEN_USED: "Token sudah digunakan.",
    ACCOUNT_DISABLED: "Akun Canva tujuan sedang dinonaktifkan.",
    PACKAGE_DISABLED: "Paket sedang dinonaktifkan.",
    EMAIL_ALREADY_BOUND: "Email tersebut masih terikat dengan akun Telegram lain. Hubungi admin."
  };
  return map[code] || "Terjadi kesalahan. Coba lagi atau hubungi admin.";
}

async function sendStart(chatId, userId) {
  const rows = [[{
    text: "Buka Mini App",
    web_app: { url: process.env.MINIAPP_URL }
  }]];
  if (isAdminTelegramId(userId)) {
    rows.push([{
      text: "Panel Admin",
      web_app: { url: process.env.MINIAPP_URL }
    }]);
  }

  return sendMessage(
    chatId,
    "Canva Access\n\n1. Kirim token akses (contoh: CVA-...)\n2. Bot akan meminta email Canva\n3. Setelah berhasil, kamu mendapat akun Canva tujuan, paket, masa aktif, dan link undangan.\n\nPerintah: /status /cancel /id",
    { reply_markup: { inline_keyboard: rows } }
  );
}

async function sendStatus(chatId, telegramUserId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("canva_access")
    .select(`
      email,status,starts_at,ends_at,
      canva_accounts(name,invite_url),
      canva_packages(name,duration_days)
    `)
    .eq("telegram_user_id", telegramUserId)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  if (!data?.length) {
    return sendMessage(chatId, "Belum ada akses Canva yang terdaftar pada akun Telegram ini.");
  }

  const now = Date.now();
  const lines = data.map((x, i) => {
    const effective = x.status === "active" && new Date(x.ends_at).getTime() <= now ? "expired" : x.status;
    return [
      `${i + 1}. ${x.canva_accounts?.name || "Canva"}`,
      `Email: ${x.email}`,
      `Paket: ${x.canva_packages?.name || "-"}`,
      `Status: ${effective}`,
      `Berakhir: ${formatDate(x.ends_at)}`,
      effective === "active" ? `Link: ${x.canva_accounts?.invite_url || "-"}` : null
    ].filter(Boolean).join("\n");
  });

  return sendMessage(chatId, lines.join("\n\n"));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (configuredSecret) {
    const received = req.headers["x-telegram-bot-api-secret-token"];
    if (received !== configuredSecret) return res.status(403).json({ ok: false });
  }

  try {
    const message = req.body?.message;
    if (!message?.chat?.id || !message?.from?.id) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const user = message.from;
    const text = String(message.text || "").trim();
    const supabase = getSupabase();

    if (text.startsWith("/start")) {
      await sendStart(chatId, user.id);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/status")) {
      await sendStatus(chatId, user.id);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/id")) {
      await sendMessage(chatId, `Telegram User ID kamu: ${user.id}\n\nUntuk menjadikan akun ini admin, masukkan ID tersebut ke Environment Variable ADMIN_TELEGRAM_IDS di Vercel dan GitHub Actions Secrets.`);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/admin")) {
      if (!isAdminTelegramId(user.id)) {
        await sendMessage(chatId, "Akun Telegram ini bukan admin.");
      } else {
        await sendMessage(chatId, "Buka Mini App untuk mengelola akun Canva, paket, token, dan akses.", {
          reply_markup: {
            inline_keyboard: [[{
              text: "Buka Panel Admin",
              web_app: { url: process.env.MINIAPP_URL }
            }]]
          }
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/cancel")) {
      await supabase.from("telegram_states").delete().eq("telegram_user_id", user.id);
      await sendMessage(chatId, "Proses dibatalkan. Kirim token baru jika ingin mulai lagi.");
      return res.status(200).json({ ok: true });
    }

    if (looksLikeAccessToken(text)) {
      const tokenHash = hashAccessToken(text);
      const { data: token, error } = await supabase
        .from("canva_access_tokens")
        .select("id,status,usage_limit,used_count,expires_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw error;

      const expired = token?.expires_at && new Date(token.expires_at).getTime() <= Date.now();
      if (!token || token.status !== "active" || token.used_count >= token.usage_limit || expired) {
        await sendMessage(chatId, "Token tidak valid, sudah digunakan, dinonaktifkan, atau kedaluwarsa.");
        return res.status(200).json({ ok: true });
      }

      const { error: stateError } = await supabase.from("telegram_states").upsert({
        telegram_user_id: user.id,
        stage: "awaiting_email",
        pending_token_hash: tokenHash,
        updated_at: new Date().toISOString()
      });
      if (stateError) throw stateError;

      await sendMessage(chatId, "Token valid. Sekarang kirim email yang kamu gunakan pada akun Canva.");
      return res.status(200).json({ ok: true });
    }

    const { data: state, error: stateError } = await supabase
      .from("telegram_states")
      .select("stage,pending_token_hash")
      .eq("telegram_user_id", user.id)
      .maybeSingle();
    if (stateError) throw stateError;

    if (state?.stage === "awaiting_email") {
      if (!isValidEmail(text)) {
        await sendMessage(chatId, "Format email belum valid. Contoh: nama@gmail.com\n\nKirim /cancel untuk membatalkan.");
        return res.status(200).json({ ok: true });
      }

      try {
        const access = await redeemTokenHash({
          tokenHash: state.pending_token_hash,
          telegramUser: user,
          email: normalizeEmail(text)
        });

        await supabase.from("telegram_states").delete().eq("telegram_user_id", user.id);

        await sendMessage(
          chatId,
          `Akses berhasil diaktifkan.\n\nEmail: ${access.email}\nAkun Canva: ${access.account_name}\nPaket: ${access.package_name} (${access.duration_days} hari)\nAktif sampai: ${formatDate(access.ends_at)}\n\nLink undangan:\n${access.invite_url}`
        );
      } catch (err) {
        await supabase.from("telegram_states").delete().eq("telegram_user_id", user.id);
        await sendMessage(chatId, errorText(err.message));
      }
      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId, "Kirim token akses yang diawali CVA-, atau gunakan /start untuk melihat petunjuk.");
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}
