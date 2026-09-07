import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSupabase } from "../lib/supabase.js";
import { sendMessage } from "../lib/telegram.js";
import { getAdminIds } from "../lib/telegramAuth.js";

// IMPORTANT: use a real word-boundary escape. v5 accidentally contained
// backspace control characters here, causing every email scan to return 0.
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function extractEmails(value) {
  return [...new Set((String(value || "").match(EMAIL_RE) || []).map(x => x.toLowerCase()))];
}


function extractMemberCountHint(text) {
  const value = String(text || "").replace(/\u00a0/g, " " );
  const patterns = [
    /(?:people|members?|anggota)\s*\(?\s*(\d{1,4})\s*\)?/i,
    /(\d{1,4})\s*(?:people|members?|anggota)\b/i
  ];
  for (const re of patterns) {
    const m = value.match(re);
    if (m) return Number(m[1]) || 0;
  }
  return 0;
}

async function waitForPeopleUi(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return /people|member|anggota|tim|team/i.test(text) ||
      document.querySelector("[role='row'], tr, [role='listitem'], [data-testid*='member' i], [data-testid*='people' i]");
  }, { timeout: 15000 }).catch(() => {});
  await sleep(1500);
}

async function collectEmailsFromMemberRows(page) {
  const raw = await page.evaluate(() => {
    const selectors = [
      "tr",
      "[role='row']",
      "[role='listitem']",
      "[data-testid*='member' i]",
      "[data-testid*='user' i]",
      "[data-testid*='people' i]"
    ];
    const seen = new Set();
    const values = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        values.push(el.innerText || "");
        values.push(el.textContent || "");
        values.push(el.getAttribute?.("aria-label") || "");
        values.push(el.getAttribute?.("title") || "");
        values.push(el.getAttribute?.("data-testid") || "");
      }
    }
    return values.join("\n");
  });
  return extractEmails(raw);
}

async function closeMemberDetail(page) {
  const closePatterns = [/^close$/i, /^tutup$/i, /close dialog/i, /tutup dialog/i];
  for (const pattern of closePatterns) {
    const btn = page.getByRole("button", { name: pattern }).last();
    if (await btn.count().catch(() => 0)) {
      try { await btn.click({ timeout: 900 }); await sleep(250); return; } catch {}
    }
  }
  try { await page.keyboard.press("Escape"); await sleep(200); } catch {}
}

async function collectEmailsByOpeningMemberRows(page, maxRows = 60) {
  const found = new Set();
  const candidates = page.locator("tr, [role='row'], [role='listitem'], [data-testid*='member' i], [data-testid*='user' i]");
  const count = Math.min(await candidates.count().catch(() => 0), maxRows);

  for (let i = 0; i < count; i++) {
    const row = candidates.nth(i);
    let visible = false;
    try { visible = await row.isVisible(); } catch {}
    if (!visible) continue;

    let rowText = "";
    try { rowText = (await row.innerText()).trim(); } catch {}
    if (!rowText || rowText.length > 800) continue;
    if (/invite|undang|add people|tambah orang|search|cari anggota/i.test(rowText) && rowText.length < 120) continue;

    for (const email of extractEmails(rowText)) found.add(email);
    if (extractEmails(rowText).length) continue;

    const beforeUrl = page.url();
    try {
      await row.scrollIntoViewIfNeeded().catch(() => {});
      await row.click({ timeout: 1200, position: { x: 30, y: 20 } });
      await sleep(450);

      const detailEmails = await collectEmailsFromDom(page);
      for (const email of detailEmails) found.add(email);

      if (page.url() !== beforeUrl && !/\/settings\/people/i.test(page.url())) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
        await waitForPeopleUi(page);
      } else {
        await closeMemberDetail(page);
      }
    } catch {
      // Some rows are not clickable; continue with other rows.
    }
  }
  return [...found].sort();
}

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
    try {
      await sendMessage(id, text);
    } catch (err) {
      console.error("[telegram]", err.message);
    }
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

  const { error } = await supabase
    .from("canva_accounts")
    .update(payload)
    .eq("id", accountId);

  if (error) console.error("[account scan update]", error.message);
}

