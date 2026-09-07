import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi.");
  }
  if (!/^https:\/\/.+\.supabase\.co$/i.test(url)) {
    throw new Error("SUPABASE_URL tidak valid.");
  }
  if (/\s/.test(key)) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY mengandung spasi atau line break.");
  }
  if (!(key.startsWith("sb_secret_") || key.startsWith("eyJ"))) {
    throw new Error("Supabase API key tidak valid.");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}
