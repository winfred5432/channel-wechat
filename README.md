# @openduo/channel-wechat

WeChat channel plugin for [duoduo](https://openduo.ai) — connects WeChat (via ilink bot API) to your duoduo agent.

## How it works

1. Clone this repo, install dependencies, and start the adapter
2. If no valid session exists, the process outputs: `QRCODE_READY:/path/to/qrcode.png`
3. A Feishu Agent (duoduo) reads this signal, fetches the PNG, and sends it to the user via Feishu
4. The user scans the QR code with WeChat
5. The process outputs: `WECHAT_CONNECTED:<botId>` — the channel is live
6. All WeChat messages are forwarded to the openduo daemon and responses are sent back

**The entire onboarding flow happens inside Feishu — no terminal access required.**

## Install

```bash
duoduo channel install @openduo/channel-wechat
```

For a local tarball:

```bash
npm pack
duoduo channel install ./openduo-channel-wechat-0.1.0.tgz
```

## Quickstart

```bash
gh repo clone winfred5432/channel-wechat
cd channel-wechat
npm ci
npm run build:plugin
cp .env.example .env
# edit .env if needed
npm start
```

The agent monitors stdout for `QRCODE_READY:` and `WECHAT_CONNECTED:` signals.

For stdio or TTY workflows, render the current pending QR code as terminal
characters without parsing logs:

```bash
duoduo-wechat qrcode-terminal --state-dir ~/.aladuo/channel-wechat
```

If you are running from a source checkout or package root:

```bash
node dist/plugin.js qrcode-terminal --state-dir ~/.aladuo/channel-wechat
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ALADUO_DAEMON_URL` | `http://127.0.0.1:20233` | openduo daemon RPC URL |
| `WECHAT_API_BASE` | `https://ilinkai.weixin.qq.com` | ilink bot API base URL |
| `WECHAT_DM_POLICY` | `open` | `open` (all users) or `allowlist` |
| `WECHAT_ALLOW_FROM` | — | Comma-separated WeChat userIds (allowlist mode only) |
| `WECHAT_STATE_DIR` | `~/.aladuo/channel-wechat` | Persisted token and sync cursor |
| `WECHAT_LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |

## Architecture

```
WeChat (ilink bot API)
       │
       ▼
  [channel-wechat]
  ┌─────────────────────────────────────┐
  │  auth.ts — QR login state machine   │
  │  wechat.ts — ilink HTTP client      │
  │  gateway.ts — ingress + pull loops  │
  │  daemon.ts — openduo RPC client     │
  └─────────────────────────────────────┘
       │
       ▼
  openduo daemon  ←→  Claude / Agent
```

## State Directory

Default: `~/.aladuo/channel-wechat/`

| File | Description |
|------|-------------|
| `credentials.json` | Auth token (chmod 600) |
| `sync-buf.txt` | Message cursor for getupdates |
| `qrcode.png` | Temporary — deleted after scan |
| `qrcode.txt` | Temporary raw QR payload for `qrcode-terminal` |

## Development

```bash
npm ci
npm run dev         # run with tsx (hot reload friendly)
npm test            # vitest unit tests
npm run test:coverage  # coverage report
npm run build       # bundle dist/plugin.js
```

## License

MIT
