const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log("✈️ Flight Bot is running...");

// ── System prompt for Claude ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a flight data extractor. Extract flight information from the screenshot and return ONLY a JSON object with these exact fields (no markdown, no extra text, no backticks):
{
  "date": "",
  "airline": "",
  "route": "",
  "departureTime": "",
  "departureCode": "",
  "arrivalTime": "",
  "arrivalCode": "",
  "duration": "",
  "flightType": "direct flight",
  "cabinBaggage": "",
  "checkInBaggage": ""
}
Replace values with what you see in the screenshot. If a field is not found, use "N/A".`;

// ── Format into Plan N Fly style ──────────────────────────────────────────────
function formatFlightData(data) {
  return (
    `✈️ *Plan N Fly*\n` +
    `📅 ${data.date} | ${data.airline}\n` +
    `🛫 ${data.route}\n\n` +
    `🕐 *Departure:* ${data.departureTime} from ${data.departureCode}\n` +
    `🕑 *Arrival:* ${data.arrivalTime} at ${data.arrivalCode}\n` +
    `⏱ ${data.duration} ${data.flightType}\n` +
    `🧳 ${data.cabinBaggage} + ${data.checkInBaggage}`
  );
}

// ── Download image from Telegram ──────────────────────────────────────────────
async function downloadTelegramImage(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const base64 = Buffer.from(response.data).toString("base64");
  const ext = path.extname(fileInfo.file_path).toLowerCase();
  const contentType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { base64, contentType };
}

// ── Send image to Claude and extract data ─────────────────────────────────────
async function extractFlightData(base64, contentType) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: contentType, data: base64 },
            },
            { type: "text", text: "Extract the flight details from this screenshot." },
          ],
        },
      ],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const text = response.data.content.map((b) => b.text || "").join("").trim();
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── Handle /start command ─────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 *Welcome to Plan N Fly Bot!*\n\nSend me any *flight booking screenshot* and I'll instantly extract the details in a clean format.\n\n📸 Just send the image directly in this chat!`,
    { parse_mode: "Markdown" }
  );
});

// ── Handle /help command ──────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `ℹ️ *How to use:*\n\n1. Take a screenshot of your flight booking\n2. Send it here as a photo\n3. Get clean formatted flight info instantly!\n\n✅ Works with: MakeMyTrip, SpiceJet, IndiGo, Air Arabia, flydubai, Booking emails & more.`,
    { parse_mode: "Markdown" }
  );
});

// ── Handle incoming photos ────────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Show typing indicator
    bot.sendChatAction(chatId, "typing");

    // Send processing message
    const processingMsg = await bot.sendMessage(chatId, "⏳ Reading your flight screenshot...");

    // Get highest quality photo
    const photos = msg.photo;
    const bestPhoto = photos[photos.length - 1];

    // Download and extract
    const { base64, contentType } = await downloadTelegramImage(bestPhoto.file_id);
    const flightData = await extractFlightData(base64, contentType);
    const formatted = formatFlightData(flightData);

    // Delete processing message
    bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

    // Send result
    await bot.sendMessage(chatId, formatted, { parse_mode: "Markdown" });

  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(
      chatId,
      "❌ Sorry, I couldn't read that screenshot. Please try:\n• A clearer image\n• Higher resolution screenshot\n• Make sure flight details are visible"
    );
  }
});

// ── Handle documents sent as files (not compressed) ──────────────────────────
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (!doc.mime_type || !doc.mime_type.startsWith("image/")) {
    return bot.sendMessage(chatId, "📸 Please send a flight *screenshot* (image file), not a document.");
  }

  try {
    bot.sendChatAction(chatId, "typing");
    const processingMsg = await bot.sendMessage(chatId, "⏳ Reading your flight screenshot...");
    const { base64, contentType } = await downloadTelegramImage(doc.file_id);
    const flightData = await extractFlightData(base64, contentType);
    const formatted = formatFlightData(flightData);
    bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, formatted, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "❌ Couldn't process that image. Please try a clearer screenshot.");
  }
});

// ── Handle text messages (no image) ──────────────────────────────────────────
bot.on("text", (msg) => {
  if (msg.text.startsWith("/")) return; // ignore commands
  bot.sendMessage(
    msg.chat.id,
    "📸 Please send me a *flight booking screenshot* as a photo!\n\nType /help for instructions.",
    { parse_mode: "Markdown" }
  );
});
