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


function getCdpMap() {
  const map = new Map();
  const raw = String(process.env.CANVA_CDP_MAP || "");
  for (const part of raw.split(/[\n,]/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const slug = part.slice(0, idx).trim().toLowerCase();
    const url = part.slice(idx + 1).trim();
    if (slug && url) map.set(slug, url);
  }
  return map;
}

function getCdpUrl(account) {
  const map = getCdpMap();
  return map.get(String(account.slug || "").toLowerCase()) || String(process.env.CANVA_CDP_URL || "").trim();
}

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


// Strict member-row collector. The broad v6.4 collector intentionally searched
// the whole page/network and could include unrelated account, invitation, billing,
// or cached emails. For destructive actions we only trust a source that matches
// Canva's own member-count hint.
async function collectStrictMemberRowSources(page) {
  const selectorDefs = [
    { name: "role_row", selector: "[role='row']" },
    { name: "table_row", selector: "tr" },
    { name: "member_testid", selector: "[data-testid*='member' i]" },
    { name: "people_testid", selector: "[data-testid*='people' i]" },
    { name: "user_testid", selector: "[data-testid*='user' i]" },
    { name: "listitem", selector: "[role='listitem']" }
  ];

  const buckets = new Map(selectorDefs.map(x => [x.name, new Set()]));
  const rejectedMultiEmailRows = new Map(selectorDefs.map(x => [x.name, 0]));

  for (let pass = 0; pass < 28; pass++) {
    const batch = await page.evaluate((defs) => {
      const isVisible = el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (Number(style.opacity || 1) === 0) return false;
        if (el.closest('[aria-hidden="true"]')) return false;
        return true;
      };

      return defs.map(def => {
        const rows = [];
        for (const el of document.querySelectorAll(def.selector)) {
          if (!isVisible(el)) continue;
          const text = [
            el.innerText || "",
            el.getAttribute?.("aria-label") || "",
            el.getAttribute?.("title") || ""
          ].filter(Boolean).join(" ").trim();
          if (!text || text.length > 1200) continue;
          rows.push(text);
        }
        return { name: def.name, rows };
      });
    }, selectorDefs);

    for (const group of batch) {
      for (const text of group.rows) {
        if (/\b(invite|invited|invitation|undang|diundang|pending invite|search|cari anggota|add people|tambah orang)\b/i.test(text)) {
          continue;
        }
        const emails = extractEmails(text);
        // A real member row should identify one member. Containers that include
        // multiple member rows are skipped instead of contaminating the set.
        if (emails.length === 1) {
          buckets.get(group.name).add(emails[0]);
        } else if (emails.length > 1) {
          rejectedMultiEmailRows.set(group.name, rejectedMultiEmailRows.get(group.name) + 1);
        }
      }
    }

    // Advance the largest scrollable regions to support virtualized member lists.
    const moved = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll("div,main,section,[role='grid'],[role='table']")]
        .filter(el => el.scrollHeight > el.clientHeight + 100)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)
        .slice(0, 8);
      let changed = false;
      for (const el of candidates) {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(420, el.clientHeight * 0.8));
        if (el.scrollTop !== before) changed = true;
      }
      const beforeWindow = window.scrollY;
      window.scrollBy(0, Math.max(500, window.innerHeight * 0.8));
      if (window.scrollY !== beforeWindow) changed = true;
      return changed;
    });

    await sleep(220);
    if (!moved && pass >= 3) break;
  }

  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll("div,main,section,[role='grid'],[role='table']")) {
      if (el.scrollHeight > el.clientHeight + 100) el.scrollTop = 0;
    }
  }).catch(() => {});

  return selectorDefs.map(def => ({
    name: def.name,
    emails: [...buckets.get(def.name)].sort(),
    rejected_multi_email_rows: rejectedMultiEmailRows.get(def.name)
  }));
}

