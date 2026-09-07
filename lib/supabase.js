import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env belum diisi.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
