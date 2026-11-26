// fennen62.buzz（粉嫩影院）—— BiliTV / catvod QuickJS 插件
//
// 侦查结论（2026-11-26）：
//   站型    MacCMS 视频站（index.php/vod/…），**全站 HTML 加密**
//   加密    jsjiami v7 外壳 + CryptoJS AES-128-CBC / Pkcs7
//           key = "1234567898882222"   iv = "8NONwyJtHesysWpM"
//           页面结构：<div id="app" style="display:none;"> 里是一整块 base64 密文
//   列表    /fnyy/                                      首页
//           /fnyy/index.php/vod/type/id/<id>.html         分类，12 条/页，分页 ?page=N
//   详情    /fnyy/index.php/vod/detail/id/<id>.html
//   播放    /fnyy/index.php/vod/play/id/<id>/sid/1/nid/1.html → player_aaaa JSON 里的 url（m3u8，`\/` 转义）
//   搜索    /fnyy/index.php/vod/search.html?wd=<词>
//   分类    54 个：6 个「视频一~六区」做一级 tab，48 个内容分类做二级 chips（用户拍板方案 D）
//
// ⚠ 主机名是中文域名的 punycode：粉0h头.fennen62.buzz → xn--0h-qv9cy35k.fennen62.buzz

import { Spider, openWeb } from "catvod";

const BASE = "https://xn--0h-qv9cy35k.fennen62.buzz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AES_KEY = "1234567898882222";
const AES_IV = "8NONwyJtHesysWpM";
const PAGE_SIZE = 12;
const CACHE_MS = 120000;

// ─────────────────────────── AES-128-CBC 解密 ───────────────────────────
// 纯 JS 实现（App 的 QuickJS 没有 crypto/atob），只需要解密方向。

