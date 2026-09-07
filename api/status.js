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
      .select(`
        id,email,status,starts_at,ends_at,last_seen_in_canva,last_checked_at,
        canva_accounts!inner(id,name,invite_url),
        canva_packages!inner(id,name,duration_days)
      `)
      .eq("telegram_user_id", auth.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const now = Date.now();
    const rows = (data || []).map(row => ({
      ...row,
      effective_status:
        row.status === "active" && new Date(row.ends_at).getTime() <= now
          ? "expired"
          : row.status
    }));

    return res.status(200).json({ ok: true, rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
