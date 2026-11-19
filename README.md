# Raspberry Pi Zero 2 W Stock Notifier

A small Bun script that polls two Turkish stores for the Raspberry Pi Zero 2 W and sends a Telegram message when the product comes back in stock.

- SAMM: https://market.samm.com/raspberry-pi-zero-2-w
- Robotistan: https://www.robotistan.com/raspberry-pi-zero-2-w

## Features

- Checks both product pages every 5 minutes.
- Reads stock status from the product's JSON-LD (`schema.org` availability), with a meta-tag fallback.
- Sends a Telegram alert only when a store transitions from out of stock to in stock.
- Persists the last known status and price in `state.json`, so restarts do not produce duplicate alerts.
- Retries failed requests and keeps running if one store cannot be fetched.
- Uses an honest User-Agent (`PiStockNotifier/1.0`) and only requests pages allowed by both sites' `robots.txt`.

## Requirements

- [Bun](https://bun.sh) 1.3+
- A Telegram bot token
- Your Telegram chat ID

## Setup

```bash
git clone git@github.com:0xgani/pi-stock-notifier.git
cd pi-stock-notifier
cp .env.example .env
```

Fill in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
POLL_INTERVAL_MS=300000
```

Start a chat with your bot and send it any message first, otherwise Telegram will not allow the bot to message you.

There are no npm dependencies; Bun runs the TypeScript directly.

## Usage

```bash
bun run test:telegram  # verify the bot token and send a test message
bun run test:instock   # send a preview of the in-stock alert
bun run check          # run a single stock check and exit
bun start              # start the notifier loop
```

## Alert format

```text
[IN STOCK] Raspberry Pi Zero 2 W

Store: SAMM
Price: TRY 1,331.85
Checked: 19/11/2026, 17:10:06

https://market.samm.com/raspberry-pi-zero-2-w?src=raspberrypi
```

## How it works

Each poll fetches both product pages and extracts the `Product` JSON-LD block. Availability values such as `InStock`, `LimitedAvailability`, and `OnlineOnly` count as in stock; `OutOfStock`, `SoldOut`, and `Discontinued` count as out of stock. The result is compared with `state.json` and a Telegram message is sent only on an out-to-in transition.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Scraper, stock detection, Telegram client, polling loop |
| `.env` | Local secrets, ignored by git |
| `state.json` | Last known stock status and price, ignored by git |
| `package.json` | Scripts and project metadata |

## Notes

- Stock detection depends on the stores keeping JSON-LD on their product pages. If a page changes format, the script logs `UNKNOWN` and does not send a false alert.
- Polling every 5 minutes equals 12 requests per hour per store, which is conservative for both sites.
- The project is intended for personal use. Respect the stores' terms and `robots.txt` if you change the interval or targets.
