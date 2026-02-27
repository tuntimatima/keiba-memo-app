import { createClient } from '@supabase/supabase-js';

declare global {
  // eslint-disable-next-line no-var
  var __keiba_supabase_client: any | undefined;
}

export const supabase: any =
  globalThis.__keiba_supabase_client ??
  (globalThis.__keiba_supabase_client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  ));