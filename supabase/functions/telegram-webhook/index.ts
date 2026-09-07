// SHR-236: receives Telegram Bot API webhook updates and turns them into
// intake rows for human review. Never writes a transaction directly — a
// linked member's message or photo always lands in `intake` with
// status='pending', exactly like the existing manual Inbox flow.
//
// Two things an unlinked sender can do: nothing, or redeem a link code
// generated in Settings -> Household. Nothing else is ever attributed to a
// household member who hasn't proven they own that Telegram account.
//
// SHR-239: once an intake row is captured, this also asks an LLM (via
// OpenRouter) to suggest merchant/amount/date/category. That suggestion is
// stored alongside the raw content, never in place of it, and every
// suggested category is checked against the household's real categories
// before being trusted — an unmatched or low-confidence guess is left
// uncategorised rather than inventing a plausible-sounding one. A parsing
// failure never blocks the intake row itself from being captured.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const PARSE_MODEL = "google/gemini-2.5-flash-lite";

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

type ParsedIntake = {
  merchant: string | null;
  amount: number | null;
  occurred_at: string | null;
  categoryName: string | null;
  confidence: number;
};

// Calls OpenRouter (Gemini 2.5 Flash Lite: cheap, vision-capable, reliable
// instruction-following -- matches the model this household is already
// standardising on for the conversational assistant, SHR-240) to extract
// structured fields from raw text and/or a receipt photo. Returns null on
// any failure -- the caller degrades to "raw content, no suggestions"
// rather than blocking on this.
async function parseIntakeWithAI(params: {
  rawText: string | null;
  imageBase64: string | null;
  imageMime: string | null;
  categoryNames: string[];
}): Promise<ParsedIntake | null> {
  if (!OPENROUTER_API_KEY) return null;
  const { rawText, imageBase64, imageMime, categoryNames } = params;
  if (!rawText && !imageBase64) return null;

  const today = new Date().toISOString().slice(0, 10);
  const instructions =
    `Extract a household expense/income from the message and/or receipt photo below. ` +
    `Today's date is ${today}. ` +
    `Respond with ONLY a JSON object, no markdown, matching exactly: ` +
    `{"merchant": string|null, "amount": number|null, "occurred_at": "YYYY-MM-DD"|null, "category": string|null, "confidence": number} ` +
    `"category" MUST be exactly one of these household categories, verbatim, or null if none clearly fits -- never invent a category name: ` +
    `${JSON.stringify(categoryNames)}. ` +
    `"confidence" is your own confidence in this extraction, 0 to 1. ` +
    `If you cannot determine a field, use null rather than guessing.`;

  const content: Array<Record<string, unknown>> = [{ type: "text", text: instructions }];
  if (rawText) content.push({ type: "text", text: `Message: ${rawText}` });
  if (imageBase64 && imageMime) {
    content.push({ type: "image_url", image_url: { url: `data:${imageMime};base64,${imageBase64}` } });
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PARSE_MODEL,
        messages: [{ role: "user", content }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const raw = body?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);

    const amount = typeof parsed.amount === "number" && Number.isFinite(parsed.amount) ? parsed.amount : null;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
    const occurredAt = typeof parsed.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.occurred_at) ? parsed.occurred_at : null;

    return {
      merchant: typeof parsed.merchant === "string" && parsed.merchant.trim() ? parsed.merchant.trim() : null,
      amount,
      occurred_at: occurredAt,
      categoryName: typeof parsed.category === "string" ? parsed.category : null,
      confidence,
    };
  } catch {
    return null;
  }
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
  let photoBase64: string | null = null;
  let photoMime: string | null = null;

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
        const contentType = fileRes.headers.get("content-type") ?? "image/jpeg";
        const ext = filePath.split(".").pop() || "jpg";
        const storagePath = `${member.household_id}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("telegram-receipts")
          .upload(storagePath, bytes, { contentType });
        if (!uploadError) {
          photoPath = storagePath;
          // Only images go to the vision model -- a forwarded PDF or other
          // document still gets stored and reviewed, just without parsing.
          if (contentType.startsWith("image/") && bytes.length < 15_000_000) {
            photoBase64 = bytesToBase64(bytes);
            photoMime = contentType;
          }
        }
      }
    } catch {
      // Photo storage failed -- fall through with whatever text/caption exists.
    }
  }

  if (!rawText && !photoPath) return new Response("ok"); // nothing usable (a sticker, a reaction, ...)

  const { data: inserted, error: insertError } = await supabase
    .from("intake")
    .insert({
      household_id: member.household_id,
      member_id: member.id,
      source: "telegram",
      source_ref: String(updateId),
      raw_text: rawText,
      photo_path: photoPath,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code !== "23505") {
      // Anything other than 23505 (unique_violation on source_ref, meaning
      // Telegram redelivered an update already captured) is a real failure.
      await reply(chatId, "Something went wrong saving that — please try again.");
    }
    return new Response("ok");
  }

  // Parsing is a convenience layered on top of a capture that already
  // succeeded -- its failure must never surface as this message's failure.
  try {
    const { data: categories } = await supabase
      .from("categories")
      .select("id, name")
      .eq("household_id", member.household_id)
      .eq("archived", false);

    const parsed = await parseIntakeWithAI({
      rawText,
      imageBase64: photoBase64,
      imageMime: photoMime,
      categoryNames: (categories ?? []).map((c) => c.name),
    });

    if (parsed) {
      const matchedCategory = parsed.categoryName
        ? (categories ?? []).find((c) => c.name.toLowerCase() === parsed.categoryName!.toLowerCase())
        : null;

      await supabase
        .from("intake")
        .update({
          parsed_merchant: parsed.merchant,
          parsed_amount: parsed.amount,
          parsed_date: parsed.occurred_at,
          parsed_category_id: matchedCategory?.id ?? null,
          confidence: parsed.confidence,
        })
        .eq("id", inserted.id);
    }
  } catch {
    // Leave the intake row exactly as captured -- raw content, no suggestions.
  }

  await reply(chatId, "Got it — check the Inbox to review.");
  return new Response("ok");
});
