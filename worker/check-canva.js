import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSupabase } from "../lib/supabase.js";
import { sendMessage } from "../lib/telegram.js";

const EMAIL_RE=/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const envList=n=>String(process.env[n]||"").split(",").map(x=>x.trim()).filter(Boolean);

async function downloadState(supabase){
  const bucket=process.env.CANVA_STORAGE_BUCKET||"canva-private";
  const file=process.env.CANVA_STORAGE_FILE||"canva-storage.json";
  const {data,error}=await supabase.storage.from(bucket).download(file);
  if(error)throw error;
  const target=path.join(os.tmpdir(),`canva-storage-${Date.now()}.json`);
  await fs.writeFile(target,Buffer.from(await data.arrayBuffer()));
  return target;
}

async function getAllowed(supabase){
  const {data,error}=await supabase.from("canva_access").select("email").in("status",["registered","joined","verified"]);
  if(error)throw error;
  return new Set((data||[]).map(x=>String(x.email).toLowerCase()));
}

async function audit(supabase,email,event,details={}){
  await supabase.from("canva_audit").insert({email,event,details});
}

async function collectEmails(page){
  const text=await page.locator("body").innerText();
  return [...new Set((text.match(EMAIL_RE)||[]).map(x=>x.toLowerCase()))];
}

async function tryRemoveMember(page,email){
  const emailNode=page.getByText(email,{exact:false}).first();
  if(!(await emailNode.count()))return {ok:false,reason:"email_not_found_in_dom"};
  const handle=await emailNode.elementHandle();
  if(!handle)return {ok:false,reason:"no_element_handle"};

  const clicked=await handle.evaluate(node=>{
    let cur=node;
    for(let i=0;i<8&&cur;i++,cur=cur.parentElement){
      const buttons=[...cur.querySelectorAll("button")];
      if(buttons.length){
        const candidate=buttons.find(b=>{
          const a=(b.getAttribute("aria-label")||"").toLowerCase();
          const t=(b.textContent||"").toLowerCase();
          return /more|lainnya|menu|opsi|option/.test(a+" "+t);
        })||buttons[buttons.length-1];
        candidate.click(); return true;
      }
    }
    return false;
  });
  if(!clicked)return {ok:false,reason:"row_menu_not_found"};

  await page.waitForTimeout(600);
  for(const label of envList("CANVA_REMOVE_LABELS")){
    const item=page.getByText(label,{exact:false}).last();
    if(await item.count()){
      await item.click();
      await page.waitForTimeout(700);
      const confirm=page.getByText(label,{exact:false}).last();
      if(await confirm.count()){try{await confirm.click({timeout:1000})}catch{}}
      await page.waitForTimeout(1000);
      return {ok:true};
    }
  }
  return {ok:false,reason:"remove_action_not_found"};
}

async function runOnce(){
  const membersUrl=process.env.CANVA_MEMBERS_URL;
  if(!membersUrl)throw new Error("CANVA_MEMBERS_URL belum diisi.");

  const supabase=getSupabase();
  const statePath=await downloadState(supabase);
  const allowed=await getAllowed(supabase);
  const protectedEmails=new Set(envList("CANVA_PROTECTED_EMAILS").map(x=>x.toLowerCase()));
  const autoRemove=String(process.env.AUTO_REMOVE||"false").toLowerCase()==="true";

  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({storageState:statePath});
  const page=await context.newPage();

  try{
    await page.goto(membersUrl,{waitUntil:"domcontentloaded",timeout:60000});
    await page.waitForTimeout(4000);
    if(/login|signup/i.test(page.url()))throw new Error("Session Canva tidak login.");

    const memberEmails=await collectEmails(page);
    const unauthorized=memberEmails.filter(e=>!allowed.has(e)&&!protectedEmails.has(e));
    const now=new Date().toISOString();

    for(const email of allowed){
      const seen=memberEmails.includes(email);
      await supabase.from("canva_access").update({
        status:seen?"joined":"registered",
        last_seen_in_canva:seen?now:null,
        last_checked_at:now,
        updated_at:now
      }).eq("email",email);
    }

    for(const email of unauthorized){
      await audit(supabase,email,"unauthorized_detected",{autoRemove});
      if(autoRemove){
        const result=await tryRemoveMember(page,email);
        await audit(supabase,email,result.ok?"remove_attempted":"remove_failed",result);
      }
    }

    if(process.env.ADMIN_TELEGRAM_ID&&unauthorized.length){
      await sendMessage(
        process.env.ADMIN_TELEGRAM_ID,
        `Canva checker menemukan ${unauthorized.length} email yang tidak ada di whitelist:\n\n`+
        unauthorized.map(x=>`• ${x}`).join("\n")+
        `\n\nAUTO_REMOVE=${autoRemove}`
      );
    }

    console.log({checked:memberEmails.length,allowed:allowed.size,unauthorized,autoRemove});
  }finally{
    await browser.close();
    await fs.unlink(statePath).catch(()=>{});
  }
}

const once=process.argv.includes("--once");
const interval=Number(process.env.CHECK_INTERVAL_MS||60000);
await runOnce();
if(!once)setInterval(()=>runOnce().catch(err=>console.error("[checker]",err)),interval);
