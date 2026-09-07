import { getSupabase } from "../lib/supabase.js";
import { sendMessage, telegram } from "../lib/telegram.js";
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

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

function miniUrl(hash = "") {
  const base = String(process.env.MINIAPP_URL || "").trim().replace(/#.*$/, "");
  return hash ? `${base}${hash}` : base;
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
    EMAIL_ALREADY_BOUND: "Email tersebut masih terikat dengan akun Telegram lain. Hubungi admin.",
    REDEEM_RPC_MISSING: "Database belum memakai SQL redeem terbaru. Hubungi admin.",
    DB_REDEEM_FAILED: "Database gagal memproses aktivasi. Hubungi admin.",
    REDEEM_EMPTY: "Aktivasi tidak mengembalikan data. Hubungi admin."
  };
  return map[code] || "Terjadi kesalahan. Coba lagi atau hubungi admin.";
}

function startKeyboard(userId) {
  const rows = [
    [{ text: "✨ Buka Mini App", web_app: { url: miniUrl("#access") } }],
    [
      { text: "📋 Status Saya", callback_data: "status" },
      { text: "ℹ️ Panduan", callback_data: "help" }
    ]
  ];
  if (isAdminTelegramId(userId)) {
    rows.push([{ text: "⚙️ Panel Admin", web_app: { url: miniUrl("#admin/dashboard") } }]);
  }
  return { inline_keyboard: rows };
}

async function sendHelp(chatId, userId) {
  const text = [
    "<b>ℹ️ Panduan Canva Access</b>",
    "",
    "<b>Aktivasi akses</b>",
    "1️⃣ Kirim token yang diawali <code>CVA-</code>",
    "2️⃣ Setelah token valid, kirim email Canva kamu",
    "3️⃣ Bot akan mengirim detail paket dan tombol link undangan",
    "",
    "<b>Perintah</b>",
    "• /start — menu utama",
    "• /status — cek akses Canva",
    "• /cancel — batalkan proses aktivasi",
    "• /id — lihat Telegram User ID",
    isAdminTelegramId(userId) ? "• /admin — buka panel admin" : null
  ].filter(Boolean).join("\n");

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: startKeyboard(userId)
  });
}