function chooseTrustedMemberEmails({ memberCountHint, strictSources, domEmails, rowEmails, htmlEmails, networkEmails }) {
  const candidates = [];
  for (const source of strictSources) {
    if (source.emails.length) candidates.push({ name: `strict:${source.name}`, emails: source.emails, priority: 1 });
  }

  // Fallback sources are only trusted if their unique count exactly matches
  // Canva's own visible member count. They are never merged together.
  if (domEmails.length) candidates.push({ name: "dom", emails: domEmails, priority: 10 });
  if (rowEmails.length) candidates.push({ name: "broad_rows", emails: rowEmails, priority: 11 });
  if (htmlEmails.length) candidates.push({ name: "html", emails: htmlEmails, priority: 12 });
  if (networkEmails.length) candidates.push({ name: "network", emails: networkEmails, priority: 13 });

  if (memberCountHint > 0) {
    const exact = candidates
      .filter(x => x.emails.length === memberCountHint)
      .sort((a, b) => a.priority - b.priority);
    if (exact.length) return { trusted: true, source: exact[0].name, emails: exact[0].emails, candidates };

    const strictNonEmpty = candidates
      .filter(x => x.name.startsWith("strict:") && x.emails.length > 0)
      .sort((a, b) => Math.abs(a.emails.length - memberCountHint) - Math.abs(b.emails.length - memberCountHint) || a.priority - b.priority);

    return {
      trusted: false,
      source: strictNonEmpty[0]?.name || "none",
      emails: strictNonEmpty[0]?.emails || [],
      candidates
    };
  }

  // Without a member-count hint, prefer the narrowest strict source. We still
  // mark it untrusted so Auto Remove remains disabled for the run.
  const strict = candidates.filter(x => x.name.startsWith("strict:")).sort((a,b) => a.priority - b.priority);
  return { trusted: false, source: strict[0]?.name || "none", emails: strict[0]?.emails || [], candidates };
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

  const browserMode = String(process.env.CHECKER_BROWSER_MODE || "storage").trim().toLowerCase();
  let statePath = null;
  let browser = null;
  let page = null;
  let closeBrowserWhenDone = true;

  if (browserMode === "cdp") {
    const cdpUrl = getCdpUrl(account);
    if (!cdpUrl) throw new Error(`CDP URL belum diatur untuk slug ${account.slug}. Isi CANVA_CDP_MAP.`);
    console.log(`[browser] mode=cdp; account=${account.slug}; url=${cdpUrl}`);
    browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome CDP tidak memiliki browser context.");
    page = await context.newPage();
    closeBrowserWhenDone = false;
  } else {
    statePath = await downloadState(supabase, account);
    const headless = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
    console.log(`[browser] mode=storage; headless=${headless}`);
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ storageState: statePath });
    page = await context.newPage();
  }

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


    const challengePage = /just a moment|checking your browser|verify you are human|security check|captcha/i.test(`${pageTitle}\n${bodyText}`);
    if (challengePage) {
      const error = "security_challenge";
      console.log(`[scan] ${error}; browser_mode=${browserMode}`);
      await audit(supabase, account.id, null, null, error, { url: finalUrl, title: pageTitle, browser_mode: browserMode });
      await updateAccountScan(supabase, account.id, { total: Number(account.last_scan_total || 0), unauthorized: 0, removed: 0, error });
      await notifyAdmins(
        browserMode === "cdp"
          ? `Canva Checker: ${account.name} masih menampilkan halaman verifikasi keamanan. Buka Chrome profile checker dan selesaikan verifikasi secara manual, lalu scan lagi.`
          : `Canva Checker: ${account.name} diblokir halaman verifikasi keamanan pada browser cloud/headless. Gunakan Local Checker Agent dengan Chrome normal.`
      );
      return;
    }

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

    // v6.5: keep broad collectors for diagnostics, but DO NOT merge them.
    // Merging DOM/HTML/network was the reason a team with 11 members could be
    // reported as 28 emails. First collect visible one-member rows by selector.
    const strictSources = await collectStrictMemberRowSources(page);
    const domEmails = await scanMemberEmails(page);
    const rowEmails = await collectEmailsFromMemberRows(page);
    await sleep(700);
    let expandedEmails = [];
    if (!domEmails.length && !rowEmails.length && networkCollector.found.size === 0) {
      expandedEmails = await collectEmailsByOpeningMemberRows(page);
    }
    const htmlEmails = extractEmails(await page.content().catch(() => ""));
    const networkEmails = [...networkCollector.found].sort();

    const selection = chooseTrustedMemberEmails({
      memberCountHint,
      strictSources,
      domEmails,
      rowEmails,
      htmlEmails,
      networkEmails
    });
    const memberEmails = selection.emails;
    detected = memberEmails.length;

    console.log(`[scan] member_count_hint=${memberCountHint}`);
    for (const source of strictSources) {
      console.log(`[scan] strict_${source.name}=${source.emails.length}; rejected_multi=${source.rejected_multi_email_rows}`);
    }
    console.log(`[scan] dom_emails=${domEmails.length}`);
    console.log(`[scan] row_emails=${rowEmails.length}`);
    console.log(`[scan] expanded_row_emails=${expandedEmails.length}`);
    console.log(`[scan] html_emails=${htmlEmails.length}`);
    console.log(`[scan] network_emails=${networkEmails.length}`);
    console.log(`[scan] network_sources=${networkCollector.sources.length}`);
    console.log(`[scan] selected_source=${selection.source}`);
    console.log(`[scan] selected_count=${detected}`);
    console.log(`[scan] trusted=${selection.trusted}`);

    const diagnostic = {
      url: finalUrl,
      title: pageTitle,
      member_count_hint: memberCountHint,
      strict_sources: strictSources.map(x => ({ name: x.name, count: x.emails.length, rejected_multi_email_rows: x.rejected_multi_email_rows })),
      dom_email_count: domEmails.length,
      row_email_count: rowEmails.length,
      expanded_row_email_count: expandedEmails.length,
      html_email_count: htmlEmails.length,
      network_email_count: networkEmails.length,
      network_sources_count: networkCollector.sources.length,
      selected_source: selection.source,
      selected_count: detected,
      trusted: selection.trusted
    };

    if (!detected) {
      const error = memberCountHint > 0 ? "member_emails_hidden" : "member_scan_empty";
      console.log(`[scan] ${error}; final_url=${finalUrl}; title=${pageTitle}`);
      await audit(supabase, account.id, null, null, error, diagnostic);
      await updateAccountScan(supabase, account.id, { total: memberCountHint || 0, unauthorized: 0, removed: 0, error });
      await notifyAdmins(
        memberCountHint > 0
          ? `Canva Checker: ${account.name} melihat ${memberCountHint} anggota, tetapi belum mendapat daftar email yang bisa dipercaya. Auto-remove dilewati.`
          : `Canva Checker: ${account.name} tidak menemukan email anggota. Snapshot lama tidak dihapus.`
      );
      return;
    }

    // If Canva says 11 members but every candidate source disagrees, never
    // overwrite the good snapshot and never perform removals. This is a hard
    // safety gate against false positives such as the prior 28-email scan.
    if (!selection.trusted) {
      const error = memberCountHint > 0
        ? `member_count_mismatch:${detected}!=${memberCountHint}`
        : "member_count_unverified";
      console.log(`[scan] ${error}; source=${selection.source}`);
      console.log(`[scan] candidate_counts=${selection.candidates.map(x => `${x.name}:${x.emails.length}`).join(",")}`);
      await audit(supabase, account.id, null, null, "member_scan_untrusted", diagnostic);
      await updateAccountScan(supabase, account.id, {
        total: memberCountHint || detected,
        unauthorized: 0,
        removed: 0,
        error
      });
      await notifyAdmins(
        `Canva Checker — ${account.name}\nCanva menampilkan ${memberCountHint || "?"} anggota, tetapi sumber email terbaik berisi ${detected}. ` +
        `Scan ditandai TIDAK TERPERCAYA dan Auto Remove diblokir. Sumber: ${selection.source}.`
      );
      return;
    }

    await refreshMemberSnapshot(supabase, account.id, memberEmails);

    const previousTotal = Number(account.last_scan_total || 0);
    const minSafe = previousTotal > 0
      ? Math.max(1, Math.floor(previousTotal * 0.6))
      : 1;
    const destructiveAllowed = selection.trusted && detected >= minSafe;

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
    try { if (page) await page.close(); } catch {}
    if (closeBrowserWhenDone && browser) {
      try { await browser.close(); } catch {}
    }
    if (statePath) await fs.unlink(statePath).catch(() => {});
  }
}