async function refreshMemberSnapshot(supabase, accountId, emails) {
  const nowIso = new Date().toISOString();

  const { error: clearError } = await supabase
    .from("canva_member_snapshots")
    .update({ is_present: false, last_scan_at: nowIso })
    .eq("account_id", accountId)
    .eq("is_present", true);
  if (clearError) throw clearError;

  if (!emails.length) return;

  const rows = emails.map(email => ({
    account_id: accountId,
    email,
    is_present: true,
    last_seen_at: nowIso,
    last_scan_at: nowIso
  }));

  const { error } = await supabase
    .from("canva_member_snapshots")
    .upsert(rows, { onConflict: "account_id,email" });

  if (error) throw error;
}

async function downloadState(supabase, account) {
  const { data, error } = await supabase.storage
    .from(account.session_bucket)
    .download(account.session_file);

  if (error) {
    throw new Error(`Gagal download session ${account.name}: ${error.message}`);
  }

  const target = path.join(os.tmpdir(), `canva-${account.slug}-${Date.now()}.json`);
  await fs.writeFile(target, Buffer.from(await data.arrayBuffer()));
  return target;
}

async function scrollScrollableAreas(page) {
  await page.evaluate(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    for (let pass = 0; pass < 24; pass++) {
      window.scrollTo(0, document.documentElement.scrollHeight);

      const candidates = [...document.querySelectorAll("div,main,section,[role='grid'],[role='table']")]
        .filter(el => el.scrollHeight > el.clientHeight + 100)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)
        .slice(0, 10);

      for (const el of candidates) {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(500, el.clientHeight));
      }

      await wait(250);
    }

    window.scrollTo(0, 0);
  });
}

async function collectEmailsFromDom(page) {
  await scrollScrollableAreas(page);

  const raw = await page.evaluate(() => {
    const values = [];

    if (document.body?.innerText) values.push(document.body.innerText);
    if (document.body?.textContent) values.push(document.body.textContent);

    for (const el of document.querySelectorAll("a[href^='mailto:']")) {
      values.push(el.getAttribute("href") || "");
      values.push(el.textContent || "");
    }

    for (const el of document.querySelectorAll("[aria-label],[title],[data-testid],input")) {
      values.push(el.getAttribute("aria-label") || "");
      values.push(el.getAttribute("title") || "");
      values.push(el.getAttribute("data-testid") || "");
      if ("value" in el) values.push(el.value || "");
    }

    return values.join("\n");
  });

  return extractEmails(raw);
}


function attachNetworkEmailCollector(page) {
  const found = new Set();
  const sources = [];

  page.on("response", async response => {
    try {
      const url = response.url();
      if (!/canva\.(com|cn)/i.test(url)) return;

      const headers = response.headers();
      const contentType = String(headers["content-type"] || "");
      const looksRelevant = /member|members|people|team|teams|user|users|graphql|profile|access/i.test(url);
      const isTextLike = /json|text|javascript|graphql|html/i.test(contentType);
      if (!looksRelevant && !isTextLike) return;

      const contentLength = Number(headers["content-length"] || 0);
      if (contentLength > 4_000_000) return;

      const text = await response.text().catch(() => "");
      if (!text || text.length > 4_000_000) return;

      const emails = extractEmails(text);
      if (!emails.length) return;

      for (const email of emails) found.add(email);
      sources.push({
        url: url.slice(0, 300),
        status: response.status(),
        count: emails.length
      });
    } catch {
      // Some responses cannot be read after navigation. Ignore them.
    }
  });

  return { found, sources };
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

  for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
    const emails = await collectEmailsFromDom(page);
    for (const email of emails) found.add(email);

    const fingerprint = `${page.url()}|${emails.slice(0, 12).join(",")}|${emails.length}`;
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

  return [...found].sort();
}

async function findMemberRow(page, email) {
  const emailNode = page.getByText(email, { exact: false }).first();
  if (!(await emailNode.count())) return null;

  try {
    await emailNode.scrollIntoViewIfNeeded();
  } catch {}

  const handle = await emailNode.elementHandle();
  if (!handle) return null;

  return handle.evaluateHandle(node => {
    let current = node;

    for (let depth = 0; depth < 10 && current; depth++, current = current.parentElement) {
      const text = (current.innerText || "").toLowerCase();
      const buttons = current.querySelectorAll("button");

      if (text.includes((node.textContent || "").trim().toLowerCase()) && buttons.length > 0) {
        if (current.getAttribute("role") === "row" || depth >= 2) return current;
      }
    }

    return node.parentElement;
  });
}

