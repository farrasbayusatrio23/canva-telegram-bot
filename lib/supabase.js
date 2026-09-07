import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error("Supabase env belum diisi.");
  }

  if (/\s/.test(key)) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY mengandung spasi atau line break."
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
