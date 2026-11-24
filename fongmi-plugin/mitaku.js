// mitaku.net —— FongMi / TVBox QuickJS 源
//
// 取流链路（逆向自 Mitaku.kt，已实测打通）：
//   帖子页 iframe /e/<slug>  →  https://n1mwq.org/api/videos/<slug>/embed/
//     1) POST captcha        → pow_nonce / pow_difficulty / pow_token
//     2) 本地解 PoW（站点自研哈希）
//     3) POST captcha/verify → token
//     4) POST playback（带 x-captcha-token，body {"fingerprint":{}}）
//        → AES-256-GCM 加密的 payload + key_parts + version
//   密钥 = b64url(key_parts[v-1]) + b64url(key_parts[31-v-1])

import { Spider, openWeb } from "catvod";

const SITE = "https://mitaku.net";
const API = "https://n1mwq.org";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// 图集画廊页（App 内 WebView 打开）
const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

// [tid, 路径, 名称]
const OLD_CATS = [
  ["video", "/category/online-video/", "视频"],
  ["cos", "/category/ero-cosplay/", "Cosplay"],
  ["nude", "/category/nude/", "Nude"],
  ["sexy", "/category/sexy-set/", "Sexy Set"],
];

/* ================= 1. PoW 哈希（站点自研，移植自 Mitaku.kt） ================= */

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function powHash(bytes, R) {
  let a = 1779033703, b = 3144134277 | 0, c = 1013904242, d = 2773480762 | 0;
  const n = bytes.length;

  for (let i = 0; i < n; i++) {
    a = (a + bytes[i]) >>> 0;
    a = rotl(a, 7);
    a = (a + b) >>> 0; d = rotl(d ^ a, 16);
    c = (c + d) >>> 0; b = rotl(b ^ c, 12);
    a = (a + b) >>> 0; d = rotl(d ^ a, 8);
    c = (c + d) >>> 0; b = rotl(b ^ c, 7);
  }
  for (let k = 0; k < 8; k++) {
    a = (a + b) >>> 0; d = rotl(d ^ a, 16);
    c = (c + d) >>> 0; b = rotl(b ^ c, 12);
    a = (a + b) >>> 0; d = rotl(d ^ a, 8);
    c = (c + d) >>> 0; b = rotl(b ^ c, 7);
  }

  for (let i = 0; i < 512; i++) {
    a = (a + b) >>> 0; d = rotl(d ^ a, 16);
    c = (c + d) >>> 0; b = rotl(b ^ c, 12);
    a = (a + b) >>> 0; d = rotl(d ^ a, 8);
    c = (c + d) >>> 0; b = rotl(b ^ c, 7);
    R[i] = (a ^ c) >>> 0;
  }

  const lr = 2654435761 | 0, hr = 2246822519 | 0;

  for (let r = 0; r < 2; r++) {
    for (let s = 0; s < 512; s++) {
      const av = R[s] & 511;
      let cc = (R[s] + R[av]) >>> 0;
      cc = rotl(cc, 13);
      cc = (cc ^ Math.imul(R[(s + 1) & 511], lr)) >>> 0;
      R[s] = cc;
      a = (a ^ cc) >>> 0;
      a = (a + b) >>> 0; d = rotl(d ^ a, 16);
      c = (c + d) >>> 0; b = rotl(b ^ c, 12);
      a = (a + b) >>> 0; d = rotl(d ^ a, 8);
      c = (c + d) >>> 0; b = rotl(b ^ c, 7);
    }
  }

  const out = new Array(8);
  for (let i = 0; i < 8; i++) {
    a = (a + b) >>> 0; d = rotl(d ^ a, 16);
    c = (c + d) >>> 0; b = rotl(b ^ c, 12);
    a = (a + b) >>> 0; d = rotl(d ^ a, 8);
    c = (c + d) >>> 0; b = rotl(b ^ c, 7);
    let s = a;
    const base = i * 64;
    for (let k = 0; k < 64; k++) {
      const dd = R[base + k];
      s = (s + dd) >>> 0;
      s = rotl(s, 5);
      s = (s ^ Math.imul(dd, hr)) >>> 0;
    }
    out[i] = (s ^ c) >>> 0;
  }
  return out;
}

function leadingZeroBits(words) {
  let bits = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 0) {
      bits += 32;
      continue;
    }
    return bits + Math.clz32(w);
  }
  return bits;
}

function solvePow(nonce, difficulty) {
  const R = new Uint32Array(512);
  const prefix = nonce + ":";
  for (let s = 0; s < 5000000; s++) {
    const str = prefix + s;
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    if (leadingZeroBits(powHash(bytes, R)) >= difficulty) return String(s);
  }
  return null;
}

