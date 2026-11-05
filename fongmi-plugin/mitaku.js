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

// [tid, 路径, 名称]
const CATS = [
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
function safeUrl(u) {
  if (!u) return "";
  const s = String(u).trim();
  try {
    return encodeURI(s);
  } catch (e) {
    return s;
  }
}

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": ref || SITE + "/",
  };
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
    out.push({ url: url, title: title, pic: safeUrl(pic) });
  }
  return out;
}

export default class Mitaku extends Spider {
  init(extend) {
    this.epCache = {};
    this.tagCache = null;
    this.log("mitaku ready");
  }

  async homeContent(filter) {
    const classes = [];
    for (const [tid, , name] of CATS) classes.push({ type_id: tid, type_name: name });
    classes.push({ type_id: "web", type_name: "网页" });

    // 标签（从分类页侧栏抓一次）
    if (!this.tagCache) {
      try {
        const r = await this.net.req(SITE + "/category/online-video/", { headers: headers() });
        if (r && r.code === 200) {
          const list = [];
          const seen = {};
          const re = /href="https:\/\/mitaku\.net\/tag\/([^"\/]+)\/"[^>]*>([^<]{1,24})</g;
          let m;
          while ((m = re.exec(r.content)) !== null) {
            const slug = m[1];
            if (seen[slug]) continue;
            seen[slug] = 1;
            const nm = strip(m[2]);
            if (nm) list.push([slug, nm]);
          }
          this.tagCache = list;
        }
      } catch (e) {
        this.log("tags failed: " + e);
      }
    }

    for (const [slug, name] of this.tagCache || []) {
      classes.push({ type_id: "t:" + slug, type_name: "#" + name });
    }

    return { class: classes };
  }

  async categoryContent(tid, pg, filter, extend) {
    if (tid === "web") {
      try {
        openWeb({ url: SITE });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 9, 0);
    }

    const p = Number(pg) || 1;
    let url;

    if (tid.indexOf("t:") === 0) {
      const slug = tid.substring(2);
      url = SITE + "/tag/" + slug + "/" + (p > 1 ? "page/" + p + "/" : "");
    } else {
      let path = CATS[0][1];
      for (const c of CATS) {
        if (c[0] === tid) {
          path = c[1];
          break;
        }
      }
      url = SITE + path + (p > 1 ? "page/" + p + "/" : "");
    }

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 9, 0);

    const posts = parsePosts(r.content);
    if (posts.length === 0) return this.page([], p, 9, (p - 1) * 9);

    // 只保留有视频的帖子：并发检查
    const checks = posts.map((post) =>
      this.net
        .req(post.url, { headers: headers() })
        .then((res) => {
          if (!res || res.code !== 200) return null;
          const has = /<iframe[^>]*src="[^"]*\/e\//.test(res.content);
          if (!has) return null;
          return {
            vod_id: post.url,
            vod_name: post.title,
            vod_pic: post.pic,
            vod_remarks: "",
          };
        })
        .catch(() => null)
    );

    let cards = [];
    try {
      const res = await Promise.all(checks);
      for (const c of res) if (c) cards.push(c);
    } catch (e) {
      this.log("filter failed: " + e);
    }

    if (cards.length === 0) return this.page([], p, 9, (p - 1) * 9);
    return this.page(cards, p, 9, (p + 1) * 9);
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = String(id).indexOf("http") === 0 ? String(id) : SITE + String(id);
      let title = "";
      let pic = "";
      let content = "";
      let hasVideo = false;

      try {
        const r = await this.net.req(pageUrl, { headers: headers() });
        if (r && r.code === 200) {
          const html = r.content;

          const h1 = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]{0,200}?)<\/h1>/) ||
                     html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
          const ogt = html.match(/<meta property="og:title" content="([^"]+)"/);
          title = h1 ? strip(h1[1]) : ogt ? decode(ogt[1]) : "";

          const ogi = html.match(/<meta property="og:image" content="([^"]+)"/);
          if (ogi) pic = safeUrl(decode(ogi[1]));
          else {
            const im = html.match(/class="featured-image"[\s\S]{0,400}?<img[^>]*src="([^"]+)"/);
            if (im) pic = safeUrl(decode(im[1]));
          }

          hasVideo = /<iframe[^>]*src="[^"]*\/e\//.test(html);

          const lines = [];
          const tags = [];
          const reT = /href="https:\/\/mitaku\.net\/tag\/([^"\/]+)\/"[^>]*>([^<]{1,24})</g;
          let m;
          while ((m = reT.exec(html)) !== null) {
            const t = strip(m[2]);
            if (t && tags.indexOf(t) < 0) tags.push(t);
          }
          if (tags.length) lines.push("标签: " + tags.slice(0, 8).join(" / "));

          const cnt = html.match(/(\d+)\s*(?:Pics|Photos|images)/i);
          if (cnt) lines.push("图片: " + cnt[1] + " 张");
          if (hasVideo) lines.push("含视频");

          const ogd = html.match(/<meta property="og:description" content="([^"]+)"/);
          if (ogd) {
            const d = strip(ogd[1]).substring(0, 140);
            if (d) lines.push(d);
          }

          content = lines.filter(Boolean).join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || String(id),
        vod_pic: pic,
        vod_content: content || (hasVideo ? "含视频" : "该帖没有视频"),
        vod_play_from: "mitaku",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  // 解析 iframe 里的 slug
  async resolveSlug(pageUrl) {
    const r = await this.net.req(pageUrl, { headers: headers() });
    if (!r || r.code !== 200) return null;
    const m = r.content.match(/<iframe[^>]*src="[^"]*\/e\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  // 完整取流：PoW → verify → playback → AES-GCM → m3u8
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
      method: "POST",
      headers: embedHeaders,
      body: "{}",
    });
    if (!capRes || capRes.code !== 200) throw new Error("captcha 失败");

    let cap;
    try {
      cap = JSON.parse(capRes.content);
    } catch (e) {
      throw new Error("captcha 解析失败");
    }

    const nonce = cap.pow_nonce;
    const difficulty = Number(cap.pow_difficulty) || 16;
    const powToken = cap.pow_token;
    if (!nonce || !powToken) throw new Error("captcha 字段缺失");

    const t0 = Date.now();
    const solution = solvePow(nonce, difficulty);
    if (solution === null) throw new Error("PoW 超时");
    this.log("PoW 耗时 " + (Date.now() - t0) + "ms, solution=" + solution);

    const verRes = await this.net.req(API + "/api/videos/" + slug + "/embed/captcha/verify", {
      method: "POST",
      headers: embedHeaders,
      body: JSON.stringify({ pow_token: powToken, solution: solution }),
    });
    if (!verRes || verRes.code !== 200) throw new Error("verify 失败");

    let ver;
    try {
      ver = JSON.parse(verRes.content);
    } catch (e) {
      throw new Error("verify 解析失败");
    }
    if (ver.status !== "ok" || !ver.token) throw new Error("verify 未通过");

    const pbRes = await this.net.req(API + "/api/videos/" + slug + "/embed/playback", {
      method: "POST",
      headers: Object.assign({}, embedHeaders, { "x-captcha-token": ver.token }),
      body: JSON.stringify({ fingerprint: {} }),
    });
    if (!pbRes || pbRes.code !== 200) throw new Error("playback 失败");

    let pb;
    try {
      pb = JSON.parse(pbRes.content);
    } catch (e) {
      throw new Error("playback 解析失败");
    }
    const body = pb.playback || pb;

    const version = Number(body.version);
    const parts = body.key_parts || [];
    const i1 = version - 1;
    const i2 = 31 - version - 1;
    if (!parts[i1] || !parts[i2]) throw new Error("key_parts 异常");

    const p1 = b64url(parts[i1]);
    const p2 = b64url(parts[i2]);
    const key = new Uint8Array(p1.length + p2.length);
    key.set(p1, 0);
    key.set(p2, p1.length);
    if (key.length !== 32) throw new Error("key 长度异常");

    const iv = b64url(body.iv);
    const payload = b64url(body.payload);
    const ct = payload.subarray(0, payload.length - 16);
    const tag = payload.subarray(payload.length - 16);

    const dec = aesGcmDecrypt(key, iv, ct, tag);
    if (!dec.ok) this.log("AES-GCM tag 校验失败（仍尝试解析）");

    let data;
    try {
      data = JSON.parse(dec.text.replace(/\\u0026/g, "&").replace(/\\\//g, "/"));
    } catch (e) {
      throw new Error("解密内容解析失败");
    }

    const sources = data.sources || [];
    const urls = [];
    for (const s of sources) {
      if (s && s.url && s.url.indexOf(".m3u8") >= 0 && urls.indexOf(s.url) < 0) urls.push(s.url);
    }
    if (urls.length === 0) throw new Error("没有 m3u8 源");
    return { urls: urls, sources: sources };
  }

  async playerContent(flag, id, vipFlags) {
    const pageUrl = String(id).indexOf("http") === 0 ? String(id) : SITE + String(id);

    const slug = await this.resolveSlug(pageUrl);
    if (!slug) throw new Error("该帖没有视频");

    const res = await this.resolveStreams(slug);
    return {
      parse: 0,
      url: res.urls[0],
      header: {
        "User-Agent": UA,
        "Referer": API + "/",
        "Origin": API,
      },
    };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = SITE + "/?s=" + encodeURIComponent(key) + (p > 1 ? "&paged=" + p : "");

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 9, 0);

    const posts = parsePosts(r.content);
    if (posts.length === 0) return this.page([], p, 9, (p - 1) * 9);

    const cards = [];
    for (const post of posts) {
      cards.push({ vod_id: post.url, vod_name: post.title, vod_pic: post.pic, vod_remarks: "" });
    }
    return this.page(cards, p, 9, (p + 1) * 9);
  }
}
