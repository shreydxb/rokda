// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { createClient } from "jsr:@supabase/supabase-js@2.117.2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

export const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");

export const PARSE_MODEL = "google/gemini-2.5-flash-lite";

// The app's address, for the buttons that open a screen ("Open Inbox"). An
// Edge Function secret, so the public repository names no household's site;
// until it is set, those buttons are left off (docs/decisions.md, "A tap on
// Record records, with Undo for ten minutes"). Telegram takes only https.
export function appAddress(raw: string | undefined): string | null {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+/.test(url) ? url : null;
}

export const APP_URL = appAddress(Deno.env.get("APP_URL"));


export const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

export const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