/* ================= 2. AES-256-GCM 解密（纯 JS） ================= */

const SBOX = new Uint8Array([
0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]);

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d];

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
function gfMul(a, b) { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r & 0xff; }

function expandKey(key) {
  const Nk = 8, Nr = 14, total = 4 * (Nr + 1);
  const w = new Uint8Array(total * 4);
  w.set(key);
  for (let i = Nk; i < total; i++) {
    const o = i * 4;
    let t0 = w[o - 4], t1 = w[o - 3], t2 = w[o - 2], t3 = w[o - 1];
    if (i % Nk === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ RCON[i / Nk - 1];
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
    } else if (i % Nk === 4) {
      t0 = SBOX[t0];
      t1 = SBOX[t1];
      t2 = SBOX[t2];
      t3 = SBOX[t3];
    }
    w[o] = w[o - 32] ^ t0;
    w[o + 1] = w[o - 31] ^ t1;
    w[o + 2] = w[o - 30] ^ t2;
    w[o + 3] = w[o - 29] ^ t3;
  }
  return w;
}

function encBlock(w, inp) {
  const Nr = 14;
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i] ^ w[i];
  const t = new Uint8Array(16);
  for (let round = 1; round <= Nr; round++) {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) t[r + 4 * c] = SBOX[s[r + 4 * ((c + r) & 3)]];
    }
    s.set(t);
    if (round !== Nr) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
        s[4 * c] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
        s[4 * c + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
      }
    }
    const ro = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= w[ro + i];
  }
  return s;
}

function ghashMul(x, y) {
  const z = new Uint8Array(16);
  const v = new Uint8Array(y);
  for (let i = 0; i < 128; i++) {
    if ((x[i >> 3] >> (7 - (i & 7))) & 1) {
      for (let j = 0; j < 16; j++) z[j] ^= v[j];
    }
    const lsb = v[15] & 1;
    for (let j = 15; j > 0; j--) v[j] = ((v[j] >> 1) | ((v[j - 1] & 1) << 7)) & 0xff;
    v[0] >>= 1;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

function ghash(h, data) {
  let y = new Uint8Array(16);
  for (let i = 0; i < data.length; i += 16) {
    const blk = new Uint8Array(16);
    for (let j = 0; j < 16 && i + j < data.length; j++) blk[j] = data[i + j];
    for (let j = 0; j < 16; j++) y[j] ^= blk[j];
    y = ghashMul(y, h);
  }
  return y;
}

function u32be(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function aesGcmDecrypt(key, iv, ct, tag) {
  const w = expandKey(key);
  const H = encBlock(w, new Uint8Array(16));
  const J0 = new Uint8Array(16);
  J0.set(iv);
  J0[15] = 1;

  const out = new Uint8Array(ct.length);
  const ctr = new Uint8Array(J0);
  for (let pos = 0; pos < ct.length; pos += 16) {
    for (let i = 15; i >= 12; i--) {
      ctr[i] = (ctr[i] + 1) & 0xff;
      if (ctr[i] !== 0) break;
    }
    const ks = encBlock(w, ctr);
    const n = Math.min(16, ct.length - pos);
    for (let i = 0; i < n; i++) out[pos + i] = ct[pos + i] ^ ks[i];
  }

  const pad = (16 - (ct.length % 16)) % 16;
  const lenBlock = new Uint8Array(16);
  const bits = ct.length * 8;
  lenBlock.set(u32be(Math.floor(bits / 4294967296)), 8);
  lenBlock.set(u32be(bits >>> 0), 12);
  const buf = new Uint8Array(ct.length + pad + 16);
  buf.set(ct, 0);
  buf.set(lenBlock, ct.length + pad);

  const S = ghash(H, buf);
  const EK = encBlock(w, J0);
  let ok = true;
  for (let i = 0; i < 16; i++) {
    if (((S[i] ^ EK[i]) & 0xff) !== tag[i]) ok = false;
  }

  let str = "";
  for (let i = 0; i < out.length; i++) str += String.fromCharCode(out[i]);
  return { text: str, ok: ok };
}

/* ================= 3. 工具 ================= */

function b64url(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "=") break;
    const v = chars.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function decode(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8211;/g, "-")
    .replace(/&nbsp;/g, " ");
}

function strip(s) {
  return decode((s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// 封面地址可能含中文（WordPress 文件名），必须编码，否则图片加载器会失败
// 这里手写 UTF-8 百分号编码，不依赖 encodeURI（QuickJS 里行为不确定）
function safeUrl(u) {
  if (!u) return "";
  const s = String(u).trim();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 128) {
      out += s.charAt(i);
      continue;
    }
    let cp = code;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    let bytes;
    if (cp < 0x800) {
      bytes = [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
    } else if (cp < 0x10000) {
      bytes = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    } else {
      bytes = [
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      ];
    }
    for (let k = 0; k < bytes.length; k++) {
      const h = bytes[k].toString(16).toUpperCase();
      out += "%" + (h.length < 2 ? "0" + h : h);
    }
  }
  return out;
}

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": ref || SITE + "/",
  };
}

// App 的图片加载器访问 mitaku.net 的 uploads 会被 Cloudflare 拦（浏览器能开，App 拿不到）
// 统一走公共图片代理 weserv，由它的服务器去取图
function coverUrl(u) {
  if (!u) return "";
  const s = String(u).replace(/^https?:\/\//, "");
  return "https://images.weserv.nl/?url=" + s + "&w=480&output=jpg";
}

// 列表页：<h2 class="entry-title"><a href title>标题</a>，缩略图在标题前面
function parsePosts(html) {
  const out = [];
  const seen = {};
  const re = /class="entry-title"[^>]*>\s*<a[^>]*href="(https:\/\/mitaku\.net\/[^"]+)"[^>]*title="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (seen[url]) continue;
    seen[url] = 1;

    let title = decode(m[2]).trim();
    const tn = title.match(/^(.*?)\s+\d+$/); // 去掉尾部编号
    if (tn && tn[1]) title = tn[1];

    // 缩略图：从标题往前找最近的 <img src>
    let pic = "";
    const before = html.substring(Math.max(0, m.index - 1600), m.index);
    const imgs = before.match(/<img[^>]*src="([^"]+)"/g);
    if (imgs && imgs.length) {
      const last = imgs[imgs.length - 1].match(/src="([^"]+)"/);
      if (last) pic = decode(last[1]);
    }

    if (!title) continue;
    out.push({ url: url, title: title, pic: coverUrl(safeUrl(pic)) });
  }
  return out;
}

