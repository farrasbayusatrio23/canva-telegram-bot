import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSupabase } from "../lib/supabase.js";
import { sendMessage } from "../lib/telegram.js";
import { getAdminIds } from "../lib/telegramAuth.js";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function audit(supabase, accountId, accessId, email, event, details = {}) {
  const { error } = await supabase.from("canva_audit").insert({
    account_id: accountId,
    access_id: accessId || null,
    email: email || null,
    event,
    details
  });
  if (error) console.error("[audit]", error.message);
}

async function downloadState(supabase, account) {
  const { data, error } = await supabase.storage
    .from(account.session_bucket)
    .download(account.session_file);
  if (error) throw new Error(`Gagal download session ${account.name}: ${error.message}`);

  const target = path.join(os.tmpdir(), `canva-${account.slug}-${Date.now()}.json`);
  await fs.writeFile(target, Buffer.from(await data.arrayBuffer()));
  return target;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    let last = -1;
    for (let i = 0; i < 25; i++) {
      const h = document.documentElement.scrollHeight;
      window.scrollTo(0, h);
      await delay(250);
      if (h === last) break;
      last = h;
    }
    window.scrollTo(0, 0);
  });
}

async function collectVisibleEmails(page) {
  await autoScroll(page);
  const text = await page.locator("body").innerText();
  return [...new Set((text.match(EMAIL_RE) || []).map(x => x.toLowerCase()))];
}

