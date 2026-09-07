// SHR-236: receives Telegram Bot API webhook updates and turns them into
// intake rows for human review. Never writes a transaction directly — a
// linked member's message or photo always lands in `intake` with
// status='pending', exactly like the existing manual Inbox flow.
//
// Two things an unlinked sender can do: nothing, or redeem a link code
// generated in Settings -> Household. Nothing else is ever attributed to a
// household member who hasn't proven they own that Telegram account.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tgCall(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function reply(chatId: number, text: string) {
  await tgCall("sendMessage", { chat_id: chatId, text });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // One-time setup: registers this function's own URL as the bot's webhook.
  // Meant to be hit once by whoever deploys this, not by Telegram itself.
  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    const result = await tgCall("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram-webhook`,
      allowed_updates: ["message"],
    });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  const message = update?.message as Record<string, unknown> | undefined;
  if (!message) return new Response("ok");

  const chat = message.chat as Record<string, unknown> | undefined;
  const from = message.from as Record<string, unknown> | undefined;
  const chatId = chat?.id as number | undefined;
  const fromId = from?.id as number | undefined;
  const updateId = update.update_id;
  if (!chatId || !fromId) return new Response("ok");

  const { data: member } = await supabase
    .from("household_members")
    .select("id, household_id, display_name")
    .eq("telegram_user_id", fromId)
    .maybeSingle();

  if (!member) {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (text) {
      const { data: pending } = await supabase
        .from("household_members")
        .select("id, display_name")
        .eq("telegram_link_code", text)
        .gt("telegram_link_code_expires_at", new Date().toISOString())
        .maybeSingle();

      if (pending) {
        // Uses the service-role client, which the guard trigger on
        // household_members explicitly exempts (see the telegram_linking
        // migration) -- this is the one path allowed to set telegram_user_id.
        await supabase
          .from("household_members")
          .update({ telegram_user_id: fromId, telegram_link_code: null, telegram_link_code_expires_at: null })
          .eq("id", pending.id)
          .eq("telegram_link_code", text);
        await reply(
          chatId,
          `Linked as ${pending.display_name}. Send a receipt photo or a message like "42 aed carrefour groceries" any time.`
        );
        return new Response("ok");
      }
    }
    await reply(chatId, "This Telegram account isn't linked to a Rokda household yet. Generate a code in Settings → Household and send it to me.");
    return new Response("ok");
  }

  // Linked member from here on -- everything is intake, nothing is ever
  // auto-posted as a real transaction.
  const rawText = (typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : null);
  let photoPath: string | null = null;

  const photos = message.photo as Array<{ file_id: string }> | undefined;
  const doc = message.document as { file_id: string } | undefined;
  const fileId = photos?.length ? photos[photos.length - 1].file_id : doc?.file_id;

  if (fileId) {
    try {
      const fileInfo = await tgCall("getFile", { file_id: fileId });
      const filePath = fileInfo?.result?.file_path as string | undefined;
      if (filePath) {
        const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
        const bytes = new Uint8Array(await fileRes.arrayBuffer());
        const ext = filePath.split(".").pop() || "jpg";
        const storagePath = `${member.household_id}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("telegram-receipts")
          .upload(storagePath, bytes, { contentType: fileRes.headers.get("content-type") ?? "image/jpeg" });
        if (!uploadError) photoPath = storagePath;
      }
    } catch {
      // Photo storage failed -- fall through with whatever text/caption exists.
    }
  }

  if (!rawText && !photoPath) return new Response("ok"); // nothing usable (a sticker, a reaction, ...)

  const { error: insertError } = await supabase.from("intake").insert({
    household_id: member.household_id,
    member_id: member.id,
    source: "telegram",
    source_ref: String(updateId),
    raw_text: rawText,
    photo_path: photoPath,
    status: "pending",
  });

  if (insertError && insertError.code !== "23505") {
    // Anything other than 23505 (unique_violation on source_ref, meaning
    // Telegram redelivered an update already captured) is a real failure.
    await reply(chatId, "Something went wrong saving that — please try again.");
    return new Response("ok");
  }

  await reply(chatId, "Got it — check the Inbox to review.");
  return new Response("ok");
});
