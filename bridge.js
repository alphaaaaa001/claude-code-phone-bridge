// ============================================================
// phone-bridge · 桥
// ------------------------------------------------------------
// 两根管子：
//   上行  手机 --HTTP--> 本服务 --命名管道--> Claude Code 当前会话
//   下行  Claude Code 的转录文件(.jsonl) --本服务--> 手机 (SSE 推送)
//
// ⚠️ 必须由会话内的 Bash 启动，才能继承
//    CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

// ---------- 配置 ----------
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const HOST = '0.0.0.0';               // 绑全网卡，手机才连得上
const DIR = __dirname;
const KEY_FILE = path.join(DIR, 'key.txt');
const PUBLIC = path.join(DIR, 'public');
const INBOX = path.join(DIR, 'inbox');   // 手机发来的图片/文件落这儿
// 免口令的静态文件：页面自己，加上 PWA 要的清单和图标（浏览器取它们时带不了口令）
const STATIC_FILES = {
  '/index.html':    'text/html; charset=utf-8',
  '/manifest.json': 'application/manifest+json; charset=utf-8',
  '/icon-418.png':  'image/png',
};
const MAX_UPLOAD = 30 * 1024 * 1024;      // 30 MB（手机照片够用）

fs.mkdirSync(INBOX, { recursive: true });

// 脱敏开关：true = 把密钥类字串打成 ***（the user 可随时改 false）
const MASK = process.env.BRIDGE_MASK !== '0';

// 手机来信在会话里长什么样
const PHONE_PREFIX = '📱';

// ---------- 访问口令 ----------
let ACCESS_KEY;
if (fs.existsSync(KEY_FILE)) {
  ACCESS_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
} else {
  ACCESS_KEY = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(KEY_FILE, ACCESS_KEY, { mode: 0o600 });
}

// ---------- 脱敏 ----------
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{8,}/g,                                   // OpenAI/Anthropic 风格
  /\b([A-Za-z0-9_\-]{20,}@[a-z0-9.\-]*im\.bot:[A-Za-z0-9]+)/g,  // 微信 bot token
  /("?(?:token|secret|app_secret|password|passwd|auth_token|api_key|apikey)"?\s*[:=]\s*"?)([^\s"',}]{6,})/gi,
  /\b([A-Za-z0-9]{32,})\b/g,                                     // 裸的高熵串（NapCat token 那种）
];

function mask(text) {
  if (!MASK || typeof text !== 'string') return text;
  let out = text;
  out = out.replace(SECRET_PATTERNS[0], '***');
  out = out.replace(SECRET_PATTERNS[1], '***');
  out = out.replace(SECRET_PATTERNS[2], '$1***');
  // 门口令自己也不能露——它短，上面几条网眼漏得过去
  if (ACCESS_KEY) out = out.split(ACCESS_KEY).join('***');
  return out;
}

// ---------- 定位当前会话的转录文件 ----------
function findTranscript() {
  if (process.env.BRIDGE_TRANSCRIPT) return process.env.BRIDGE_TRANSCRIPT;

  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const cwd = process.cwd();
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(os.homedir(), '.claude', 'projects', slug);

  if (sid) {
    const exact = path.join(projDir, sid + '.jsonl');
    if (fs.existsSync(exact)) return exact;
  }
  // 兜底：该目录下最新的 .jsonl
  if (fs.existsSync(projDir)) {
    const files = fs.readdirSync(projDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, t: fs.statSync(path.join(projDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files.length) return path.join(projDir, files[0].f);
  }
  return null;
}

const TRANSCRIPT = findTranscript();

// ---------- 转录 -> 手机可读的事件 ----------
function brief(v, n = 160) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + ' …' : s;
}

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return name;
  const hint = input.file_path || input.path || input.command || input.pattern
             || input.url || input.query || input.description || '';
  return hint ? `${name} · ${brief(hint, 90)}` : name;
}