async function sendStart(chatId, user) {
  const firstName = esc(user.first_name || "kamu");
  const text = [
    "<b>🎨 Canva Access Manager</b>",
    "",
    `Halo <b>${firstName}</b> 👋`,
    "Aktifkan dan kelola akses Canva langsung dari Telegram.",
    "",
    "<b>Cara paling cepat:</b>",
    "1️⃣ Kirim token <code>CVA-...</code>",
    "2️⃣ Kirim email Canva saat diminta",
    "3️⃣ Buka link undangan yang diberikan bot",
    "",
    "Gunakan tombol di bawah untuk membuka Mini App atau melihat status akses."
  ].join("\n");

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: startKeyboard(user.id)
  });
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
    .limit(12);
  if (error) throw error;

  if (!data?.length) {
    return sendMessage(
      chatId,
      "<b>📋 Status Akses</b>\n\nBelum ada akses Canva yang terdaftar pada akun Telegram ini.",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "✨ Buka Mini App", web_app: { url: miniUrl("#access") } }]]
        }
      }
    );
  }

  const now = Date.now();
  const statusEmoji = { active: "🟢", expired: "🟠", removed: "🔴", blocked: "⛔" };
  const statusLabel = { active: "Aktif", expired: "Expired", removed: "Dikeluarkan", blocked: "Diblokir" };
  const buttons = [];

  const sections = data.map((x, i) => {
    const effective = x.status === "active" && new Date(x.ends_at).getTime() <= now ? "expired" : x.status;
    if (effective === "active" && x.canva_accounts?.invite_url) {
      buttons.push([{ text: `🎨 Buka ${String(x.canva_accounts?.name || "Canva").slice(0, 38)}`, url: x.canva_accounts.invite_url }]);
    }
    return [
      `<b>${i + 1}. ${esc(x.canva_accounts?.name || "Canva")}</b>`,
      `📧 ${esc(x.email)}`,
      `📦 ${esc(x.canva_packages?.name || "-")} ${x.canva_packages?.duration_days ? `• ${x.canva_packages.duration_days} hari` : ""}`,
      `${statusEmoji[effective] || "⚪"} ${esc(statusLabel[effective] || effective)}`,
      `⏳ Berakhir: ${esc(formatDate(x.ends_at))}`
    ].join("\n");
  });

  buttons.push([{ text: "✨ Buka Mini App", web_app: { url: miniUrl("#access") } }]);

  return sendMessage(chatId, `<b>📋 Status Akses Canva</b>\n\n${sections.join("\n\n")}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function answerCallback(id) {
  if (!id) return;
  try {
    await telegram("answerCallbackQuery", { callback_query_id: id });
  } catch (err) {
    console.error("[callback answer]", err);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (configuredSecret) {
    const received = req.headers["x-telegram-bot-api-secret-token"];
    if (received !== configuredSecret) return res.status(403).json({ ok: false });
  }

  try {
    const callback = req.body?.callback_query;
    if (callback?.from?.id && callback?.message?.chat?.id) {
      await answerCallback(callback.id);
      const chatId = callback.message.chat.id;
      if (callback.data === "status") await sendStatus(chatId, callback.from.id);
      else if (callback.data === "help") await sendHelp(chatId, callback.from.id);
      return res.status(200).json({ ok: true });
    }

    const message = req.body?.message;
    if (!message?.chat?.id || !message?.from?.id) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const user = message.from;
    const text = String(message.text || "").trim();
    const supabase = getSupabase();

    if (text.startsWith("/start")) {
      await sendStart(chatId, user);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/status")) {
      await sendStatus(chatId, user.id);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/id")) {
      await sendMessage(chatId, `<b>🆔 Telegram User ID</b>\n\n<code>${user.id}</code>\n\nSalin ID di atas untuk konfigurasi admin.`, {
        parse_mode: "HTML"
      });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/admin")) {
      if (!isAdminTelegramId(user.id)) {
        await sendMessage(chatId, "⛔ <b>Akses ditolak</b>\n\nAkun Telegram ini belum terdaftar sebagai admin.", { parse_mode: "HTML" });
      } else {
        await sendMessage(chatId, "<b>⚙️ Panel Admin</b>\n\nKelola anggota tim, akun Canva, paket, token, akses user, dan audit dari Mini App.", {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "⚙️ Buka Panel Admin", web_app: { url: miniUrl("#admin/dashboard") } }]]
          }
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/cancel")) {
      await supabase.from("telegram_states").delete().eq("telegram_user_id", user.id);
      await sendMessage(chatId, "✅ <b>Proses dibatalkan</b>\n\nKirim token baru kapan saja jika ingin mulai lagi.", {
        parse_mode: "HTML",
        reply_markup: startKeyboard(user.id)
      });
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
        await sendMessage(chatId, "❌ <b>Token tidak dapat digunakan</b>\n\nToken tidak valid, sudah digunakan, dinonaktifkan, atau kedaluwarsa. Cek token lalu coba lagi.", {
          parse_mode: "HTML"
        });
        return res.status(200).json({ ok: true });
      }

      const { error: stateError } = await supabase.from("telegram_states").upsert({
        telegram_user_id: user.id,
        stage: "awaiting_email",
        pending_token_hash: tokenHash,
        updated_at: new Date().toISOString()
      });
      if (stateError) throw stateError;

      await sendMessage(chatId, "✅ <b>Token valid</b>\n\nSekarang kirim <b>email yang kamu gunakan di Canva</b>.\n\nContoh: <code>nama@gmail.com</code>\n\nKirim /cancel jika ingin membatalkan.", {
        parse_mode: "HTML"
      });
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
        await sendMessage(chatId, "⚠️ <b>Format email belum valid</b>\n\nContoh yang benar: <code>nama@gmail.com</code>\n\nSilakan kirim ulang atau gunakan /cancel.", {
          parse_mode: "HTML"
        });
        return res.status(200).json({ ok: true });
      }

      try {
        const access = await redeemTokenHash({
          tokenHash: state.pending_token_hash,
          telegramUser: user,
          email: normalizeEmail(text)
        });

        await supabase.from("telegram_states").delete().eq("telegram_user_id", user.id);

        const successText = [
          "✅ <b>Akses berhasil diaktifkan</b>",
          "",
          `📧 <b>Email</b>\n${esc(access.email)}`,
          "",
          `🎨 <b>Akun Canva</b>\n${esc(access.account_name)}`,
          "",
          `📦 <b>Paket</b>\n${esc(access.package_name)} • ${esc(access.duration_days)} hari`,
          "",
          `⏳ <b>Aktif sampai</b>\n${esc(formatDate(access.ends_at))}`,
          "",
          "Tekan tombol di bawah untuk bergabung ke tim Canva."
        ].join("\n");

        const buttons = [];
        if (access.invite_url) buttons.push([{ text: "🎨 Buka Link Undangan Canva", url: access.invite_url }]);
        buttons.push([{ text: "📋 Lihat Status", callback_data: "status" }]);

        await sendMessage(chatId, successText, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons }
        });
      } catch (err) {
        await supabase.from("telegram_states").delete().eq("telegram_user_id", user.id);
        const code = err?.code || err?.message || "UNKNOWN";
        let messageText = `❌ <b>Aktivasi gagal</b>\n\n${esc(errorText(code))}`;
        if (isAdminTelegramId(user.id) && err?.details) {
          messageText += `\n\n<b>Detail admin</b>\n<code>${esc(String(err.details).slice(0, 700))}</code>`;
        }
        console.error("[telegram redeem]", { code, details: err?.details || null });
        await sendMessage(chatId, messageText, { parse_mode: "HTML" });
      }
      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId, "<b>🎨 Canva Access Manager</b>\n\nKirim token yang diawali <code>CVA-</code>, atau gunakan tombol di bawah.", {
      parse_mode: "HTML",
      reply_markup: startKeyboard(user.id)
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}
