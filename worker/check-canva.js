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

async function notifyAdmins(text) {
  for (const id of getAdminIds()) {
    try { await sendMessage(id, text); }
    catch (err) { console.error("[telegram]", err.message); }
  }
}

async function updateAccountScan(supabase, accountId, values) {
  const payload = {
    last_scan_at: new Date().toISOString(),
    last_scan_total: Number(values.total || 0),
    last_scan_unauthorized: Number(values.unauthorized || 0),
    last_scan_removed: Number(values.removed || 0),
    last_scan_error: values.error || null,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("canva_accounts").update(payload).eq("id", accountId);
  if (error) console.error("[account scan update]", error.message);
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

async function scrollScrollableAreas(page) {
  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    for (let pass = 0; pass < 20; pass++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const candidates = [...document.querySelectorAll("div,main,section")]
        .filter(el => el.scrollHeight > el.clientHeight + 180)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)
        .slice(0, 6);
      for (const el of candidates) el.scrollTop = el.scrollHeight;
      await wait(300);
    }
    window.scrollTo(0, 0);
  });
}

async function collectBodyEmails(page) {
  await scrollScrollableAreas(page);
  const text = await page.locator("body").innerText();
  return [...new Set((text.match(EMAIL_RE) || []).map(x => x.toLowerCase()))];
}

async function findNextButton(page) {
  const patterns = [
    /^next$/i,
    /next page/i,
    /^berikutnya$/i,
    /^selanjutnya$/i,
    /halaman berikutnya/i
  ];

  for (const pattern of patterns) {
    const byRole = page.getByRole("button", { name: pattern }).last();
    if (await byRole.count()) {
      try {
        if (await byRole.isVisible() && await byRole.isEnabled()) return byRole;
      } catch {}
    }
  }
  return null;
}

async function scanMemberEmails(page) {
  const found = new Set();
  const pageFingerprints = new Set();

  for (let p = 0; p < 40; p++) {
    const emails = await collectBodyEmails(page);
    for (const email of emails) found.add(email);

    const fingerprint = `${page.url()}|${emails.slice(0, 8).join(",")}|${emails.length}`;
    if (pageFingerprints.has(fingerprint)) break;
    pageFingerprints.add(fingerprint);

    const next = await findNextButton(page);
    if (!next) break;

    try {
      await next.click({ timeout: 2500 });
      await sleep(1200);
    } catch {
      break;
    }
  }

  return [...found];
}

function rowContainsEmail(rowText, email) {
  return String(rowText || "").toLowerCase().includes(email.toLowerCase());
}

async function findMemberRow(page, email) {
  const emailNode = page.getByText(email, { exact: false }).first();
  if (!(await emailNode.count())) return null;
  try { await emailNode.scrollIntoViewIfNeeded(); } catch {}
  const handle = await emailNode.elementHandle();
  if (!handle) return null;

  return handle.evaluateHandle(node => {
    let cur = node;
    for (let depth = 0; depth < 10 && cur; depth++, cur = cur.parentElement) {
      const text = (cur.innerText || "").toLowerCase();
      const buttons = cur.querySelectorAll("button");
      if (text.includes((node.textContent || "").trim().toLowerCase()) && buttons.length > 0) {
        if (cur.getAttribute("role") === "row" || depth >= 2) return cur;
      }
    }
    return node.parentElement;
  });
}