const SBOX = [];
const INV_SBOX = [];
(function () {
  // 构造 AES S 盒：GF(2^8) 乘法逆元 + 仿射变换
  const mul = (u, v) => {
    let r = 0;
    while (v) {
      if (v & 1) r ^= u;
      u = (u << 1) ^ (u & 0x80 ? 0x11b : 0);
      v >>= 1;
    }
    return r & 0xff;
  };
  const invTable = new Array(256).fill(0);
  for (let i = 1; i < 256; i++) {
    for (let j = 1; j < 256; j++) {
      if (mul(i, j) === 1) { invTable[i] = j; break; }
    }
  }
  const rotl8 = (v, n) => ((v << n) | (v >> (8 - n))) & 0xff;
  for (let i = 0; i < 256; i++) {
    const invS = invTable[i];
    SBOX[i] = (invS ^ rotl8(invS, 1) ^ rotl8(invS, 2) ^ rotl8(invS, 3) ^ rotl8(invS, 4) ^ 0x63) & 0xff;
  }
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

function gmul(a, b) {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) r ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return r;
}

function expandKey(key) {
  // AES-128: 11 轮密钥，每轮 16 字节
  const Nk = 4, Nr = 10;
  const w = new Array(4 * (Nr + 1));
  for (let i = 0; i < Nk; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
  let rcon = 1;
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let t = w[i - 1].slice();
    if (i % Nk === 0) {
      t = [t[1], t[2], t[3], t[0]].map((v) => SBOX[v]);
      t[0] ^= rcon;
      rcon = gmul(rcon, 2);
    }
    w[i] = [w[i - Nk][0] ^ t[0], w[i - Nk][1] ^ t[1], w[i - Nk][2] ^ t[2], w[i - Nk][3] ^ t[3]];
  }
  const rk = [];
  for (let r = 0; r <= Nr; r++) {
    const arr = [];
    for (let c = 0; c < 4; c++) arr.push(...w[r * 4 + c]);
    rk.push(arr);
  }
  return rk;
}

function decryptBlock(block, rk) {
  let s = block.slice();
  const addRK = (r) => { for (let i = 0; i < 16; i++) s[i] ^= rk[r][i]; };
  addRK(10);
  for (let round = 9; round >= 1; round--) {
    // InvShiftRows
    const t = s.slice();
    s[0] = t[0]; s[1] = t[13]; s[2] = t[10]; s[3] = t[7];
    s[4] = t[4]; s[5] = t[1]; s[6] = t[14]; s[7] = t[11];
    s[8] = t[8]; s[9] = t[5]; s[10] = t[2]; s[11] = t[15];
    s[12] = t[12]; s[13] = t[9]; s[14] = t[6]; s[15] = t[3];
    // InvSubBytes
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRK(round);
    // InvMixColumns
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
  }
  // 最后一轮
  const t = s.slice();
  s[0] = t[0]; s[1] = t[13]; s[2] = t[10]; s[3] = t[7];
  s[4] = t[4]; s[5] = t[1]; s[6] = t[14]; s[7] = t[11];
  s[8] = t[8]; s[9] = t[5]; s[10] = t[2]; s[11] = t[15];
  s[12] = t[12]; s[13] = t[9]; s[14] = t[6]; s[15] = t[3];
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
  addRK(0);
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64ToBytes(str) {
  const s = String(str).replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === "=") break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function bytesToUtf8(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

const RK_CACHE = {};
function aesDecryptB64(b64) {
  const key = AES_KEY.split("").map((c) => c.charCodeAt(0));
  const iv = AES_IV.split("").map((c) => c.charCodeAt(0));
  const ck = AES_KEY;
  if (!RK_CACHE[ck]) RK_CACHE[ck] = expandKey(key);

  const data = b64ToBytes(b64);
  const out = [];
  let prev = iv.slice();
  for (let off = 0; off + 16 <= data.length; off += 16) {
    const block = data.slice(off, off + 16);
    const dec = decryptBlock(block, RK_CACHE[ck]);
    for (let i = 0; i < 16; i++) out.push(dec[i] ^ prev[i]);
    prev = block;
  }
  // 去 PKCS7
  const pad = out.length ? out[out.length - 1] : 0;
  if (pad > 0 && pad <= 16 && pad <= out.length) out.length -= pad;
  return bytesToUtf8(out);
}

// ─────────────────────────── 通用工具 ───────────────────────────

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/fnyy/",
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function strip(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function abs(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 把加密页解成明文 HTML */
function unmask(html) {
  const m = String(html || "").match(/id="app"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return html;
  const blob = m[1].trim();
  if (blob.length < 500) return html;
  try {
    const out = aesDecryptB64(blob);
    return out && out.length > 500 ? out : html;
  } catch (e) {
    return html;
  }
}

/** 一级分类：视频一~六区（做 tab） */
const ZONES = [
  { id: "140", name: "视频一区" },
  { id: "141", name: "视频二区" },
  { id: "142", name: "视频三区" },
  { id: "143", name: "视频四区" },
  { id: "144", name: "视频五区" },
  { id: "193", name: "视频六区" },
];

/** 二级内容分类（48 个，用户拍板方案 D：分区 → 分类） */
const CATS = [
  ["118", "探花精选"], ["162", "国产精品"], ["163", "主播秀色"], ["164", "日本有码"],
  ["165", "童颜巨乳"], ["166", "性感人妻"], ["167", "欧美情色"], ["168", "丝袜OL"],
  ["169", "自拍偷拍"], ["170", "日本片商"], ["171", "剧情介绍"], ["172", "明星换脸"],
  ["173", "国产乱伦"], ["27", "优选主播"], ["107", "网红黑料"], ["73", "麻豆传媒"],
  ["84", "水果派"], ["90", "女神学生"], ["25", "国产原创"], ["53", "童真萝莉"],
  ["74", "女同人妖"], ["49", "日本无码"], ["72", "网曝系列"], ["106", "AI换脸"],
  ["174", "国产丝袜"], ["47", "精品推荐"], ["41", "三级伦理"], ["52", "强奸乱伦"],
  ["33", "欧美大片"], ["50", "中文字幕"], ["79", "抖阴视频"], ["91", "偷拍自拍"],
  ["179", "制服诱惑"], ["175", "国产SM"], ["176", "国产人妻"], ["177", "探花嫖娼"],
  ["178", "同性恋"], ["54", "卡通动漫"], ["104", "熟女人妻"], ["102", "巨乳美乳"],
  ["195", "国产主播"], ["196", "国产自拍"], ["199", "女同性恋"], ["201", "视频伦理"],
  ["203", "少女萝莉"], ["204", "重口色情"], ["205", "人兽性交"], ["206", "福利姬"],
].map((x) => ({ id: x[0], name: x[1] }));

/** 列表卡片 */
function parseCards(html) {
  const src = String(html || "");
  const out = [];
  const seen = {};
  const re = /<a[^>]*class="[^"]*stui-vodlist__thumb[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[0];
    const href = tag.match(/href="([^"]*\/vod\/detail\/id\/(\d+)\.html)"/);
    if (!href) continue;
    const id = href[2];
    if (seen[id]) continue;
    seen[id] = 1;
    const t = tag.match(/title="([^"]{1,200})"/);
    const pic = tag.match(/data-original="([^"]+)"/) || tag.match(/data-src="([^"]+)"/);
    if (!t) continue;
    // 首页混着几张占位卡（title="点击查看"）→ 跳过；封面相对路径留着（abs() 会补全）
    if (strip(t[1]) === "点击查看") continue;
    const rawPic = (pic && pic[1]) || "";
    if (!rawPic) continue;

    const tail = src.substring(m.index, m.index + 900);
    const pt = tail.match(/class="[^"]*pic-text[^"]*"[^>]*>([\s\S]{0,24}?)</);
    const remark = pt ? strip(pt[1]) : "";

    out.push({
      id: id,
      url: BASE + "/fnyy/index.php/vod/detail/id/" + id + ".html",
      title: strip(t[1]),
      pic: abs((pic && pic[1]) || ""),
      remark: remark,
    });
  }
  return out;
}

// @bili-helpers BEGIN v2026-11-26（由 tools/inject.mjs 注入，可安全整块替换）
function titlePV(title) {
  const t = String(title || "");
  const both = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]\s*([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const toHalf = (x) => Number(String(x).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))) || 0;
  if (both) return { p: toHalf(both[1]), v: toHalf(both[2]) };
  const onlyV = t.match(/([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const onlyP = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]/);
  return { p: onlyP ? toHalf(onlyP[1]) : 0, v: onlyV ? toHalf(onlyV[1]) : 0 };
}

/** 标题里的时长（12:34 / 01:47:35），取不到给空串 */

function titleDuration(title) {
  const m = String(title || "").match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return m ? m[1] : "";
}

/**
 * 角标：站点结构化字段 > 标题里的 P/V/时长 > 留空。
 * 用法：vod_remarks: badgeOf(title, { photos: 12, videos: 1, duration: "12:34" })
 * 返回形态只有三种合法：NP、NP·MV、时长；无效值（0P/1P 占位）自动忽略。
 */

function badgeOf(title, info) {
  const i = info || {};
  const pv = titlePV(title);
  let p = Number(i.photos) > 0 ? Number(i.photos) : pv.p;
  let v = Number(i.videos) > 0 ? Number(i.videos) : pv.v;
  if (p === 1 && v > 0) p = 0;              // 「1P·1V」里的 1P 多半是封面占位
  if (p > 0 && v > 0) return p + "P·" + v + "V";
  if (v > 0) return v + "V";
  if (p > 0) return p + "P";
  const dur = i.duration || titleDuration(title);
  return dur || "";
}

// @bili-helpers END

export default class Fn extends Spider {
  init() {
    this.cache = {};
  }

  async getPage(url) {
    const c = this.cache[url];
    if (c && Date.now() - c.ts < CACHE_MS) return c.html;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await this.net.req(url, { headers: hdrs(url) });
        if (r && r.code === 200 && r.content) {
          const html = unmask(r.content);
          this.cache[url] = { html: html, ts: Date.now() };
          return html;
        }
      } catch (e) { }
      await new Promise((res) => setTimeout(res, 600));
    }
    return "";
  }

  async homeContent() {
    const class_ = [{ type_id: "latest", type_name: "最新" }];
    for (const z of ZONES) class_.push({ type_id: "zone" + z.id, type_name: z.name });
    class_.push({ type_id: "web", type_name: "网页" });

    return { class: class_, subFromTab: true };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.remark || "",
    }));
  }

  async listFrom(url, p) {
    const html = await this.getPage(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseCards(html);
    const more = html.indexOf("下一页") >= 0 || html.indexOf("page=" + (p + 1)) >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "latest");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + "/fnyy/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 二级 chips 选中的内容分类优先（站点分类是平级的）
    const sub = String(ext.sub || "");
    let typeId = "";
    if (sub.indexOf("cat:") === 0) typeId = sub.substring(4);
    else if (t.indexOf("zone") === 0) typeId = t.substring(4);

    const base = typeId
      ? BASE + "/fnyy/index.php/vod/type/id/" + typeId + ".html"
      : BASE + "/fnyy/";
    const url = p > 1 ? base + (base.indexOf("?") >= 0 ? "&" : "?") + "page=" + p : base;
    return this.listFrom(url, p);
  }

  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const vidm = pageUrl.match(/\/id\/(\d+)\.html/);
    const vid = vidm ? vidm[1] : "";
    const html = await this.getPage(pageUrl);
    if (!html) return { list: [] };

    let title = "";
    const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
    if (h1) title = strip(h1[1]);
    if (!title) {
      const og = html.match(/property="og:title"[^>]*content="([^"]{2,200})"/);
      if (og) title = strip(og[1]);
    }
    if (!title) {
      const tt = html.match(/<title>([^<]*)<\/title>/);
      if (tt) title = strip(tt[1]).split(/[-|_]/)[0].trim();
    }

    let pic = "";
    const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
    if (ogi) pic = abs(ogi[1]);
    if (!pic) {
      const im = html.match(/data-original="([^"]+\.(?:jpg|jpeg|png|webp|avif)[^"]*)"/i);
      if (im) pic = abs(im[1]);
    }

    // 分类 chips（详情页里的 /vod/type/id/N.html）
    const cats = [];
    const seenC = {};
    const reC = /\/vod\/type\/id\/(\d+)\.html"[^>]*>([\s\S]{0,120}?)<\/a>/g;
    let m;
    while ((m = reC.exec(html)) !== null) {
      const nm = strip(m[2]);
      if (!nm || seenC[m[1]] || nm.length > 12) continue;
      seenC[m[1]] = 1;
      cats.push({ id: m[1], name: nm });
      if (cats.length >= 4) break;
    }
    const lines = [];
    if (cats.length) lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.id + '"}/]' + x.name + "[/a]").join(" · "));

    // 简介
    const doc = html.match(/<div class="[^"]*detail-content[^"]*"[^>]*>([\s\S]{0,600}?)<\/div>/)
      || html.match(/<p class="[^"]*desc[^"]*"[^>]*>([\s\S]{0,600}?)<\/p>/);
    if (doc) {
      const txt = strip(doc[1]);
      if (txt) lines.push(txt);
    }

    const playUrl = BASE + "/fnyy/index.php/vod/play/id/" + vid + "/sid/1/nid/1.html";

    const item = {
      vod_id: pageUrl,
      vod_name: title || "fennen",
      vod_pic: pic,
      vod_content: lines.join("\n"),
      vod_play_from: "粉嫩",
      vod_play_url: "正片$" + playUrl,
    };

    // 相关推荐：详情页里的其它卡片
    const rel = [];
    const seenR = {};
    seenR[vid] = 1;
    for (const c of parseCards(html)) {
      if (rel.length >= 8) break;
      if (seenR[c.id]) continue;
      seenR[c.id] = 1;
      rel.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: c.remark || "" });
    }

    return { list: [item].concat(rel) };
  }

  async playerContent(flag, id) {
    const raw = String(id || "");
    const header = { "User-Agent": UA, "Referer": BASE + "/fnyy/" };
    if (/\.(?:m3u8|mp4)(?:$|\?)/i.test(raw)) return { parse: 0, url: raw, header: header };

    const pageUrl = raw.indexOf("http") === 0 ? raw : BASE + raw;
    const html = await this.getPage(pageUrl);
    if (!html) throw new Error("播放页取不到");

    // HTML 里的播放地址是双层转义（"url":"https:\\/\\/…index.m3u8"），
    // 直接按 ".m3u8" 反查整条字符串，再统一反转义（别指望 JSON.parse 一次搞定）
    let u = "";
    const at = html.indexOf(".m3u8");
    if (at >= 0) {
      const start = html.lastIndexOf("http", at);
      if (start >= 0) {
        let end = at + 5;
        while (end < html.length) {
          const ch = html.charAt(end);
          if (ch === '"' || ch === "'" || ch === "<" || ch === ">" || ch === " " || ch === "\\" || ch === "\n") break;
          end++;
        }
        u = html.substring(start, end);
      }
    }
    if (!u) throw new Error("没找到播放地址");
    u = u.replace(/\\\\\//g, "/").replace(/\\\//g, "/");
    return { parse: 0, url: u, header: header };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/fnyy/index.php/vod/search.html?wd=" + encodeURIComponent(String(key || ""))
      + (p > 1 ? "&page=" + p : "");
    return this.listFrom(url, p);
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];

    // 二级 chips：分区 tab → 48 个内容分类
    // ⚠ 必须返回数组 [{name, value}]（App 会自动在行首插「全部」）
    if (s.indexOf("sub|") === 0) {
      return CATS.map((c) => ({ name: c.name, value: "cat:" + c.id }));
    }

    if (s.indexOf("gal|") === 0) return { list: [] };

    return [];
  }
}
