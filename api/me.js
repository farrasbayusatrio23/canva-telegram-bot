import { isAdminTelegramId, validateTelegramInitData } from "../lib/telegramAuth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const { initData } = req.body || {};
  const auth = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.reason, is_admin: false });
  }

  return res.status(200).json({
    ok: true,
    user: {
      id: auth.user.id,
      first_name: auth.user.first_name || null,
      username: auth.user.username || null
    },
    is_admin: isAdminTelegramId(auth.user.id)
  });
}