// ---------- 噪音过滤：系统注入的活儿不该占他屏幕 ----------
// cron 原文、命令回显、任务通知——这些是机器之间的暗号，推到手机上只是刷屏。
const NOISE_PREFIXES = [
  '每30分钟主动聊天任务',
  '每天 12:00 信箱检查',
  '每天 12:10 信箱复核',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<task-notification>',
];
function isNoise(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return NOISE_PREFIXES.some(p => t.startsWith(p));
}

// 手机来信被系统包了一层壳：
//   "Another Claude session sent a message:\n📱真正的话\n\nThis came from another Claude session — …"
// 这层壳只在会话里有用（提醒assistant那是桥送来的），对上他手机没有意义，剥掉。
function unwrapPhone(t) {
  const s = String(t || '');
  if (!/^Another Claude session sent a message:/.test(s)) return s;   // 只有带壳的才动
  return s
    .replace(/^Another Claude session sent a message:\s*\n?/, '')
    .replace(/\n*This came from another Claude session[\s\S]*$/, '')
    .trim();
}

function renderEntry(o) {
  const out = [];
  const ts = o.timestamp || null;

  if (o.type === 'user') {
    const c = o.message && o.message.content;
    const isResult = !!o.toolUseResult
      || (Array.isArray(c) && c.some(b => b && b.type === 'tool_result'));
    if (isResult) {
      const txt = typeof c === 'string' ? c
        : (Array.isArray(c) ? c.filter(b => b.type === 'tool_result')
            .map(b => typeof b.content === 'string' ? b.content
              : (Array.isArray(b.content) ? b.content.map(x => x.text || '').join('') : ''))
            .join('\n') : '');
      const body = mask(brief(txt, 300));
      if (body.trim()) out.push({ kind: 'result', text: body, ts });
      return out;
    }
    const txt = unwrapPhone(
      typeof c === 'string' ? c
        : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '')
    );

    // 手机自己发来的图 / 文件：渲染成他自己的气泡，而不是一坨带路径的文字
    // （2026-10-11 他自己提的："太占地方""不是直接加到对话里面"）
    const pm = /^📱\[(图片|文件)\][ \t]?([^\n]*)\n(.+)$/.exec(txt.trim());
    if (pm) {
      const base = path.basename(pm[3].trim());
      let size = 0;
      try { size = fs.statSync(path.join(INBOX, base)).size; } catch {}
      out.push({
        kind: pm[1] === '图片' ? 'user-image' : 'user-file',
        url: '/inbox?f=' + encodeURIComponent(base),
        name: base.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, ''),   // 洗掉时间戳前缀
        note: pm[2].trim(),
        size: size || null,
        ts,
      });
      return out;
    }

    if (!isNoise(txt)) out.push({ kind: 'user', text: mask(txt), ts });
    return out;
  }

  if (o.type === 'assistant') {
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) {
      if (typeof c === 'string' && c.trim()) out.push({ kind: 'assistant', text: mask(c), ts });
      return out;
    }
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        out.push(...splitMedia(b.text, ts, 'assistant'));
      } else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
        out.push({ kind: 'thinking', text: mask(b.thinking), ts });
      } else if (b.type === 'tool_use') {
        out.push({ kind: 'tool', text: mask(toolSummary(b.name, b.input)), ts });
      }
    }
    return out;
  }

  return out;
}

// ---------- 转录尾巴：跟踪文件增长，推新事件 ----------
let offset = 0;
let carry = '';
const decoder = new StringDecoder('utf8');   // 汉字跨块时不会劈坏
const clients = new Set();