async function tryRemoveMember(page, email) {
  const rowHandle = await findMemberRow(page, email);
  if (!rowHandle) return { ok: false, reason: "email_row_not_found" };

  const clicked = await rowHandle.evaluate((row, targetEmail) => {
    const txt = (row.innerText || "").toLowerCase();
    if (!txt.includes(String(targetEmail).toLowerCase())) return false;

    const buttons = [...row.querySelectorAll("button")].filter(b => !b.disabled);
    const preferred = buttons.find(b => {
      const s = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.textContent || ""}`.toLowerCase();
      return /more|lainnya|menu|opsi|option|actions|tindakan/.test(s);
    });
    const candidate = preferred || (buttons.length > 0 && buttons.length <= 4 ? buttons[buttons.length - 1] : null);
    if (!candidate) return false;
    candidate.click();
    return true;
  }, email);

  if (!clicked) return { ok: false, reason: "row_action_menu_not_found" };
  await sleep(700);

  const removePatterns = [
    /hapus dari tim/i,
    /keluarkan dari tim/i,
    /hapus anggota/i,
    /remove from team/i,
    /remove member/i,
    /remove user/i
  ];

  for (const pattern of removePatterns) {
    const item = page.getByText(pattern, { exact: false }).last();
    if (!(await item.count())) continue;
    try {
      await item.click({ timeout: 2500 });
      await sleep(700);

      const confirms = [
        /^hapus$/i, /^keluarkan$/i, /^remove$/i, /^konfirmasi$/i, /^confirm$/i,
        /hapus dari tim/i, /keluarkan dari tim/i, /remove from team/i
      ];
      for (const c of confirms) {
        const btn = page.getByRole("button", { name: c }).last();
        if (await btn.count()) {
          try { await btn.click({ timeout: 1400 }); } catch {}
          break;
        }
      }
      await sleep(1600);
      return { ok: true, action: String(pattern) };
    } catch (err) {
      return { ok: false, reason: "remove_click_failed", message: err.message };
    }
  }

  return { ok: false, reason: "remove_action_not_found" };
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();

  let detected = 0;
  let unauthorizedCount = 0;
  let removedCount = 0;

  try {
    await page.goto(account.members_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(5000);

    const bodyText = (await page.locator("body").innerText()).slice(0, 5000);
    if (/login|log in|masuk ke canva|sign in/i.test(`${page.url()} ${bodyText}`)) {
      const error = "session_needs_reauth";
      await audit(supabase, account.id, null, null, error, { url: page.url() });
      await updateAccountScan(supabase, account.id, { total: 0, unauthorized: 0, removed: 0, error });
      await notifyAdmins(`Canva Checker: session untuk ${account.name} perlu login ulang.`);
      return;
    }

    const memberEmails = await scanMemberEmails(page);
    detected = memberEmails.length;

    if (!detected) {
      const error = "member_scan_empty";
      await audit(supabase, account.id, null, null, error, { url: page.url() });
      await updateAccountScan(supabase, account.id, { total: 0, unauthorized: 0, removed: 0, error });
      await notifyAdmins(`Canva Checker: ${account.name} tidak menemukan email anggota. Penghapusan otomatis dilewati.`);
      return;
    }

    // Safety gate: after the first successful scan, a sudden drop below 60% of
    // the previous total disables destructive actions for that run. This helps
    // avoid removals if Canva changes the member-list UI or only partially loads it.
    const previousTotal = Number(account.last_scan_total || 0);
    const minSafe = previousTotal > 0 ? Math.max(1, Math.floor(previousTotal * 0.6)) : 1;
    const destructiveAllowed = detected >= minSafe;

    for (const [email, grant] of activeByEmail) {
      const seen = memberEmails.includes(email);
      const update = { last_checked_at: nowIso, updated_at: nowIso };
      if (seen) update.last_seen_in_canva = nowIso;
      const { error } = await supabase.from("canva_access").update(update).eq("id", grant.id);
      if (error) console.error("[update access]", error.message);
    }

    const unauthorized = memberEmails.filter(email =>
      !activeByEmail.has(email) && !protectedSet.has(email)
    );
    unauthorizedCount = unauthorized.length;

    if (account.auto_remove && !destructiveAllowed) {
      const error = `scan_safety_blocked:${detected}<${minSafe}`;
      await audit(supabase, account.id, null, null, "auto_remove_safety_blocked", {
        detected,
        previous_total: previousTotal,
        minimum_safe: minSafe,
        unauthorized: unauthorizedCount
      });
      await updateAccountScan(supabase, account.id, {
        total: detected,
        unauthorized: unauthorizedCount,
        removed: 0,
        error
      });
      await notifyAdmins(`Canva Checker — ${account.name}\nScan hanya mendeteksi ${detected} email, di bawah ambang aman ${minSafe}. Auto-remove DIBLOKIR untuk pemeriksaan ini.`);
      return;
    }

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

      if (result.ok) {
        removedCount += 1;
        if (grant) {
          const { error } = await supabase.from("canva_access").update({
            status: "removed",
            removed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).eq("id", grant.id);
          if (error) console.error("[mark removed]", error.message);
        }
      }
    }

    await updateAccountScan(supabase, account.id, {
      total: detected,
      unauthorized: unauthorizedCount,
      removed: removedCount,
      error: null
    });

    await audit(supabase, account.id, null, null, "scan_completed", {
      detected,
      active_access: activeByEmail.size,
      unauthorized: unauthorizedCount,
      removed: removedCount,
      auto_remove: account.auto_remove
    });

    const summary = [
      `Canva Checker — ${account.name}`,
      `Terdeteksi: ${detected} email`,
      `Akses aktif DB: ${activeByEmail.size}`,
      `Tidak terdaftar/expired: ${unauthorizedCount}`,
      `Dikeluarkan: ${removedCount}`,
      `Auto-remove: ${account.auto_remove ? "ON" : "OFF"}`
    ];
    if (unauthorizedCount) summary.push("", ...unauthorized.slice(0, 30).map(x => `• ${x}`));
    await notifyAdmins(summary.join("\n"));

    console.log({
      account: account.name,
      detected,
      active: activeByEmail.size,
      unauthorized,
      removed: removedCount,
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

  if (!accounts?.length) {
    console.log("Tidak ada akun Canva aktif.");
    return;
  }

  for (const account of accounts) {
    try {
      await processAccount(supabase, account);
    } catch (err) {
      console.error(`[${account.name}]`, err);
      await audit(supabase, account.id, null, null, "checker_error", { message: err.message });
      await updateAccountScan(supabase, account.id, {
        total: Number(account.last_scan_total || 0),
        unauthorized: 0,
        removed: 0,
        error: err.message
      });
      await notifyAdmins(`Canva Checker error pada ${account.name}: ${err.message}`);
    }
  }
}

const once = process.argv.includes("--once");
const interval = Math.max(60 * 60 * 1000, Number(process.env.CHECK_INTERVAL_MS || 24 * 60 * 60 * 1000));

await runOnce();
if (!once) {
  setInterval(() => runOnce().catch(err => console.error("[checker]", err)), interval);
}