// 图集：carousel 插件（meta-slider-and-carousel-with-lightbox-pro）
//   <div class="msacwl-slide" data-item-index="1">
//     <a class="msacwl-img-link" data-mfp-src="原图"></a>
//     <img class="msacwl-img" data-lazy="原图" src="…/spacer.gif">
//   ⚠ 页面里没有正常的 <img src>，只在 data-mfp-src / data-lazy 里
function parseGallery(html) {
  const out = [];
  const seen = {};
  const re = /class="msacwl-slide"[\s\S]{0,900}?(?:data-mfp-src|data-lazy)="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const u = m[1];
    if (!u || seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

// 转义：只处理会破坏 URL 参数/片段的字符
function esc(s) {
  return String(s)
    .replace(/%/g, "%25")
    .replace(/&/g, "%26")
    .replace(/#/g, "%23")
    .replace(/\+/g, "%2B")
    .replace(/ /g, "%20");
}

// ============================================================
// 站点结构（2026-11-24 侦查）
//   分类：/category/ero-cosplay|sexy-set|online-video|nude/   每页 9 帖
//   首页：/            → 最新
//   分页：/page/N/     （有 pagination 链接）
//   搜索：/?s=关键词    （标题带 "Page x of y"）
//   详情：article#post-N → h2.entry-title a[href]
//        封面 .featured-image img[src]
//        图集 .msacwl-slide [data-lazy]（原图，走 images.weserv.nl 缩略）
//        视频 iframe src="https://n1mwq.org/e/<slug>"
//   播放：captcha(PoW 12bit) → verify(token) → playback {fingerprint:{}} →
//        AES-256-GCM 密文（key_parts 拆两段拼 32B key）→ 解密得 sources[].url(m3u8)
//   相关：详情页侧栏 Trending Posts（aside#wtpsw-post-list-widget-N）
//   标签：站点无索引页，从分类页侧栏 /tag/<slug>/ 汇总 → 搜索面板
// ============================================================

const CATS = [
  { tid: "latest", name: "最新", path: "" },
  { tid: "ero-cosplay", name: "Ero Cosplay", path: "/category/ero-cosplay/" },
  { tid: "sexy-set", name: "Sexy Set", path: "/category/sexy-set/" },
  { tid: "online-video", name: "Online Video", path: "/category/online-video/" },
  { tid: "nude", name: "Nude", path: "/category/nude/" },
];

const PAGE_SIZE = 9;

/** 列表路径（p>1 用 /page/N/） */
function listPath(cat, p) {
  const base = cat.path || "/";
  if (p <= 1) return SITE + base;
  return SITE + base + "page/" + p + "/";
}

/** 从一段 HTML 里抓卡片（article 块，含分类/标签/标题/封面） */
function parseCards(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const marks = [];
  const reArt = /<article id="post-\d+"[^>]*>/g;
  let m;
  while ((m = reArt.exec(text)) !== null) marks.push(m.index);
  for (let i = 0; i < marks.length; i++) {
    const seg = text.substring(marks[i], i + 1 < marks.length ? marks[i + 1] : marks[i] + 6000);
    const link = seg.match(/<h2 class="entry-title">\s*<a href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;
    const img = seg.match(/class="featured-image"[\s\S]{0,600}?<img[^>]*src="([^"]+)"/);
    out.push({
      url: url,
      title: strip(link[2]),
      pic: img ? coverUrl(safeUrl(img[1])) : "",
    });
  }
  return out;
}

/** 详情页：图集张数 + 是否有视频 */
function probePost(html) {
  const n = parseGallery(html).length;
  const hasVideo = /<iframe[^>]*src="[^"]*\/e\//.test(String(html || ""));
  return { n: n, hasVideo: hasVideo };
}

/** 角标：34P / 1V / 16P·1V（站点不给时长） */
function badgeOf(n, hasVideo) {
  if (n > 0 && hasVideo) return n + "P·1V";
  if (n > 0) return n + "P";
  if (hasVideo) return "1V";
  return "";
}

/** 详情页侧栏 Trending Posts → 相关推荐卡片 */
function parseTrending(html) {
  const text = String(html || "");
  const i = text.indexOf("wtpsw-post-li");
  const seg = i >= 0 ? text.substring(Math.max(0, i - 400)) : text;
  const out = [];
  const seen = {};
  const re = /<a href="(https:\/\/mitaku\.net\/[^"]+)"[^>]*>[\s\S]{0,400}?<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    const url = m[1];
    if (seen[url]) continue;
    if (!/\/(ero-cosplay|sexy-set|online-video|nude)\//.test(url)) continue;
    seen[url] = 1;
    out.push({ url: url, title: decode(m[3]).replace(/\s*Cover\s*$/i, "").trim(), pic: coverUrl(safeUrl(decode(m[2]))) });
    if (out.length >= 8) break;
  }
  return out;
}