async function runOnce(selectedAccountOverride = "") {
  const supabase = getSupabase();
  await markExpired(supabase);

  let query = supabase
    .from("canva_accounts")
    .select("*")
    .eq("is_active", true)
    .order("created_at");

  const selectedAccountId = String(selectedAccountOverride || process.env.CANVA_ACCOUNT_ID || "").trim();
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

async function claimPendingRequest(supabase) {
  const { data: pending, error } = await supabase
    .from("canva_scan_requests")
    .select("id,account_id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!pending) return null;

  const { data, error: claimError } = await supabase
    .from("canva_scan_requests")
    .update({ status: "running", started_at: new Date().toISOString(), error: null })
    .eq("id", pending.id)
    .eq("status", "pending")
    .select("id,account_id")
    .maybeSingle();
  if (claimError) throw claimError;
  return data || null;
}

async function processPendingRequests() {
  if (String(process.env.CHECKER_BROWSER_MODE || "").toLowerCase() !== "cdp") return;
  const supabase = getSupabase();
  for (let i = 0; i < 5; i++) {
    const request = await claimPendingRequest(supabase);
    if (!request) break;
    console.log(`[request] scan ${request.id} account=${request.account_id}`);
    try {
      await runOnce(request.account_id);
      await supabase.from("canva_scan_requests").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        error: null
      }).eq("id", request.id);
    } catch (err) {
      console.error(`[request ${request.id}]`, err);
      await supabase.from("canva_scan_requests").update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error: String(err?.message || err)
      }).eq("id", request.id);
    }
  }
}

const once = process.argv.includes("--once");
const interval = Math.max(
  60 * 60 * 1000,
  Number(process.env.CHECK_INTERVAL_MS || 24 * 60 * 60 * 1000)
);
const requestPollMs = Math.max(5000, Number(process.env.SCAN_REQUEST_POLL_MS || 15000));

await runOnce();
if (!once && String(process.env.CHECKER_BROWSER_MODE || "").toLowerCase() === "cdp") {
  await processPendingRequests().catch(err => console.error("[request poll]", err));
}

if (!once) {
  setInterval(() => runOnce().catch(err => console.error("[checker]", err)), interval);
  if (String(process.env.CHECKER_BROWSER_MODE || "").toLowerCase() === "cdp") {
    setInterval(() => processPendingRequests().catch(err => console.error("[request poll]", err)), requestPollMs);
  }
}
