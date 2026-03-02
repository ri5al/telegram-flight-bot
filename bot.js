const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log("✈️ Flight Bot is running...");

// ── Store pending screenshots per user (for 2-screenshot mode) ────────────────
const pendingScreenshots = {}; // { chatId: { images: [], timer: null } }

// ── System prompt for Claude ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a flight data extractor. You may receive one or two flight booking screenshots (for connecting flights).

Analyze ALL screenshots provided and return ONLY a JSON object (no markdown, no backticks, no extra text).

For a DIRECT flight, return:
{
  "type": "direct",
  "date": "February 07",
  "airline": "IndiGo",
  "origin": "Mangalore",
  "originCode": "IXE",
  "destination": "Dubai",
  "destinationCode": "DXB",
  "departureTime": "20:55",
  "arrivalTime": "02:40",
  "duration": "4 hours and 20 mins",
  "cabinBaggage": "7kg cabin",
  "checkInBaggage": "30kg check in"
}

For a CONNECTING flight (via a stop), return:
{
  "type": "connecting",
  "date": "February 07",
  "airline": "IndiGo",
  "origin": "Mangalore",
  "originCode": "IXE",
  "destination": "Srinagar",
  "destinationCode": "SXR",
  "via": "New Delhi",
  "viaCode": "DEL",
  "departureTime": "20:55",
  "arrivalTime": "08:10",
  "layoverDuration": "6 hours and 55 mins",
  "totalDuration": "11 hours and 15 mins",
  "cabinBaggage": "7kg cabin",
  "checkInBaggage": "15kg check in"
}

If a field is not found, use "N/A". Determine type based on whether there is a layover/stop/via city.`;

// ── Format DIRECT flight ──────────────────────────────────────────────────────
function formatDirect(d) {
  return (
    `✈️ *PLAN N FLY*\n` +
    `📅 ${d.date} | ${d.airline}\n` +
    `🛫 ${d.origin} - ${d.destination}\n\n` +
    `🕐 *Departure:* ${d.departureTime} from ${d.originCode}\n` +
    `🕑 *Arrival:* ${d.arrivalTime} at ${d.destinationCode}\n` +
    `⏱ ${d.duration} direct flight\n` +
    `🧳 ${d.cabinBaggage} + ${d.checkInBaggage}`
  );
}

// ── Format CONNECTING flight ──────────────────────────────────────────────────
function formatConnecting(d) {
  return (
    `✈️ *PLAN N FLY*\n` +
    `📅 ${d.date} | ${d.airline}\n` +
    `🛫 ${d.origin} - ${d.destination} (via ${d.via})\n\n` +
    `🕐 *Departure:* ${d.departureTime} from ${d.originCode}\n` +
    `⏳ ${d.layoverDuration} layover in ${d.viaCode}\n` +
    `🕑 *Arrival:* ${d.arrivalTime} at ${d.destinationCode}\n` +
    `⏱ ${d.totalDuration} flight\n` +
    `🧳 ${d.cabinBaggage} + ${d.checkInBaggage}`
  );
}

// ── Download image from Telegram ──────────────────────────────────────────────
async function downloadTelegramImage(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const base64 = Buffer.from(response.data).toString("base64");
  const ext = path.extname(fileInfo.file_path).toLowerCase();
  const contentType =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { base64, contentType };
}

// ── Send images to Claude and extract data ────────────────────────────────────
async function extractFlightData(images) {
  const content = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.contentType, data: img.base64 },
  }));

  content.push({
    type: "text",
    text:
      images.length > 1
        ? "These are screenshots of a connecting flight booking. Extract all flight details."
        : "Extract the flight details from this screenshot.",
  });

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
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

// ── Process collected screenshots ─────────────────────────────────────────────
async function processImages(chatId) {
  const session = pendingScreenshots[chatId];
  if (!session) return;

  const images = session.images;
  delete pendingScreenshots[chatId];

  try {
    const processingMsg = await bot.sendMessage(chatId, "⏳ Extracting your flight details...");
    const flightData = await extractFlightData(images);

    const formatted =
      flightData.type === "connecting"
        ? formatConnecting(flightData)
        : formatDirect(flightData);

    bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, formatted, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "❌ Couldn't process the screenshot(s). Please try with clearer images.");
  }
}

// ── Handle incoming photo ─────────────────────────────────────────────────────
async function handleImage(fileId, chatId) {
  try {
    bot.sendChatAction(chatId, "typing");
    const imageData = await downloadTelegramImage(fileId);

    if (!pendingScreenshots[chatId]) {
      pendingScreenshots[chatId] = { images: [], timer: null };
    }

    const session = pendingScreenshots[chatId];
    if (session.timer) clearTimeout(session.timer);
    session.images.push(imageData);

    if (session.images.length === 1) {
      await bot.sendMessage(
        chatId,
        `📸 Got screenshot 1!\n\nConnecting flight? Send *2nd screenshot now*.\nOr wait 5 seconds to process as a single flight.`,
        { parse_mode: "Markdown" }
      );
      session.timer = setTimeout(() => processImages(chatId), 5000);
    } else if (session.images.length === 2) {
      clearTimeout(session.timer);
      await bot.sendMessage(chatId, "📸 Got screenshot 2! Processing both now...");
      processImages(chatId);
    } else {
      clearTimeout(session.timer);
      bot.sendMessage(chatId, "⚠️ Max 2 screenshots. Processing now...");
      processImages(chatId);
    }
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "❌ Error processing image. Please try again.");
  }
}

bot.on("photo", (msg) => {
  const bestPhoto = msg.photo[msg.photo.length - 1];
  handleImage(bestPhoto.file_id, msg.chat.id);
});

bot.on("document", (msg) => {
  const doc = msg.document;
  if (!doc.mime_type || !doc.mime_type.startsWith("image/")) {
    return bot.sendMessage(msg.chat.id, "📸 Please send a flight screenshot image.");
  }
  handleImage(doc.file_id, msg.chat.id);
});

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 *Welcome to Plan N Fly Bot!*\n\n` +
    `✅ *Direct flight* → send 1 screenshot\n` +
    `✅ *Connecting flight* → send 1 or 2 screenshots\n\n` +
    `Just send the image(s) here!`,
    { parse_mode: "Markdown" }
  );
});

// ── /help ─────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `ℹ️ *How to use:*\n\n` +
    `*Direct Flight:*\nSend 1 screenshot → instant result\n\n` +
    `*Connecting Flight:*\nSend 1st screenshot → send 2nd within 5 seconds\n\n` +
    `Works with MakeMyTrip, IndiGo, SpiceJet, Air Arabia & more ✈️`,
    { parse_mode: "Markdown" }
  );
});

// ── Text fallback ─────────────────────────────────────────────────────────────
bot.on("text", (msg) => {
  if (msg.text.startsWith("/")) return;
  bot.sendMessage(msg.chat.id, "📸 Send me a flight booking *screenshot*!\n\nType /help for instructions.", { parse_mode: "Markdown" });
});
