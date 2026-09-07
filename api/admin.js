import { getSupabase } from "../lib/supabase.js";
import { isAdminTelegramId, validateTelegramInitData } from "../lib/telegramAuth.js";
import { makeAccessToken, hashAccessToken, tokenHint } from "../lib/tokens.js";

function requireAdmin(initData) {
  const auth = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!auth.ok) throw Object.assign(new Error(auth.reason), { status: 401 });
  if (!isAdminTelegramId(auth.user.id)) {
    throw Object.assign(new Error("not_admin"), { status: 403 });
  }
  return auth.user;
}

function slugify(input) {
  return String(input || "")
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function asStringArray(v) {
  if (Array.isArray(v)) return v.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
  return String(v || "").split(/[,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
}

function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

async function bootstrap(supabase) {
  const [accounts, packages, tokens, access, audits] = await Promise.all([
    supabase.from("canva_accounts").select("*").order("created_at"),
    supabase.from("canva_packages").select("*").order("duration_days"),
    supabase.from("canva_access_tokens").select(`
      id,token_hint,status,usage_limit,used_count,expires_at,created_at,
      canva_accounts(name),canva_packages(name,duration_days)
    `).order("created_at", { ascending: false }).limit(100),
    supabase.from("canva_access").select(`
      id,email,telegram_user_id,telegram_username,status,starts_at,ends_at,last_seen_in_canva,last_checked_at,removed_at,
      canva_accounts(name),canva_packages(name,duration_days)
    `).order("updated_at", { ascending: false }).limit(300),
    supabase.from("canva_audit").select(`
      id,email,event,details,created_at,canva_accounts(name)
    `).order("created_at", { ascending: false }).limit(150)
  ]);

  for (const r of [accounts, packages, tokens, access, audits]) if (r.error) throw r.error;
  return {
    accounts: accounts.data || [],
    packages: packages.data || [],
    tokens: tokens.data || [],
    access: access.data || [],
    audits: audits.data || []
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const body = req.body || {};
    const admin = requireAdmin(body.initData);
    const action = body.action || "bootstrap";
    const supabase = getSupabase();

    if (action === "bootstrap") {
      return res.status(200).json({ ok: true, admin: true, ...(await bootstrap(supabase)) });
    }

    if (action === "save_account") {
      const x = body.account || {};
      const protectedEmails = asStringArray(x.protected_emails);
      const payload = {
        name: String(x.name || "").trim(),
        slug: slugify(x.slug || x.name),
        members_url: String(x.members_url || "").trim(),
        invite_url: String(x.invite_url || "").trim(),
        session_bucket: String(x.session_bucket || "canva-private").trim(),
        session_file: String(x.session_file || "").trim(),
        protected_emails: protectedEmails,
        auto_remove: Boolean(x.auto_remove),
        is_active: x.is_active !== false,
        updated_at: new Date().toISOString()
      };

      if (!payload.name || !payload.slug || !payload.members_url || !payload.invite_url || !payload.session_file) {
        return res.status(400).json({ ok: false, error: "account_fields_required", message: "Nama, URL member, link invite, dan session file wajib diisi." });
      }
      if (!isHttpUrl(payload.members_url) || !isHttpUrl(payload.invite_url)) {
        return res.status(400).json({ ok: false, error: "invalid_url", message: "URL member atau invite tidak valid." });
      }
      if (payload.auto_remove && protectedEmails.length === 0) {
        return res.status(400).json({ ok: false, error: "protected_email_required", message: "Isi minimal email Owner/Admin yang tidak boleh dikeluarkan sebelum Auto Remove diaktifkan." });
      }

      let q;
      if (x.id) q = supabase.from("canva_accounts").update(payload).eq("id", x.id).select().single();
      else q = supabase.from("canva_accounts").insert(payload).select().single();
      const { data, error } = await q;
      if (error) throw error;
      return res.status(200).json({ ok: true, account: data });
    }

    if (action === "save_package") {
      const x = body.package || {};
      const payload = {
        name: String(x.name || "").trim(),
        duration_days: Number(x.duration_days),
        description: String(x.description || "").trim() || null,
        is_active: x.is_active !== false,
        updated_at: new Date().toISOString()
      };
      if (!payload.name || !Number.isInteger(payload.duration_days) || payload.duration_days <= 0) {
        return res.status(400).json({ ok: false, error: "package_fields_invalid", message: "Nama dan durasi paket wajib valid." });
      }

      let q;
      if (x.id) q = supabase.from("canva_packages").update(payload).eq("id", x.id).select().single();
      else q = supabase.from("canva_packages").insert(payload).select().single();
      const { data, error } = await q;
      if (error) throw error;
      return res.status(200).json({ ok: true, package: data });
    }

    if (action === "generate_tokens") {
      const accountId = String(body.account_id || "");
      const packageId = String(body.package_id || "");
      const count = Math.max(1, Math.min(100, Number(body.count || 1)));
      const usageLimit = Math.max(1, Math.min(1000, Number(body.usage_limit || 1)));
      const expiresAt = body.expires_at ? new Date(body.expires_at).toISOString() : null;

      if (!accountId || !packageId) {
        return res.status(400).json({ ok: false, error: "account_package_required", message: "Pilih akun Canva dan paket." });
      }

      const rawTokens = [];
      const rows = [];
      for (let i = 0; i < count; i++) {
        const raw = makeAccessToken();
        rawTokens.push(raw);
        rows.push({
          token_hash: hashAccessToken(raw),
          token_hint: tokenHint(raw),
          account_id: accountId,
          package_id: packageId,
          usage_limit: usageLimit,
          expires_at: expiresAt,
          created_by_telegram_id: admin.id
        });
      }

      const { error } = await supabase.from("canva_access_tokens").insert(rows);
      if (error) throw error;
      return res.status(200).json({ ok: true, tokens: rawTokens });
    }

    if (action === "disable_token") {
      const { error } = await supabase
        .from("canva_access_tokens")
        .update({ status: "disabled", updated_at: new Date().toISOString() })
        .eq("id", body.token_id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === "set_access_status") {
      const allowed = new Set(["active", "expired", "removed", "blocked"]);
      const status = String(body.status || "");
      if (!allowed.has(status)) return res.status(400).json({ ok: false, error: "bad_status" });
      const update = { status, updated_at: new Date().toISOString() };
      if (status === "removed") update.removed_at = new Date().toISOString();
      const { error } = await supabase.from("canva_access").update(update).eq("id", body.access_id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: "unknown_action" });
  } catch (err) {
    console.error(err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || "server_error", message: err.message || "server_error" });
  }
}