/** slug → 可读名：先 URL 解码（中文标签的 slug 是 %E9%98%BF…），再把连字符转空格 */
function pretty(slug) {
  let s = String(slug || "");
  try { s = decodeURIComponent(s); } catch (e) { s = s.replace(/%[0-9A-Fa-f]{2}/g, ""); }
  s = s.replace(/-/g, " ").trim();
  // 只给英文单词首字母大写；中文不受影响
  return s.replace(/(^|[\s(])([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
}


/** 名字首字母（A-Z；非字母归到 #） */
function headLetter(name) {
  const s = String(name || "").trim();
  if (!s) return "#";
  const c = s.charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

export default class Mitaku extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.tagCache = null;
    this.log("mitaku ready");
  }

  cacheGet(url) {
    const c = this.htmlCache && this.htmlCache[url];
    return c && Date.now() - c.ts < 180000 ? c.html : "";
  }

  cacheSet(url, html) {
    this.htmlCache = this.htmlCache || {};
    this.htmlCache[url] = { html: html, ts: Date.now() };
  }

  async getHtml(url, referer) {
    const hit = this.cacheGet(url);
    if (hit) return hit;
    try {
      const r = await this.net.req(url, { headers: headers(referer) });
      if (r && r.code === 200) {
        this.cacheSet(url, r.content);
        return r.content;
      }
    } catch (e) { }
    return "";
  }

  async homeContent() {
    const classes = [];
    for (const c of CATS) classes.push({ type_id: c.tid, type_name: c.name });
    classes.push({ type_id: "tagsearch", type_name: "标签" });
    classes.push({ type_id: "authorsearch", type_name: "作者" });
    classes.push({ type_id: "web", type_name: "网页" });

    // 排序走 ⇅ 面板（WordPress: ?orderby=）
    const sortGroup = {
      key: "order",
      name: "排序",
      value: [
        { n: "最新", v: "" },
        { n: "最早", v: "asc" },
      ],
    };
    const filters = {};
    for (const c of CATS) filters[c.tid] = [sortGroup];
    return { class: classes, filters: filters };
  }

  /** 列表：分类/最新 + 排序 + 分页 */
  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const ext = extend || {};
    // 详情页的标签/作者 chips 点进来时，App 会把 "tag:<slug>" / "author:<x>" 直接当 tid 传
    let t0 = String(tid || "");
    if (t0.indexOf("tag:") === 0) {
      ext.sub = t0;
      t0 = "tagsearch";
    } else if (t0.indexOf("author:") === 0) {
      ext.sub = t0;
      t0 = "authorsearch";
    }
    tid = t0;
    const sub = String(ext.sub || "");

    // 标签面板选中 → 走站点的标签页 /tag/<slug>/（分页同分类页）
    if (tid === "tagsearch") {
      if (sub.indexOf("tag:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个标签", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      const slug = sub.substring(4);
      const tagUrl = SITE + "/tag/" + slug + "/" + (p > 1 ? "page/" + p + "/" : "");
      return this.listFromUrl(tagUrl, p);
    }

    // 作者面板选中 → 用站内搜索按作者名找，再按标题前缀过滤
    if (tid === "authorsearch") {
      if (sub.indexOf("author:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个作者", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      const name = sub.substring(7);
      return this.searchList(name, p, name);
    }

    const cat = CATS.find((c) => c.tid === tid) || CATS[0];
    let url = listPath(cat, p);
    if (String(ext.order || "") === "asc") url += (url.indexOf("?") >= 0 ? "&" : "?") + "orderby=date&order=asc";
    return this.listFromUrl(url, p);
  }

  /** 通用列表：抓页面 → 解析卡片 → 并发探详情算角标 → 判有没有下一页 */
  async listFromUrl(url, p) {
    const html = await this.getHtml(url);
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const raw = parseCards(html);
    const cards = await Promise.all(raw.map(async (c) => {
      const d = await this.getHtml(c.url, url);
      const info = probePost(d);
      return {
        vod_id: c.url,
        vod_name: c.title,
        vod_pic: c.pic,
        vod_remarks: badgeOf(info.n, info.hasVideo),
      };
    }));

    const more = /class="pagination"/.test(html) || html.indexOf("page/" + (p + 1) + "/") >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards.filter((c) => c.vod_name), p, PAGE_SIZE, total);
  }

  /** 详情：图集 + 视频都算上 */
  async detailContent(ids) {
    const url = String(ids[0] || "");
    const html = await this.getHtml(url);
    if (!html) return { list: [] };

    const info = probePost(html);
    const imgs = parseGallery(html);

    let title = "";
    const t = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/) ||
      html.match(/<h2 class="entry-title">\s*<a[^>]*>([\s\S]{0,200}?)<\/a>/);
    if (t) title = strip(t[1]);
    if (!title) {
      const og = html.match(/property="og:title"[^>]*content="([^"]*)"/);
      title = og ? strip(og[1]) : url;
    }

    const cover = html.match(/class="featured-image"[\s\S]{0,600}?<img[^>]*src="([^"]+)"/);

    // 文本区：分类 + 标签做成可点 chips（每行一组）
    const lines = [];
    const cats = listUnique(html, /href="https:\/\/mitaku\.net\/category\/([^"\/]+)\/"[^>]*>([^<]{1,30})</g);
    if (cats.length) {
      lines.push(cats.slice(0, 3).map((x) => '[a=cr:{"id":"' + x.slug + '"}/]' + x.name + "[/a]").join(" · "));
    }
    const tags = listUnique(html, /href="https:\/\/mitaku\.net\/tag\/([^"\/]+)\/"[^>]*>([^<]{1,30})</g);
    if (tags.length) {
      lines.push(tags.slice(0, 6).map((x) => '[a=cr:{"id":"tag:' + x.slug + '"}/]' + x.name + "[/a]").join(" · "));
    }
    if (imgs.length) lines.push("图集：" + imgs.length + " 张");
    if (info.hasVideo) lines.push("含视频：点下方「播放」");

    const item = {
      vod_id: url,
      vod_name: title,
      vod_pic: cover ? coverUrl(safeUrl(cover[1])) : "",
      vod_content: lines.join("\n"),
      vod_remarks: badgeOf(imgs.length, info.hasVideo),
      gallery: imgs.length > 0,
    };

    if (info.hasVideo) {
      item.vod_play_from = "Mitaku";
      // 站点返回的 480p/720p/1080p 其实是**同一个自适应 master.m3u8**（实测 URL 完全相同），
      // 所以不做画质切换，交给播放器自适应；取流延迟到点播时（详情页保持秒开）
      item.vod_play_url = "正片$" + url;
    }

    // 相关推荐：站点自带的 Trending Posts
    // 角标（NP / 1V / NP·MV）也要算，否则推荐的卡片不会出现「播放 / 图集」双按钮
    // 同一页面缓存一次结果，避免反复进入时推荐的顺序/内容变来变去
    this.relCache = this.relCache || {};
    const cachedRel = this.relCache[url];
    if (cachedRel && cachedRel.length) return { list: [item].concat(cachedRel) };

    const relRaw = parseTrending(html).filter((x) => x.url !== url);
    const rel = await Promise.all(relRaw.map(async (x) => {
      const rd = await this.getHtml(x.url, url);
      const ri = probePost(rd);
      return {
        vod_id: x.url,
        vod_name: x.title,
        vod_pic: x.pic,
        vod_remarks: badgeOf(ri.n, ri.hasVideo),
      };
    }));

    if (rel.length) this.relCache[url] = rel;
    return { list: [item].concat(rel) };
  }

  /** 图集图片（App 的 gal| 接口） */
  async action(op) {
    if (!op) return [];

    if (op.indexOf("gal|") === 0) {
      const url = op.substring(4);
      const html = await this.getHtml(url);
      const imgs = parseGallery(html);
      let title = "";
      const t = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
      if (t) title = strip(t[1]);
      return {
        list: imgs.map((u, i) => ({ url: u, name: String(i + 1) })),
        tags: [],
        title: title,
      };
    }

    // 标签搜索面板
    if (op.indexOf("facet|tags|") === 0) {
      const rest = op.substring("facet|tags|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      const all = await this.loadTags();
      // "^A" 表示按首字母筛选（App 面板顶部的字母条）
      const letter = kw.indexOf("^") === 0 ? kw.substring(1).toUpperCase() : "";
      const hit = letter
        ? all.filter((x) => headLetter(x.name) === letter)
        : (kw ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0) : all);
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => ({ id: "tag:" + x.slug, name: x.name, count: "" })),
      };
    }

    // 侧边栏：热门标签 / 热门作者（给了 facet 后 App 会隐藏「标签」「作者」tab）
    if (op === "side|") {
      const groups = [];
      // ⚠ 不能调 loadTags()/loadAuthors()：它们会抓 12 个 sitemap + 36 个索引页（实测 184 秒）
      // 侧栏只做「热门预览」，各 1 次请求，剩下的靠「查看全部」进面板搜
      // 侧栏只发 1 个请求（标签 sitemap 第 1 页）；作者走 loadAz 的缓存
      const xmlPre = await this.getHtml(SITE + "/post_tag-sitemap1.xml").catch(() => "");

      try {
        const xml = xmlPre;
        const out = [];
        const seen = {};
        const re = /<loc>https:\/\/mitaku\.net\/tag\/([^<]+)\/<\/loc>/g;
        let m;
        while ((m = re.exec(xml || "")) !== null) {
          const slug = m[1];
          if (seen[slug]) continue;
          seen[slug] = 1;
          out.push({ slug: slug, name: pretty(slug) });
          if (out.length >= 24) break;
        }
        if (out.length) {
          groups.push({
            name: "热门标签",
            facet: "tagsearch",
            items: out.map((x) => ({ name: x.name, count: "", id: "tag:" + x.slug })),
          });
        }
      } catch (e) { }

      try {
        // 热门作者用「只做视频」那页（182KB），全量 1238 那页留给「查看全部」
        const vids = await this.loadAz(true);
        const names = [];
        for (const v of vids) {
          if (names.length >= 24) break;
          names.push(v.name);
        }
        const html = "";
        const seen2 = {};
        const re2 = /<h2 class="entry-title">\s*<a [^>]*title="([^"]{1,120})"/g;
        let m2;
        while ((m2 = re2.exec(html || "")) !== null) {
          const nm = decode(m2[1]).replace(/\s*[-–—]\s+.*$/, "").trim();
          if (!nm || nm.length < 2 || nm.length > 40 || seen2[nm]) continue;
          seen2[nm] = 1;
          names.push(nm);
          if (names.length >= 24) break;
        }
        if (names.length) {
          groups.push({
            name: "热门作者",
            facet: "authorsearch",
            items: names.map((n) => ({ name: n, count: "", id: "author:" + n })),
          });
        }
      } catch (e) { }
      return { groups: groups };
    }

    // 作者搜索面板（App 把 tab id「authorsearch」去掉 search 得到 kind = author，
    // 但早期写法是 authors，两种都认，免得面板空白）
    if (op.indexOf("facet|author|") === 0 || op.indexOf("facet|authors|") === 0) {
      const prefix = op.indexOf("facet|authors|") === 0 ? "facet|authors|" : "facet|author|";
      const rest = op.substring(prefix.length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      // 用 A-Z 索引页（1238 个角色，1 次请求）代替爬 36 个索引页的 loadAuthors()
      let all = await this.loadAz(false);
      if (!all.length) all = await this.loadAuthors();
      // "^A" 表示按首字母筛选（App 面板顶部的字母条）
      const letter = kw.indexOf("^") === 0 ? kw.substring(1).toUpperCase() : "";
      const hit = letter
        ? all.filter((x) => headLetter(x.name) === letter)
        : (kw ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0) : all);
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => ({ id: "author:" + x.name, name: x.name, count: x.count + " 部" })),
      };
    }

    // 标签下的帖子列表（作为 tid 打开）
    if (op.indexOf("tag|") === 0) return [];

    return [];
  }

  /**
   * 标签全量：站点有 sitemap，post_tag-sitemap1..12.xml 共 2265 个标签
   * （比从分类页侧栏刮快 10 倍且完整；sitemap 只有 slug，名字由 slug 还原）
   */
  async loadTags() {
    if (this.tagCache && this.tagCache.length) return this.tagCache;
    const urls = [];
    for (let i = 1; i <= 12; i++) urls.push(SITE + "/post_tag-sitemap" + i + ".xml");
    const pages = await Promise.all(urls.map((u) => this.getHtml(u).catch(() => "")));

    const out = [];
    const seen = {};
    for (const xml of pages) {
      const re = /<loc>https:\/\/mitaku\.net\/tag\/([^<]+)\/<\/loc>/g;
      let m;
      while ((m = re.exec(xml || "")) !== null) {
        const slug = m[1];
        if (seen[slug]) continue;
        seen[slug] = 1;
        out.push({ slug: slug, name: pretty(slug) });
      }
    }
    out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    if (out.length) this.tagCache = out;
    return out;
  }

  /** 作者：站点无作者页，从标题「作者 - 作品」提取（抓 4 个分类页，缓存） */
  /**
   * A-Z 角色索引页（站点的「全量角色」入口）
   *   /a-z-cosplayers/                → 1238 个角色（含图集+视频）
   *   /a-z-cosplayers-only-videos/    → 182 个（只做视频的角色）
   * 页面上就是一堆 <a href="/tag/<slug>/">Name</a>，一次请求拿全，比爬 36 个索引页快得多。
   */
  async loadAz(onlyVideos) {
    this.azCache = this.azCache || {};
    const key = onlyVideos ? "v" : "all";
    if (this.azCache[key] && this.azCache[key].length) return this.azCache[key];

    const url = SITE + (onlyVideos ? "/a-z-cosplayers-only-videos/" : "/a-z-cosplayers/");
    const html = await this.getHtml(url);
    const out = [];
    const seen = {};
    const re = /<a[^>]+href="https:\/\/mitaku\.net\/tag\/([^"\/]+)\/"[^>]*>([\s\S]{0,120}?)<\/a>/g;
    let m;
    while ((m = re.exec(html || "")) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      const nm = pretty(slug);
      if (!nm) continue;
      out.push({ slug: slug, name: nm });
    }
    out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    if (out.length) this.azCache[key] = out;
    return out;
  }

  async loadAuthors() {
    if (this.authors && this.authors.length) return this.authors;
    const urls = [];
    for (const c of CATS) {
      if (!c.path) continue;
      for (let pg = 1; pg <= 3; pg++) {
        urls.push(SITE + c.path + (pg > 1 ? "page/" + pg + "/" : ""));
      }
    }
    const pages = await Promise.all(urls.map((u) => this.getHtml(u).catch(() => "")));
    const count = {};
    for (const html of pages) {
      const re = /<h2 class="entry-title">\s*<a [^>]*title="([^"]{1,120})"/g;
      let m;
      while ((m = re.exec(html || "")) !== null) {
        const t = decode(m[1]).replace(/\s*[-–—]\s+.*$/, "").trim();
        if (!t || t.length < 2 || t.length > 40) continue;
        count[t] = (count[t] || 0) + 1;
      }
    }
    const out = Object.keys(count)
      .map((k) => ({ name: k, count: count[k] }))
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    if (out.length) this.authors = out;
    return out;
  }

  /** 搜索：WordPress ?s=，分页靠 /page/N/；authorFilter 用于「作者」维度按标题前缀过滤 */
  async searchList(key, p, authorFilter) {
    const url = SITE + (p > 1 ? "/page/" + p + "/" : "/") + "?s=" + encodeURIComponent(key);
    const html = await this.getHtml(url);
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    let raw = parseCards(html);
    if (authorFilter) {
      const want = String(authorFilter).toLowerCase();
      const hit = raw.filter((c) => c.title.toLowerCase().indexOf(want) === 0);
      if (hit.length) raw = hit;
    }

    const cards = await Promise.all(raw.map(async (c) => {
      const d = await this.getHtml(c.url, url);
      const info = probePost(d);
      return { vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: badgeOf(info.n, info.hasVideo) };
    }));

    const m = html.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
    const total = m ? Number(m[2]) * PAGE_SIZE
      : (/class="pagination"/.test(html) ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length);

    return this.page(cards.filter((c) => c.vod_name), p, PAGE_SIZE, total);
  }

  async searchContent(key, quick, pg) {
    return this.searchList(key, Number(pg) || 1, "");
  }

  /** iframe 里的 slug */
  async resolveSlug(pageUrl) {
    const html = await this.getHtml(pageUrl);
    if (!html) return null;
    const m = html.match(/<iframe[^>]*src="[^"]*\/e\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  /** 取流：PoW → verify → playback → AES-GCM → m3u8 */
  async resolveStreams(slug) {
    const embedHeaders = {
      "User-Agent": UA,
      "Accept": "*/*",
      "Content-Type": "application/json",
      "Origin": API,
      "Referer": API + "/75iia/" + slug,
      "X-Embed-Parent": "https://bysesayeveum.com/e/" + slug,
    };

    const capRes = await this.net.req(API + "/api/videos/" + slug + "/embed/captcha", {
      method: "POST", headers: embedHeaders, body: "{}",
    });
    if (!capRes || capRes.code !== 200) throw new Error("captcha 失败");
    let cap;
    try { cap = JSON.parse(capRes.content); } catch (e) { throw new Error("captcha 解析失败"); }

    const solution = solvePow(cap.pow_nonce, Number(cap.pow_difficulty) || 12);
    if (solution === null) throw new Error("PoW 超时");

    const verRes = await this.net.req(API + "/api/videos/" + slug + "/embed/captcha/verify", {
      method: "POST", headers: embedHeaders,
      body: JSON.stringify({ pow_token: cap.pow_token, solution: solution }),
    });
    if (!verRes || verRes.code !== 200) throw new Error("verify 失败");
    let ver;
    try { ver = JSON.parse(verRes.content); } catch (e) { throw new Error("verify 解析失败"); }
    if (ver.status !== "ok" || !ver.token) throw new Error("verify 未通过");

    const pbRes = await this.net.req(API + "/api/videos/" + slug + "/embed/playback", {
      method: "POST",
      headers: Object.assign({}, embedHeaders, { "x-captcha-token": ver.token }),
      body: JSON.stringify({ fingerprint: {} }),
    });
    if (!pbRes || pbRes.code !== 200) throw new Error("playback 失败");
    let pb;
    try { pb = JSON.parse(pbRes.content); } catch (e) { throw new Error("playback 解析失败"); }

    const body = pb.playback || pb;
    const version = Number(body.version);
    const parts = body.key_parts || [];
    const p1 = b64url(parts[version - 1]);
    const p2 = b64url(parts[31 - version - 1]);
    if (!p1 || !p2) throw new Error("key_parts 异常");
    const key = new Uint8Array(p1.length + p2.length);
    key.set(p1, 0);
    key.set(p2, p1.length);
    if (key.length !== 32) throw new Error("key 长度异常");

    const dec = aesGcmDecrypt(key, b64url(body.iv), b64url(body.payload).subarray(0, b64url(body.payload).length - 16), b64url(body.payload).subarray(b64url(body.payload).length - 16));
    if (!dec.ok) this.log("AES-GCM tag 校验失败（仍尝试解析）");

    let data;
    try {
      data = JSON.parse(dec.text.replace(/\\u0026/g, "&").replace(/\\\//g, "/"));
    } catch (e) { throw new Error("解密内容解析失败"); }

    const list = [];
    const seen = {};
    for (const s of data.sources || []) {
      const u = s && s.url;
      if (!u || u.indexOf(".m3u8") < 0 || seen[u]) continue;
      seen[u] = 1;
      list.push({ n: String(s.label || (s.height ? s.height + "P" : "线路" + (list.length + 1))), v: u });
    }
    if (!list.length) throw new Error("没有 m3u8 源");
    list.sort((a, b) => (parseInt(b.n) || 0) - (parseInt(a.n) || 0));
    return list;
  }

  async playerContent(flag, id) {
    const raw = String(id);
    const header = { "User-Agent": UA, "Referer": API + "/", "Accept": "*/*" };

    // 详情页已经把 m3u8 解析好（多画质选集）→ 直接用，不再跑一遍 PoW
    if (raw.indexOf(".m3u8") > 0) return { parse: 1, url: raw, header: header };

    const pageUrl = raw.indexOf("http") === 0 ? raw : SITE + raw;
    const slug = await this.resolveSlug(pageUrl);
    if (!slug) throw new Error("该帖没有视频");
    const list = await this.resolveStreams(slug);
    return { parse: 1, url: list[0].v, header: header };
  }
}

/** 抓一组唯一链接（slug + 显示名） */
function listUnique(html, re) {
  const out = [];
  const seen = {};
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(String(html || ""))) !== null) {
    const slug = m[1];
    if (seen[slug]) continue;
    seen[slug] = 1;
    const nm = strip(m[2]);
    if (nm) out.push({ slug: slug, name: nm });
    if (out.length >= 12) break;
  }
  return out;
}