async function tryRemoveMember(page, email) {
  // Canva Business has no stable public member-removal API, so this is intentionally
  // conservative. It only acts around a visible row containing the exact email.
  const emailNode = page.getByText(email, { exact: false }).first();
  if (!(await emailNode.count())) return { ok: false, reason: "email_row_not_found" };

  try { await emailNode.scrollIntoViewIfNeeded(); } catch {}
  const handle = await emailNode.elementHandle();
  if (!handle) return { ok: false, reason: "email_handle_missing" };

  const clicked = await handle.evaluate(node => {
    let cur = node;
    for (let depth = 0; depth < 9 && cur; depth++, cur = cur.parentElement) {
      const buttons = [...cur.querySelectorAll("button")].filter(b => !b.disabled);
      if (!buttons.length) continue;

      const preferred = buttons.find(b => {
        const s = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.textContent || ""}`.toLowerCase();
        return /more|lainnya|menu|opsi|option|actions|tindakan/.test(s);
      });
      const candidate = preferred || (buttons.length <= 3 ? buttons[buttons.length - 1] : null);
      if (candidate) {
        candidate.click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) return { ok: false, reason: "row_action_menu_not_found" };
  await sleep(700);

  const removeLabels = [
    "Hapus dari tim", "Keluarkan dari tim", "Hapus anggota", "Remove from team",
    "Remove member", "Remove user"
  ];

  for (const label of removeLabels) {
    const item = page.getByText(label, { exact: false }).last();
    if (await item.count()) {
      try {
        await item.click({ timeout: 2500 });
        await sleep(600);

        // Confirm only if a matching confirmation action is presented.
        const confirm = page.getByRole("button", { name: new RegExp(label, "i") }).last();
        if (await confirm.count()) {
          try { await confirm.click({ timeout: 1500 }); } catch {}
        } else {
          for (const c of ["Hapus", "Keluarkan", "Remove", "Confirm", "Konfirmasi"]) {
            const btn = page.getByRole("button", { name: new RegExp(`^${c}$`, "i") }).last();
            if (await btn.count()) { try { await btn.click({ timeout: 1000 }); } catch {}; break; }
          }
        }
        await sleep(1400);
        return { ok: true, label };
      } catch (err) {
        return { ok: false, reason: "remove_click_failed", message: err.message };
      }
    }
  }

  return { ok: false, reason: "remove_action_not_found" };
}

async function notifyAdmins(text) {
  for (const id of getAdminIds()) {
    try { await sendMessage(id, text); } catch (err) { console.error("[telegram]", err.message); }
  }
}

async function markExpired(supabase) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("canva_access")
    .update({ status: "expired", updated_at: now })
    .eq("status", "active")
    .lte("ends_at", now)
    .select("id,email,account_id");
  if (error) throw error;

  for (const x of data || []) {
    await audit(supabase, x.account_id, x.id, x.email, "access_expired", {});
  }
  return data || [];
}

async function processAccount(supabase, account) {
  console.log(`\n[account] ${account.name}`);
  const nowIso = new Date().toISOString();

  const { data: grants, error: grantsError } = await supabase
    .from("canva_access")
    .select("id,email,status,ends_at")
    .eq("account_id", account.id);
  if (grantsError) throw grantsError;

  const activeByEmail = new Map(
    (grants || [])
      .filter(x => x.status === "active" && new Date(x.ends_at).getTime() > Date.now())
      .map(x => [String(x.email).toLowerCase(), x])
  );
  const anyGrantByEmail = new Map((grants || []).map(x => [String(x.email).toLowerCase(), x]));
  const protectedSet = new Set((account.protected_emails || []).map(x => String(x).toLowerCase()));

  const statePath = await downloadState(supabase, account);
  const headless = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();

  try {
    await page.goto(account.members_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4500);

    const bodyText = (await page.locator("body").innerText()).slice(0, 4000);
    if (/login|log in|masuk ke canva|sign in/i.test(`${page.url()} ${bodyText}`)) {
      await audit(supabase, account.id, null, null, "session_needs_reauth", { url: page.url() });
      await notifyAdmins(`Canva Checker: session untuk ${account.name} perlu login ulang.`);
      return;
    }

    const memberEmails = await collectVisibleEmails(page);
    if (!memberEmails.length) {
      await audit(supabase, account.id, null, null, "member_scan_empty", { url: page.url() });
      await notifyAdmins(`Canva Checker: ${account.name} tidak menghasilkan email member. Auto-remove dilewati demi keamanan.`);
      return;
    }

    for (const [email, grant] of activeByEmail) {
      const seen = memberEmails.includes(email);
      const update = {
        last_checked_at: nowIso,
        updated_at: nowIso
      };
      if (seen) update.last_seen_in_canva = nowIso;
      const { error } = await supabase.from("canva_access").update(update).eq("id", grant.id);
      if (error) console.error("[update access]", error.message);
    }

    const unauthorized = memberEmails.filter(email =>
      !activeByEmail.has(email) && !protectedSet.has(email)
    );

    for (const email of unauthorized) {
      const grant = anyGrantByEmail.get(email) || null;
      const reason = grant ? `access_${grant.status}` : "not_in_database";
      await audit(supabase, account.id, grant?.id, email, "unauthorized_detected", {
        reason,
        auto_remove: account.auto_remove
      });

      if (!account.auto_remove) continue;

      const result = await tryRemoveMember(page, email);
      await audit(
        supabase,
        account.id,
        grant?.id,
        email,
        result.ok ? "member_removed" : "remove_failed",
        result
      );

      if (result.ok && grant) {
        const { error } = await supabase.from("canva_access").update({
          status: "removed",
          removed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).eq("id", grant.id);
        if (error) console.error("[mark removed]", error.message);
      }
    }

    const summary = [
      `Canva Checker — ${account.name}`,
      `Terdeteksi: ${memberEmails.length} email`,
      `Akses aktif: ${activeByEmail.size}`,
      `Tidak berizin: ${unauthorized.length}`,
      `Auto-remove: ${account.auto_remove ? "ON" : "OFF"}`
    ];
    if (unauthorized.length) summary.push("", ...unauthorized.slice(0, 30).map(x => `• ${x}`));
    if (unauthorized.length) await notifyAdmins(summary.join("\n"));

    console.log({
      account: account.name,
      detected: memberEmails.length,
      active: activeByEmail.size,
      unauthorized,
      autoRemove: account.auto_remove
    });
  } finally {
    await browser.close();
    await fs.unlink(statePath).catch(() => {});
  }
}

async function runOnce() {
  const supabase = getSupabase();
  await markExpired(supabase);

  const { data: accounts, error } = await supabase
    .from("canva_accounts")
    .select("*")
    .eq("is_active", true)
    .order("created_at");
  if (error) throw error;

  for (const account of accounts || []) {
    try {
      await processAccount(supabase, account);
    } catch (err) {
      console.error(`[${account.name}]`, err);
      await audit(supabase, account.id, null, null, "checker_error", { message: err.message });
      await notifyAdmins(`Canva Checker error pada ${account.name}: ${err.message}`);
    }
  }
}

const once = process.argv.includes("--once");
const interval = Math.max(60000, Number(process.env.CHECK_INTERVAL_MS || 60000));

await runOnce();
if (!once) {
  setInterval(() => runOnce().catch(err => console.error("[checker]", err)), interval);
}
