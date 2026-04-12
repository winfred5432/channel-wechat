# channel-wechat

WeChat channel adapter for openduo. Bridges WeChat (via ilink bot API) to the openduo daemon.

## Architecture

- `src/gateway.ts` — Main coordinator. Start here.
- `src/wechat.ts` — ilink bot API. All WeChat I/O goes through here.
- `src/daemon.ts` — openduo daemon RPC client (ingress / pull / ack).
- `src/auth.ts` — QR login state machine. Token lives in `~/.openduo/wechat-channel/`.
- `src/config.ts` — Environment variable parsing and validation.
- `src/index.ts` — Entry point: load config → init auth → start gateway.

## Key design decisions

- No WeChat SDK dependency. ilink bot API is plain HTTP + JSON.
- No internal session state. Session routing delegated entirely to daemon.
- Single process. Long-polling + async/await handles concurrency.
- QR code written to PNG file (`qrcode.png` in stateDir); path emitted on stdout as `QRCODE_READY:<path>` — allows agent/operator to display it.
- Message splitting: responses >4000 chars are chunked automatically.

## Running locally

```bash
cp .env.example .env
npm install
npm run dev
```

## Testing

```bash
npm test
npm run test:coverage
```

## Environment variables

See `.env.example` for all configuration options.