function emit(ev) {
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function feed(chunk) {
  carry += chunk;
  let idx;
  while ((idx = carry.indexOf('\n')) >= 0) {
    const line = carry.slice(0, idx).trim();
    carry = carry.slice(idx + 1);
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    for (const ev of renderEntry(o)) emit(ev);
  }
}

function readFrom(pos) {
  if (!TRANSCRIPT) return;
  const size = fs.statSync(TRANSCRIPT).size;
  if (size < pos) { offset = 0; carry = ''; }   // 文件被截断/换新
  if (size === offset) return;
  const fd = fs.openSync(TRANSCRIPT, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  feed(decoder.write(buf));          // 用解码器，汉字跨块也不会劈坏
}

function initTailer() {
  if (!TRANSCRIPT) {
    console.error('[phone-bridge] ⚠️ 没找到转录文件，下行通道不可用');
    return;
  }
  console.log('[phone-bridge] 转录文件:', TRANSCRIPT);
  offset = 0; carry = '';
  readFrom(0);                       // 先灌一遍历史
  fs.watch(TRANSCRIPT, () => { try { readFrom(offset); } catch (e) { console.error(e.message); } });
  setInterval(() => { try { readFrom(offset); } catch {} }, 1500);   // 兜底轮询
}

function history(limit = 80) {
  if (!TRANSCRIPT) return [];
  const lines = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean);
  const evs = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    for (const ev of renderEntry(o)) evs.push(ev);
  }
  return evs.slice(-limit);
}

// ---------- 上行：写进 Claude Code 的收信管道 ----------
function inject(text) {
  return new Promise((resolve, reject) => {
    const sockPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    if (!sockPath || !token) {
      return reject(new Error('这台服务没拿到收信管道（必须由会话内的 Bash 启动）'));
    }
    const s = net.connect(sockPath);
    let sent = false;
    s.on('connect', () => {
      // Windows 原生管道：第一行必须是 auth
      s.write(JSON.stringify({ type: 'auth', token }) + '\n');
      s.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `${PHONE_PREFIX}${text}` }
      }) + '\n');
      sent = true;
      setTimeout(() => { try { s.destroy(); } catch {} resolve(); }, 200);
    });
    s.on('error', (e) => { if (!sent) reject(e); else resolve(); });
  });
}

// ---------- HTTP ----------
function authed(req, url) {
  const k = req.headers['x-bridge-key'] || url.searchParams.get('key');
  return k && k === ACCESS_KEY;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readRaw(req, max = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > max) { reject(new Error('内容太大')); return req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req) {
  // 收完字节再整体解码——按块转字符串会在汉字中间劈开
  return (await readRaw(req, 1e6)).toString('utf8');
}

// 防 DNS rebinding：只认 IP / localhost 的 Host
function hostOk(req) {
  const h = (req.headers.host || '').split(':')[0];
  return h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h === '::1';
}

// ---------- 验图闸（2026-10-10 立）----------
// 为什么：一张 88 字节的索引色 PNG 曾让整个会话报废——API 不吃这种图，
// 而 Read 会把不吃的图原样上送，400 一旦写进历史，那个会话以后每一条都 400。
// 所以图片在落地前先体检：API 吃不下的一律不收。
// 返回 {ok:true, kind, w, h} 或 {ok:false, reason}
function inspectImage(buf) {
  const MIN_DIM = 16, MIN_BYTES = 256;
  if (!buf || buf.length < MIN_BYTES) {
    return { ok: false, reason: `只有 ${buf ? buf.length : 0} 字节，不像是张图` };
  }
  // PNG
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= 26 && buf.slice(0, 8).equals(PNG_SIG)) {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const depth = buf[24], ctype = buf[25];
    if (ctype === 3) return { ok: false, reason: '索引色 PNG（调色板），API 不吃' };
    if (depth < 8) return { ok: false, reason: `${depth}-bit PNG，API 不吃` };
    if (w < MIN_DIM || h < MIN_DIM) return { ok: false, reason: `太小了（${w}×${h}）` };
    return { ok: true, kind: 'png', w, h };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const mk = buf[i + 1];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
        const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
        if (w < MIN_DIM || h < MIN_DIM) return { ok: false, reason: `太小了（${w}×${h}）` };
        return { ok: true, kind: 'jpeg', w, h };
      }
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { ok: false, reason: 'JPEG 文件头是坏的' };
  }
  // GIF
  const gif = buf.slice(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
    if (w < MIN_DIM || h < MIN_DIM) return { ok: false, reason: `太小了（${w}×${h}）` };
    return { ok: true, kind: 'gif', w, h };
  }
  // WebP
  if (buf.length >= 30 && buf.slice(0, 4).toString('ascii') === 'RIFF'
      && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    if (buf.slice(12, 16).toString('ascii') === 'VP8X') {
      const w = 1 + buf.readUIntLE(24, 3), h = 1 + buf.readUIntLE(27, 3);
      if (w < MIN_DIM || h < MIN_DIM) return { ok: false, reason: `太小了（${w}×${h}）` };
      return { ok: true, kind: 'webp', w, h };
    }
    return { ok: true, kind: 'webp', w: 0, h: 0 };   // VP8/VP8L：不解析尺寸，放行
  }
  return { ok: false, reason: '认不出的格式（只收 png / jpeg / webp / gif）' };
}

