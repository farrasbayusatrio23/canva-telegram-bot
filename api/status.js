import { getSupabase } from "../lib/supabase.js";
import { validateTelegramInitData } from "../lib/telegramAuth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const { initData } = req.body || {};
    const auth = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!auth.ok) return res.status(401).json({ ok: false, error: auth.reason });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("canva_access")
      .select("email,status,last_seen_in_canva,last_checked_at,created_at")
      .eq("telegram_user_id", auth.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.status(200).json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
