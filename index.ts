type ProductConfig = {
  name: string;
  store: string;
  url: string;
  matchName: string;
};

type StockStatus = "in" | "out" | "unknown";

type StateEntry = {
  inStock: boolean;
  price?: string;
  checkedAt: string;
};

type ProductResult = {
  status: StockStatus;
  price?: string;
  source: string;
};

const PRODUCTS: ProductConfig[] = [
  {
    name: "Raspberry Pi Zero 2 W",
    store: "SAMM",
    url: "https://market.samm.com/raspberry-pi-zero-2-w?src=raspberrypi",
    matchName: "zero 2 w",
  },
  {
    name: "Raspberry Pi Zero 2 W",
    store: "Robotistan",
    url: "https://www.robotistan.com/raspberry-pi-zero-2-w?src=raspberrypi",
    matchName: "zero 2 w",
  },
];

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 300_000);
const STATE_FILE = `${import.meta.dir}/state.json`;
const USER_AGENT = "Mozilla/5.0 (compatible; PiStockNotifier/1.0; personal use)";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

function redact(text: string): string {
  return BOT_TOKEN ? text.split(BOT_TOKEN).join("[REDACTED]") : text;
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${redact(message)}`);
}

function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

async function fetchPage(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await Bun.sleep(2_000 * attempt);
    }
  }
  throw lastError;
}

function extractJsonLdDocuments(html: string): unknown[] {
  const documents: unknown[] = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(regex)) {
    const raw = match[1].trim().replace(/^<!--/, "").replace(/-->$/, "").trim();
    try {
      documents.push(JSON.parse(raw));
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return documents;
}

function collectProductNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectProductNodes(item, out);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const type = record["@type"];
    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
    if (isProduct) out.push(record);
    for (const child of Object.values(record)) collectProductNodes(child, out);
  }
  return out;
}

function collectOffers(
  offers: unknown,
  availability: string[],
  prices: string[],
): void {
  if (Array.isArray(offers)) {
    for (const offer of offers) collectOffers(offer, availability, prices);
  } else if (offers && typeof offers === "object") {
    const record = offers as Record<string, unknown>;
    if (typeof record.availability === "string") availability.push(record.availability);
    const price = record.price ?? record.lowPrice ?? record.highPrice;
    if (typeof price === "string" || typeof price === "number") prices.push(String(price));
    if (record.offers) collectOffers(record.offers, availability, prices);
  }
}

function pickProduct(
  documents: unknown[],
  config: ProductConfig,
): Record<string, unknown> | undefined {
  const nodes = documents.flatMap((doc) => collectProductNodes(doc));
  if (nodes.length === 0) return undefined;

  const targetPath = new URL(config.url).pathname.toLowerCase();
  const wantedName = config.matchName.toLowerCase();

  const score = (node: Record<string, unknown>): number => {
    let value = 0;
    if (String(node.name ?? "").toLowerCase().includes(wantedName)) value += 2;
    if (String(node.url ?? "").toLowerCase().includes(targetPath)) value += 3;
    return value;
  };

  return [...nodes].sort((a, b) => score(b) - score(a))[0];
}

function extractMetaAvailability(html: string): string[] {
  const values: string[] = [];
  const metaRegex =
    /<meta[^>]+(?:itemprop|property)=["'](?:availability|product:availability)["'][^>]*>/gi;
  for (const match of html.matchAll(metaRegex)) {
    const content = /content=["']([^"']+)["']/i.exec(match[0]);
    if (content) values.push(content[1]);
  }
  return values;
}

function classify(availability: string[]): StockStatus {
  const normalized = availability.map((value) => value.toLowerCase());
  if (normalized.length === 0) return "unknown";

  const inStock = normalized.some(
    (value) =>
      value.includes("instock") ||
      value.includes("limitedavailability") ||
      value.includes("onlineonly"),
  );
  if (inStock) return "in";

  const outOfStock = normalized.some(
    (value) =>
      value.includes("outofstock") ||
      value.includes("soldout") ||
      value.includes("discontinued"),
  );
  if (outOfStock) return "out";

  return "unknown";
}

export function checkProduct(html: string, config: ProductConfig): ProductResult {
  const documents = extractJsonLdDocuments(html);
  const product = pickProduct(documents, config);
  const availability: string[] = [];
  const prices: string[] = [];

  if (product) collectOffers(product.offers, availability, prices);

  if (availability.length === 0) {
    availability.push(...extractMetaAvailability(html));
  }

  const status = classify(availability);
  return {
    status,
    price: prices[0],
    source: product ? "JSON-LD" : "meta",
  };
}

function formatPrice(price?: string): string | undefined {
  if (!price) return undefined;
  const numeric = Number(price);
  if (!Number.isFinite(numeric)) return price;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "TRY" }).format(numeric);
}

async function telegramRequest(method: string, payload?: Record<string, unknown>): Promise<any> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!response.ok || !data.ok) {
      throw new Error(data.description ?? `HTTP ${response.status}`);
    }
    return data.result;
  } catch (error) {
    throw new Error(`Telegram ${method} failed: ${errorMessage(error)}`);
  }
}

async function sendTelegramMessage(text: string): Promise<void> {
  await telegramRequest("sendMessage", {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: false,
  });
}

function buildInStockMessage(config: ProductConfig, result: ProductResult): string {
  const lines = [
    `[IN STOCK] ${config.name}`,
    "",
    `Store: ${config.store}`,
    `Price: ${formatPrice(result.price) ?? "unknown"}`,
    `Checked: ${new Date().toLocaleString("en-GB")}`,
    "",
    config.url,
  ];
  return lines.join("\n");
}

async function loadState(): Promise<Record<string, StateEntry>> {
  try {
    return (await Bun.file(STATE_FILE).json()) as Record<string, StateEntry>;
  } catch {
    return {};
  }
}

async function saveState(state: Record<string, StateEntry>): Promise<void> {
  await Bun.write(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function checkAll(): Promise<void> {
  const state = await loadState();

  for (const config of PRODUCTS) {
    try {
      const html = await fetchPage(config.url);
      const result = checkProduct(html, config);
      const previous = state[config.url];
      const price = formatPrice(result.price) ?? "unknown";

      log(
        `${config.store}: ${config.name} -> ${result.status.toUpperCase()} (${result.source}, price: ${price})`,
      );

      if (result.status === "in" && !previous?.inStock) {
        await sendTelegramMessage(buildInStockMessage(config, result));
        log(`${config.store}: in-stock notification sent to Telegram`);
      }

      state[config.url] = {
        inStock: result.status === "in",
        price: result.price,
        checkedAt: new Date().toISOString(),
      };
      await saveState(state);
    } catch (error) {
      log(`${config.store}: check failed: ${errorMessage(error)}`);
    }
  }
}

async function runTelegramTest(): Promise<void> {
  log("Testing Telegram bot token...");
  const bot = await telegramRequest("getMe");
  log(`Token valid. Bot: @${bot.username} (${bot.first_name})`);

  log(`Sending test message to chat ${CHAT_ID}...`);
  await sendTelegramMessage(
    "Telegram test from the Raspberry Pi Zero 2 W stock notifier. Notifications are working.",
  );
  log("Test message sent successfully. Check your Telegram.");
}

async function runInStockPreview(): Promise<void> {
  const config = PRODUCTS[0];
  const html = await fetchPage(config.url);
  const result = checkProduct(html, config);

  const text = [
    buildInStockMessage(config, { ...result, status: "in" }),
    "",
    "This is a test preview; the product is still out of stock.",
  ].join("\n");

  await sendTelegramMessage(text);
  log(`${config.store}: in-stock preview sent to Telegram`);
}

async function main(): Promise<void> {
  const args = new Set(Bun.argv.slice(2));

  if (args.has("--test")) {
    await runTelegramTest();
  } else if (args.has("--test-instock")) {
    await runInStockPreview();
  } else if (args.has("--once")) {
    await checkAll();
  } else {
    log(
      `Starting notifier for ${PRODUCTS.length} products, polling every ${Math.round(POLL_INTERVAL_MS / 1000)}s`,
    );
    while (true) {
      await checkAll();
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
}

if (import.meta.main) {
  await main();
}
