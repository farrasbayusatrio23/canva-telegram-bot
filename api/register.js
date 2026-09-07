import { getSupabase } from "../lib/supabase.js";
import { validateTelegramInitData } from "../lib/telegramAuth.js";
import { sendMessage } from "../lib/telegram.js";

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const { email, initData } = req.body || {};
    const normalized = String(email || "").trim().toLowerCase();
    if (!validEmail(normalized)) {
      return res.status(400).json({ ok: false, error: "email_invalid" });
    }

    const auth = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!auth.ok) return res.status(401).json({ ok: false, error: auth.reason });

    const supabase = getSupabase();
    const payload = {
      telegram_user_id: auth.user.id,
      telegram_username: auth.user.username || null,
      telegram_first_name: auth.user.first_name || null,
      email: normalized,
      status: "registered",
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from("canva_access")
      .upsert(payload, { onConflict: "email" })
      .select()
      .single();

    if (error) throw error;

    const inviteUrl = process.env.CANVA_PUBLIC_INVITE_URL;
    if (!inviteUrl) throw new Error("CANVA_PUBLIC_INVITE_URL belum diisi.");

    await sendMessage(
      auth.user.id,
      `Email tersimpan: ${normalized}\n\nLink undangan Canva:\n${inviteUrl}\n\nGunakan akun Canva dengan email yang sama.`
    );

    return res.status(200).json({
      ok: true,
      email: normalized,
      status: data.status,
      inviteUrl
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "server_error", message: err.message });
  }
}