// ---------- 本地配置 ----------
// 桥只能碰这几棵树里的东西，别的哪怕口令是对的也不给。默认全空。
// 复制 bridge.config.example.json 成 bridge.config.json 再改。
const CONFIG_FILE = path.join(DIR, 'bridge.config.json');
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch { /* 没有配置 = 什么都不放行 */ }

const ROOT = path.resolve(DIR, CONFIG.root || '..');
const absOf = (rel) => path.resolve(ROOT, rel);

const MEDIA_DIRS = (CONFIG.media || []).map(absOf);
const FILE_DIRS  = (CONFIG.allow || []).map(absOf);
const FILE_DENY  = (CONFIG.deny  || []).map(absOf);

function insideAny(a, dirs) {
  return dirs.some(d => a === d || a.startsWith(d + path.sep));
}

// ---------- 表情：assistant → 手机 ----------
// 在回复里写 [[img:cat]]，桥把它揪出来换成一张图推给手机。
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
};

// spec 两种写法：
//   "01-gleam"        → 在 media 目录里按名字找（自动补扩展名）
//   "stickers/x.png"  → 相对 root 的路径
// 只认 media 白名单里的图片；路径穿越一律拒。
function resolveMedia(spec) {
  const s = String(spec || '').trim().replace(/\\/g, '/');
  if (!s || s.includes('\0')) return null;

  const tryPath = (p) => {
    const a = path.resolve(p);
    if (!insideAny(a, MEDIA_DIRS)) return null;
    if (!MIME_BY_EXT[path.extname(a).toLowerCase()]) return null;
    try { if (fs.statSync(a).isFile()) return a; } catch { /* 不在就算了 */ }
    return null;
  };

  if (s.includes('/')) return tryPath(path.join(ROOT, s));

  const names = MIME_BY_EXT[path.extname(s).toLowerCase()]
    ? [s]
    : Object.keys(MIME_BY_EXT).map(e => s + e);
  for (const d of MEDIA_DIRS) for (const n of names) {
    const hit = tryPath(path.join(d, n));
    if (hit) return hit;
  }
  return null;
}

// 文件：assistant → 手机（[[file:path]]），手机上一个下载链接。
// 只有 allow 里的子树放行；deny 里的任何情况下都不出网——哪怕口令是对的。
function resolveFile(spec) {
  const s = String(spec || '').trim().replace(/\\/g, '/');
  if (!s || s.includes('\0')) return null;
  const a = path.resolve(ROOT, s);
  if (!insideAny(a, [...FILE_DIRS, ...MEDIA_DIRS])) return null;
  if (insideAny(a, FILE_DENY)) return null;
  try { if (fs.statSync(a).isFile()) return a; } catch { /* 不在就算了 */ }
  return null;
}