async function tryRemoveMember(page, email) {
  const rowHandle = await findMemberRow(page, email);
  if (!rowHandle) return { ok: false, reason: "email_row_not_found" };

  const clicked = await rowHandle.evaluate((row, targetEmail) => {
    const text = (row.innerText || "").toLowerCase();
    if (!text.includes(String(targetEmail).toLowerCase())) return false;

    const buttons = [...row.querySelectorAll("button")].filter(button => !button.disabled);
    const preferred = buttons.find(button => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.textContent || ""}`.toLowerCase();
      return /more|lainnya|menu|opsi|option|actions|tindakan/.test(label);
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

      const confirmPatterns = [
        /^hapus$/i,
        /^keluarkan$/i,
        /^remove$/i,
        /^konfirmasi$/i,
        /^confirm$/i,
        /hapus dari tim/i,
        /keluarkan dari tim/i,
        /remove from team/i
      ];

      for (const confirmPattern of confirmPatterns) {
        const button = page.getByRole("button", { name: confirmPattern }).last();
        if (await button.count()) {
          try {
            await button.click({ timeout: 1400 });
          } catch {}
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

  for (const access of data || []) {
    await audit(supabase, access.account_id, access.id, access.email, "access_expired", {});
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
      .filter(access => access.status === "active" && new Date(access.ends_at).getTime() > Date.now())
      .map(access => [String(access.email).toLowerCase(), access])
  );

  const anyGrantByEmail = new Map(
    (grants || []).map(access => [String(access.email).toLowerCase(), access])
  );

  const protectedSet = new Set(
    (account.protected_emails || []).map(email => String(email).toLowerCase())
  );

  const statePath = await downloadState(supabase, account);
  const headless = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();
  const networkCollector = attachNetworkEmailCollector(page);

  let detected = 0;
  let unauthorizedCount = 0;
  let removedCount = 0;

  try {
    await page.goto(account.members_url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await sleep(4000);
    await waitForPeopleUi(page);

    const fullBodyText = await page.locator("body").innerText().catch(() => "");
    const bodyText = fullBodyText.slice(0, 5000);
    const memberCountHint = extractMemberCountHint(fullBodyText);
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    const authUrl = /\/login(?:\/|\?|$)|\/signup(?:\/|\?|$)|\/auth(?:\/|\?|$)/i.test(finalUrl);
    const hasLoginForm = await page.locator('input[type="email"], input[name*="email" i], input[autocomplete="username"]').count().catch(() => 0);

    console.log(`[scan] url=${finalUrl}`);
    console.log(`[scan] title=${pageTitle}`);

    // Do not use a loose body-text "login" check; authenticated Canva pages can
    // contain those words in unrelated UI. Only treat it as re-auth when the URL
    // is an auth URL and a login field is actually present.
    if (authUrl && hasLoginForm > 0) {
      const error = "session_needs_reauth";
      console.log(`[scan] ${error}`);
      await audit(supabase, account.id, null, null, error, { url: finalUrl, title: pageTitle });
      await updateAccountScan(supabase, account.id, {
        total: 0,
        unauthorized: 0,
        removed: 0,
        error
      });
      await notifyAdmins(`Canva Checker: session untuk ${account.name} perlu login ulang.`);
      return;
    }

    // Canva frequently renders the visible member row without exposing the email
    // as plain text. Collect from DOM + full HTML + JSON/GraphQL responses.
    const domEmails = await scanMemberEmails(page);
    const rowEmails = await collectEmailsFromMemberRows(page);
    await sleep(1000);
    let expandedEmails = [];
    if (!domEmails.length && !rowEmails.length && networkCollector.found.size === 0) {
      expandedEmails = await collectEmailsByOpeningMemberRows(page);
    }
    const htmlEmails = extractEmails(await page.content().catch(() => ""));
    const memberEmails = [...new Set([
      ...domEmails,
      ...rowEmails,
      ...expandedEmails,
      ...htmlEmails,
      ...networkCollector.found
    ])].sort();

    detected = memberEmails.length;
    console.log(`[scan] member_count_hint=${memberCountHint}`);
    console.log(`[scan] dom_emails=${domEmails.length}`);
    console.log(`[scan] row_emails=${rowEmails.length}`);
    console.log(`[scan] expanded_row_emails=${expandedEmails.length}`);
    console.log(`[scan] html_emails=${htmlEmails.length}`);
    console.log(`[scan] network_emails=${networkCollector.found.size}`);
    console.log(`[scan] network_sources=${networkCollector.sources.length}`);
    console.log(`[scan] detected=${detected}`);

    // Never replace a previously-good snapshot with an empty scan.
    if (!detected) {
      const diagnostic = {
        url: finalUrl,
        title: pageTitle,
        member_count_hint: memberCountHint,
        dom_email_count: domEmails.length,
        row_email_count: rowEmails.length,
        expanded_row_email_count: expandedEmails.length,
        html_email_count: htmlEmails.length,
        network_email_count: networkCollector.found.size,
        network_sources_count: networkCollector.sources.length
      };
      const error = memberCountHint > 0 ? "member_emails_hidden" : "member_scan_empty";
      console.log(`[scan] ${error}; final_url=${finalUrl}; title=${pageTitle}`);
      await audit(supabase, account.id, null, null, error, diagnostic);
      await updateAccountScan(supabase, account.id, {
        total: memberCountHint || 0,
        unauthorized: 0,
        removed: 0,
        error
      });
      await notifyAdmins(
        memberCountHint > 0
          ? `Canva Checker: ${account.name} mendeteksi sekitar ${memberCountHint} anggota, tetapi Canva tidak mengekspos email anggota ke DOM/detail yang dapat dibaca. Auto-remove dilewati.`
          : `Canva Checker: ${account.name} tidak menemukan email anggota. Snapshot lama tidak dihapus. Cek Members URL/session. URL saat scan: ${page.url()}`
      );
      return;
    }

    await refreshMemberSnapshot(supabase, account.id, memberEmails);

    const previousTotal = Number(account.last_scan_total || 0);
    const minSafe = previousTotal > 0
      ? Math.max(1, Math.floor(previousTotal * 0.6))
      : 1;
    const destructiveAllowed = detected >= minSafe;

    for (const [email, grant] of activeByEmail) {
      const seen = memberEmails.includes(email);
      const update = {
        last_checked_at: nowIso,
        updated_at: nowIso
      };
      if (seen) update.last_seen_in_canva = nowIso;

      const { error } = await supabase
        .from("canva_access")
        .update(update)
        .eq("id", grant.id);

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
      await notifyAdmins(
        `Canva Checker — ${account.name}\n` +
        `Scan hanya mendeteksi ${detected} email, di bawah ambang aman ${minSafe}. ` +
        `Auto-remove DIBLOKIR untuk pemeriksaan ini.`
      );
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
          const { error } = await supabase
            .from("canva_access")
            .update({
              status: "removed",
              removed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("id", grant.id);

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

    if (unauthorizedCount) {
      summary.push("", ...unauthorized.slice(0, 30).map(email => `• ${email}`));
    }

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

  let query = supabase
    .from("canva_accounts")
    .select("*")
    .eq("is_active", true)
    .order("created_at");

  const selectedAccountId = String(process.env.CANVA_ACCOUNT_ID || "").trim();
  if (selectedAccountId) {
    query = query.eq("id", selectedAccountId);
  }

  const { data: accounts, error } = await query;
  if (error) throw error;

  if (!accounts?.length) {
    console.log(selectedAccountId
      ? `Akun Canva ${selectedAccountId} tidak ditemukan/aktif.`
      : "Tidak ada akun Canva aktif.");
    return;
  }

  for (const account of accounts) {
    try {
      await processAccount(supabase, account);
    } catch (err) {
      console.error(`[${account.name}]`, err);
      await audit(supabase, account.id, null, null, "checker_error", {
        message: err.message
      });
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
const interval = Math.max(
  60 * 60 * 1000,
  Number(process.env.CHECK_INTERVAL_MS || 24 * 60 * 60 * 1000)
);

await runOnce();

if (!once) {
  setInterval(() => {
    runOnce().catch(err => console.error("[checker]", err));
  }, interval);
}
