# phone-bridge

**Put your local Claude Code session on your phone — over your own LAN, no third-party service.**

把本地跑着的 Claude Code 会话，变成手机上能用的一个网页：看得见它说的话、它想的、它跑的命令；也能往里发字、发图、发文件。

---

## How it works

Two pipes, nothing else.

| direction | path |
|---|---|
| **up** — phone → session | phone `—HTTP→` this server `—named pipe→` the Claude Code session |
| **down** — session → phone | the session's transcript `*.jsonl` `—tail→` this server `—SSE→` phone |

The down pipe is a **mirror**. Whatever the session writes — replies, thinking, tool calls — shows up on the phone as it happens. The up pipe writes into the session's inbox, so what you type on the phone arrives as a message from another session.

This is not a chat app. **It has no model of its own.** It is a window onto a session that is already running, plus a keyboard.

---

## Requirements

- **Node.js 18+** — no dependencies, no build step
- A **Claude Code session** running on the same machine
- Phone and computer on the **same Wi-Fi**

---

## Quick start

The server **must be started from inside a Claude Code session.** It inherits two environment variables — `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` — which are the key to the up pipe. Start it anywhere else and the up pipe is dead (the down pipe still works).

From your session's shell:

```bash
cd phone-bridge
BRIDGE_TRANSCRIPT="/path/to/your/session.jsonl" node bridge.js
```

It prints an access key on startup. On the phone: same Wi-Fi → open `http://<computer-lan-ip>:8787` → enter the key → *Add to Home Screen*.

If `BRIDGE_TRANSCRIPT` is omitted, the bridge guesses the transcript from `CLAUDE_CODE_SESSION_ID`.

To find your LAN address:

```bash
node -e "const os=require('os');for(const[n,as]of Object.entries(os.networkInterfaces()))for(const a of as)if(a.family==='IPv4'&&!a.internal)console.log(n,a.address)"
```

---

## Environment variables

| variable | default | what |
|---|---|---|
| `BRIDGE_PORT` | `8787` | port |
| `BRIDGE_TRANSCRIPT` | guessed | path to the session `.jsonl` |
| `BRIDGE_ROOT` | parent dir | where allow/deny paths are resolved from |
| `BRIDGE_MASK=0` | masking **on** | turn off secret redaction |
| `BRIDGE_TLS=0` | TLS **on if certs exist** | force plain HTTP |

---

## Config — what the bridge is allowed to touch

Copy `bridge.config.example.json` to `bridge.config.json` (gitignored, and empty by default):

```json
{
  "root": "..",
  "media": ["stickers", "memes"],
  "allow": ["notes", "projects"],
  "deny":  ["notes/private"]
}
```

| key | meaning |
|---|---|
| `root` | base directory; all other paths are relative to it |
| `media` | where `[[img:name]]` looks for images |
| `allow` | subtrees the assistant may hand to the phone via `[[file:path]]` |
| `deny` | subtrees that **never** go out — even with a valid key |

**Default is empty: the bridge hands over nothing.** Path traversal is rejected, and `deny` is checked after `allow`, so a directory can be both reachable and sealed.

The assistant announces files and images by writing `[[img:…]]` / `[[file:…]]` in its reply; the bridge pulls them out, rewrites them, and pushes them to the phone.

---

## Security — read this before you open a port

This opens an HTTP server on your LAN. **Be clear about what that means.**

**What it does defend:**

- A gate: the page asks for an access key; wrong key → `401`
- **Path traversal** — `../` and absolute paths are rejected
- **Host header** checks, which block DNS-rebinding
- Everything is confined to the `allow` list; `deny` wins over everything
- Optional TLS via a self-signed cert in `certs/`

**What it does not defend:**

- **The key travels in the URL** (`?key=…`). Anyone who captures one request keeps that key — it never expires. Over plain HTTP, someone on the same Wi-Fi sees it.
- **Plain HTTP is plain HTTP.** On a shared or public network, everything — your words, your images — is readable by anyone sniffing. On *your own* Wi-Fi it is merely unwise; on a café or office network it is not acceptable.
- **Redaction is best-effort, not a guarantee.** It masks obvious secret shapes (`sk-…`, `token:`, long high-entropy strings). Anything outside those rules can still slip through.
- The **down pipe mirrors the transcript.** Which means: whatever you say to your session, the phone sees. Do not run this on a session whose transcript you would not want on a phone.

**Recommendations, in order of how much they buy you:**

1. **Own Wi-Fi only.** "It's on the LAN" is only safe when the LAN is yours.
2. **Self-signed TLS** — put `server.key` / `server.crt` in `certs/`, and trust the CA on your phone. Kills sniffing on the local network. (`certs/` is gitignored; generate your own.)
3. **Tailscale** (or any WireGuard mesh). Encrypted end-to-end and works away from home. No port exposed. This is the option worth the five minutes.

---

## Known limits

- **The bridge is tied to one session.** Close the session (or the editor), and the bridge dies with it. One session, one pipe; switching sessions means restarting the bridge.
- **Up-pipe messages arrive as "another session", not as you.** That is the host's own security boundary — the bridge can send words, not permissions. Anything the phone asks for that crosses a line still stops and asks the human.
- **Images are re-encoded before they leave the phone** (canvas → JPEG), because some formats (indexed-colour PNG, HEIC) can wedge a session permanently. The server re-checks on arrival and refuses anything it does not recognise.
- **No auth beyond the shared key.** No per-device tokens, no revocation.

---

## Credits

- **App icon** — made by the author.
- **UI icons** (`image` / `folder`) — from iconfont.cn, collection 「043-输入法图标」 by *Caoyu_design*.
  **If you fork this, replace them** unless you have checked that author's terms:
  [Lucide](https://lucide.dev) (ISC) and [Tabler](https://tabler.io/icons) (MIT) are drop-in alternatives.

## License

MIT — see [LICENSE](LICENSE).