// 把一段话按 [[img:…]] / [[file:…]] 切开：文字归文字，图归图，文件归文件
function splitMedia(text, ts, kind = 'assistant') {
  const out = [];
  const re = /\[\[(img|file):([^\]]+)\]\]/g;
  let last = 0, m, hit = false;
  while ((m = re.exec(text))) {
    hit = true;
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ kind, text: mask(before), ts });

    const what = m[1], spec = m[2].trim();
    if (what === 'img') {
      const abs = resolveMedia(spec);
      if (abs) {
        const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
        out.push({ kind: 'image', url: '/media?p=' + encodeURIComponent(rel), alt: spec, ts });
      } else {
        out.push({ kind, text: '（表情没找到：' + spec + '）', ts });
      }
    } else {
      const abs = resolveFile(spec);
      if (abs) {
        const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
        out.push({
          kind: 'file',
          url: '/file?p=' + encodeURIComponent(rel),
          name: path.basename(abs),
          size: fs.statSync(abs).size,
          ts,
        });
      } else {
        out.push({ kind, text: '（文件没找到：' + spec + '）', ts });
      }
    }
    last = m.index + m[0].length;
  }
  if (!hit) return [{ kind, text: mask(text), ts }];
  const tail = text.slice(last).trim();
  if (tail) out.push({ kind, text: mask(tail), ts });
  return out;
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!hostOk(req)) return send(res, 403, '{"error":"bad host"}');

  // 页面 + 静态资源（不需要口令，页面里再问）
  if (req.method === 'GET' && (url.pathname === '/' || STATIC_FILES[url.pathname])) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const p = path.join(PUBLIC, rel);
    if (!fs.existsSync(p)) return send(res, 404, '页面还没写好');
    return send(res, 200, fs.readFileSync(p),
                STATIC_FILES[url.pathname] || 'text/html; charset=utf-8');
  }

  // CA 证书下载：手机要装它才认得出这个 https。
  // 免口令——它本来就是要发出去的公开信息（私钥在 certs/ca.key，那个永远不出门）。
  if (req.method === 'GET' && url.pathname === '/ca.crt') {
    const p = path.join(DIR, 'certs', 'ca.crt');
    if (!fs.existsSync(p)) return send(res, 404, '证书还没生成');
    return send(res, 200, fs.readFileSync(p), 'application/x-x509-ca-cert');
  }

  if (url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({
      ok: true,
      masked: MASK,
      transcript: TRANSCRIPT ? path.basename(TRANSCRIPT) : null,
      uplink: !!process.env.CLAUDE_CODE_MESSAGING_SOCKET,
    }));
  }

  // 验口令
  if (url.pathname === '/api/auth') {
    return authed(req, url) ? send(res, 200, '{"ok":true}') : send(res, 401, '{"error":"口令不对"}');
  }

  if (!authed(req, url)) return send(res, 401, '{"error":"unauthorized"}');

  // 表情 / 图片（assistant → 手机）
  if (req.method === 'GET' && url.pathname === '/media') {
    const abs = resolveMedia(url.searchParams.get('p') || '');
    if (!abs) return send(res, 404, '{"error":"没有这张图"}');
    res.writeHead(200, {
      'Content-Type': MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'private, max-age=600',
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // 文件（assistant → 手机）：点一下是下载
  if (req.method === 'GET' && url.pathname === '/file') {
    const abs = resolveFile(url.searchParams.get('p') || '');
    if (!abs) return send(res, 404, '{"error":"没有这个文件"}');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(abs)),
      'Content-Length': fs.statSync(abs).size,
      'Cache-Control': 'private, max-age=600',
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // 手机发来的图 / 文件：从inbox取回来（要口令），好让它们出现在自己的对话里
  if (req.method === 'GET' && url.pathname === '/inbox') {
    const base = path.basename(url.searchParams.get('f') || '');
    if (!base || base.startsWith('.')) return send(res, 404, '{"error":"没有这个"}');
    const abs = path.join(INBOX, base);
    if (!abs.startsWith(INBOX) || !fs.existsSync(abs)) return send(res, 404, '{"error":"没有这个"}');
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': /\.(png|jpe?g|gif|webp|avif)$/.test(ext)
        ? (MIME_BY_EXT[ext] || 'image/jpeg')
        : 'application/octet-stream',
      'Content-Length': fs.statSync(abs).size,
      'Cache-Control': 'private, max-age=600',
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // 历史
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const n = Number(url.searchParams.get('limit') || 80);
    return send(res, 200, JSON.stringify(history(Math.min(n, 300))));
  }

  // 实时流
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // 上行：手机发消息
  if (req.method === 'POST' && url.pathname === '/api/send') {
    const raw = await readBody(req);
    let text = '';
    try { text = (JSON.parse(raw).text || '').trim(); } catch { text = raw.trim(); }
    if (!text) return send(res, 400, '{"error":"空消息"}');
    try {
      await inject(text);
      console.log('[手机来信]', text.slice(0, 80));
      return send(res, 200, '{"ok":true}');
    } catch (e) {
      console.error('[上行失败]', e.message);
      return send(res, 500, JSON.stringify({ error: e.message }));
    }
  }

  // 上行：手机发图片 / 文件
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    let payload;
    try {
      payload = JSON.parse((await readRaw(req)).toString('utf8'));
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: '解析失败：' + e.message }));
    }

    const { name = 'file', caption = '', dataUrl = '' } = payload;
    const m = /^data:([^;]*);base64,([\s\S]*)$/.exec(dataUrl);
    if (!m) return send(res, 400, '{"error":"格式不对"}');

    const mime = m[1] || 'application/octet-stream';
    const buf = Buffer.from(m[2], 'base64');
    const isImg = mime.startsWith('image/');

    // 图片先过验图闸：API 吃不下的，不落地、不进会话
    let dim = null;
    if (isImg) {
      const v = inspectImage(buf);
      if (!v.ok) {
        console.log('[验图闸·拒收]', name, '—', v.reason);
        return send(res, 415, JSON.stringify({ error: '这张图我没收：' + v.reason }));
      }
      dim = v;
    }

    // 文件名：时间戳 + 原名（洗掉路径危险字符）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'file';
    const filename = `${stamp}_${safe}`;
    const full = path.join(INBOX, filename);

    try {
      fs.writeFileSync(full, buf);
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: '存盘失败：' + e.message }));
    }

    // 尺寸写进信里：会话里的assistant先看见"这张多大"，再决定 Read 不 Read
    const sizeKB = Math.max(1, Math.round(buf.length / 1024));
    const info = (dim && dim.w) ? ` ${dim.w}×${dim.h} · ${sizeKB}KB` : ` ${sizeKB}KB`;
    // 前后缀由 inject() 统一加 📱，这里别再重复
    const head = `[${isImg ? '图片' : '文件'}]${caption ? ' ' + caption : ''}${info}`;
    try {
      await inject(`${head}\n${full}`);
      console.log('[手机来信]', head, '→', filename);
      return send(res, 200, JSON.stringify({ ok: true, path: full, size: buf.length, dim }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: e.message }));
    }
  }

  send(res, 404, '{"error":"not found"}');
};

// 有证书就走 HTTPS —— 同一个 WiFi 上再没人能嗅到口令和图片
const TLS_KEY  = path.join(DIR, 'certs', 'server.key');
const TLS_CERT = path.join(DIR, 'certs', 'server.crt');
const useTLS = process.env.BRIDGE_TLS !== '0'
  && fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT);
const scheme = useTLS ? 'https' : 'http';

const server = useTLS
  ? https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, handler)
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  initTailer();
  console.log('[phone-bridge] 已启动  ' + scheme + '://<本机IP>:' + PORT);
  console.log('[phone-bridge] 口令: ' + ACCESS_KEY);
  console.log('[phone-bridge] 加密: ' + (useTLS ? '开（自签证书）' : '关 —— 同一 WiFi 上可被嗅探'));
  console.log('[phone-bridge] 脱敏: ' + (MASK ? '开' : '关'));
});
