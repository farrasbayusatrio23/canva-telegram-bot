import { sendMessage } from "../lib/telegram.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const update = req.body || {};
    const message = update.message;
    if (!message?.chat?.id) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const text = message.text || "";

    if (text.startsWith("/start")) {
      await sendMessage(
        chatId,
        "Masukkan email Canva melalui Mini App. Setelah tersimpan, link undangan tim diberikan otomatis.",
        {
          reply_markup: {
            inline_keyboard: [[{
              text: "Buka Mini App",
              web_app: { url: process.env.MINIAPP_URL }
            }]]
          }
        }
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}
