// 每日大赛（mrds.com）—— BiliTV / catvod QuickJS 插件
//
// 站类型：混合站（一篇帖子可同时有多个视频 + 多张图）
//   ⚠ 站点直连常超时，手机必须挂代理
//
//   全部   /page/N/                          2055 页 × 30
//   分类   /category/<slug>/N/               20 个分类（数字直接接，不是 /page/N/）
//   详情   /archives/<id>/
//   搜索   /?s=<词>
//
// 卡片（封面藏在 JS 里，不是 <img>）：
//   <a href="/archives/203020/"><div class="post-card" id="post-card-203020">
//     <script>loadBannerDirect('https://pic.mmgbaa.cn//upload_01/…/xxx.jpeg', …)</script>
//     <h2 class="post-card-title">标题</h2>
//     <div class="post-card-info">作者 · 日期 · 分类</div>
//   </div></a>
//   ⚠ 广告卡 <article class="ad-item"> 混在列表里，封面走 /hc237/，必须过滤
//
// 详情：dplayer 的 data-config 里有 m3u8（HLS + AES）；图集在 /upload_01/
//   ⚠ 广告图也在 pic.mmgbaa.cn 下（/hc237/），必须排除

import { Spider, openWeb } from "catvod";

const BASE = "https://mrds.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 30;

// 图床图片是加密的（浏览器用 CryptoJS AES 解密后转 data URI）。
// 参数从站点 /usr/plugins/tbxw/js/zzz.js 的 decryptImage() 提取：
//   key = "f5d965df75336270"  iv = "97b60394abc2fbe1"  AES-128-CBC / PKCS7
const IMG_KEY = "f5d965df75336270";
const IMG_IV = "97b60394abc2fbe1";

// ---- base64 编解码（QuickJS 没有 btoa/atob）----
const B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] & 0xff;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] & 0xff : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] & 0xff : 0;
    out += B64C.charAt(b0 >> 2);
    out += B64C.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += i + 1 < bytes.length ? B64C.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
    out += i + 2 < bytes.length ? B64C.charAt(b2 & 63) : "=";
  }
  return out;
}

function b64ToBytes(str) {
  const clean = String(str || "").replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = B64C.indexOf(clean.charAt(i));
    const n1 = B64C.indexOf(clean.charAt(i + 1));
    const n2 = B64C.indexOf(clean.charAt(i + 2));
    const n3 = B64C.indexOf(clean.charAt(i + 3));
    out.push(((n0 << 2) | (n1 >> 4)) & 0xff);
    if (n2 >= 0 && i + 2 < clean.length) out.push(((n1 << 4) | (n2 >> 2)) & 0xff);
    if (n3 >= 0 && i + 3 < clean.length) out.push(((n2 << 6) | n3) & 0xff);
  }
  return out;
}

/** 解密一张图床图片，返回 { bytes, mime } */
function decryptImage(encBytes) {
  const b64 = bytesToB64(encBytes);
  const plain = aesX("AES/CBC/PKCS5Padding", false, b64, true, IMG_KEY, IMG_IV, true);
  if (!plain) return null;
  const bytes = b64ToBytes(plain);
  if (!bytes.length) return null;
  let mime = "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
  else if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) mime = "image/webp";
  else return null;   // 解出来不是图片
  return { bytes: bytes, mime: mime };
}

/** 图片一律走本地代理解密；插件里其他地方 append 这个前缀 */
function imgProxy(spider, url) {
  if (!url) return "";
  try {
    return spider.proxyUrl({ u: url, m: "img" });
  } catch (e) {
    return url;
  }
}

// 20 个分类，按性质分 4 组（tab + ▾ 二级菜单）
const GROUPS = [
  {
    id: "hot", name: "热门",
    subs: [
      { id: "cat:mrds", name: "每日大赛" },
      { id: "cat:blyp", name: "必撸大赛" },
      { id: "cat:qwcs", name: "全网参赛" },
      { id: "cat:ztds", name: "主题大赛" },
      { id: "cat:rstt", name: "热搜吃瓜" },
    ],
  },
  {
    id: "type", name: "类型",
    subs: [
      { id: "cat:fctg", name: "反差泄密" },
      { id: "cat:mhds", name: "网红黑料" },
      { id: "cat:lqdp", name: "猎奇重口" },
      { id: "cat:jdsj", name: "AV看片" },
      { id: "cat:xazd", name: "校园学生" },
      { id: "cat:mxwh", name: "明星大赛" },
    ],
  },
  {
    id: "acg", name: "二次元",
    subs: [
      { id: "cat:smdh", name: "动漫之家" },
      { id: "cat:dypd", name: "影视国漫" },
      { id: "cat:mtds", name: "cos写真" },
      { id: "cat:ysds", name: "声控ASMR" },
      { id: "cat:aijc", name: "AI剧场" },
    ],
  },
  {
    id: "more", name: "大赛",
    subs: [
      { id: "cat:czds", name: "寸止挑战" },
      { id: "cat:hjds", name: "混剪PMV" },
      { id: "cat:tgds", name: "原创投稿" },
      { id: "cat:omjp", name: "欧美精品" },
    ],
  },
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function clean(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** 列表卡片：以 post-card 为锚点切块（广告卡 id 是 ad-card-N，直接跳过） */
function parseCards(html) {
  const text = String(html || "");
  const marks = [];
  const re = /<div class="post-card"\s+id="post-card-(\d+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ at: m.index, id: m[1] });

  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].at;
    const to = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const b = text.substring(from, to);

    const id = marks[i].id;
    if (seen[id]) continue;
    seen[id] = 1;

    let pic = "";
    const bm = b.match(/loadBannerDirect\('([^']+)'/);
    if (bm) pic = decode(bm[1]).replace(/\/\/upload_01/, "/upload_01");
    if (!pic) {
      const im = b.match(/https?:[^\s"']*?pic\.[^\s"']+?\.(?:jpe?g|png|webp)/);
      if (im) pic = decode(im[0]);
    }

    let title = "";
    const tm = b.match(/class="post-card-title"[^>]*>([\s\S]*?)<\/h2>/);
    if (tm) title = clean(tm[1]);
    if (!title) {
      const tm2 = b.match(/<h2[^>]*>([\s\S]{0,200}?)<\/h2>/);
      if (tm2) title = clean(tm2[1]);
    }
    title = title.replace(/热搜\s*HOT$/, "").trim();

    out.push({
      vod_id: BASE + "/archives/" + id + "/",
      vod_name: title || ("post " + id),
      vod_pic: pic,
      vod_remarks: "",
    });
  }
  return out;
}

/** 详情页：视频 m3u8 列表 + 图集 */
function parseDetail(html) {
  const text = String(html || "");

  // m3u8（JSON 里可能写成 \/ 或 \u002F）
  const vids = [];
  const seen = {};
  const re = /https?:[^\s"']+?\.m3u8[^\s"']*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let u = m[0].replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
    if (!seen[u]) { seen[u] = 1; vids.push(u); }
  }

  // 图集（排除 /hc237/ 广告）
  const imgs = [];
  const seenI = {};
  const ire = /https?:[^\s"']*?pic\.[^\s"']+?\.(?:jpe?g|png|webp)/g;
  while ((m = ire.exec(text)) !== null) {
    let u = decode(m[0].replace(/\\\//g, "/"));
    if (u.indexOf("/hc237/") >= 0) continue;
    if (seenI[u]) continue;
    seenI[u] = 1;
    imgs.push(u);
  }

  const tm = text.match(/class="post-card-title"[^>]*>([\s\S]{0,300}?)<\/h[12]>/) ||
    text.match(/<title>([^<]*)<\/title>/);
  const title = clean(tm ? tm[1] : "").replace(/\s*-\s*每日大赛\s*$/, "").trim();

  const dur = text.match(/"duration"\s*:\s*"PT(\d+)M(\d+)S"/);
  const duration = dur ? (Number(dur[1]) + ":" + ("0" + dur[2]).slice(-2)) : "";

  const tags = [];
  const tk = text.match(/data-video_tag_name="([^"]*)"/);
  if (tk) {
    for (const t of decode(tk[1]).split(",")) {
      const n = t.trim();
      if (n && tags.indexOf(n) < 0) tags.push(n);
    }
  }
  const ck = text.match(/data-video_type_name="([^"]*)"/);
  const catName = ck ? decode(ck[1]).trim() : "";

  const cov = imgs.length ? imgs[0] : "";

  return { title, vids, imgs, duration, tags, catName, cover: cov };
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|p):/, "");
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 卡片没数量 → 并发补抓详情页算 9P·2V（带缓存） */
async function fillBadges(spider, cards) {
  if (!spider.badgeCache) spider.badgeCache = {};
  const cache = spider.badgeCache;

  for (const c of cards) {
    if (!c.vod_remarks && cache[c.vod_id]) c.vod_remarks = cache[c.vod_id];
  }
  // 30 个详情页并发约 1s（实测），但手机网络可能更慢；留一个上限便于调节
  const LIMIT = 30;
  const todo = cards.filter((c) => !c.vod_remarks).slice(0, LIMIT);
  if (!todo.length) return cards;

  await Promise.all(todo.map(async (c) => {
    try {
      const r = await spider.net.req(c.vod_id, { headers: hdrs(c.vod_id) });
      if (!r || r.code !== 200) return;
      const d = parseDetail(r.content);
      const p = d.imgs.length, v = d.vids.length;
      if (!p && !v) return;
      const badge = (p ? p + "P" : "") + (v ? (p ? "·" : "") + v + "V" : "");
      c.vod_remarks = badge;
      cache[c.vod_id] = badge;
    } catch (e) { }
  }));
  return cards;
}

export default class Mrds extends Spider {
  init() { }

  async homeContent() {
    const classes = [{ type_id: "all", type_name: "全部" }];
    // 4 个分组 tab，带 ▾ 二级菜单
    for (const g of GROUPS) {
      classes.push({
        type_id: g.id,
        type_name: g.name,
        sub: g.subs.map((s) => ({ id: s.id, name: s.name })),
      });
    }
    classes.push({ type_id: "web", type_name: "网页" });
    return { class: classes, filters: {} };
  }

  /** 把卡片/图集的图片地址换成「本地代理解密」地址 */
  wrapImages(cards) {
    for (const c of cards) {
      if (c.vod_pic) c.vod_pic = imgProxy(this, c.vod_pic);
    }
    return cards;
  }

  /** 本地图片代理：拉加密图 → AES 解密 → 返回原始字节 */
  async proxy(params) {
    const u = (params && (params.u || params.url)) || "";
    if (!u) return [404, "text/plain", "no url"];
    try {
      const st = await this.net.openStream(u, { headers: hdrs(u) });
      const enc = await this.readBytes(st);
      if (!enc || !enc.length) return [404, "text/plain", "empty"];
      const dec = decryptImage(enc);
      if (!dec) return [404, "text/plain", "decrypt failed"];
      return [200, dec.mime, dec.bytes];
    } catch (e) {
      return [500, "text/plain", String(e && e.message ? e.message : e)];
    }
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "all");

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    let url;
    if (t.indexOf("cat:") === 0) {
      const slug = t.substring(4);
      url = BASE + "/category/" + slug + "/" + (p <= 1 ? "" : p + "/");
    } else if (GROUPS.some((g) => g.id === t)) {
      // 分组 tab 本身没内容，提示选二级
      return this.page([{
        vod_id: "", vod_name: "点上面的「" + t + " ▾」选一个分类",
        vod_pic: "", vod_remarks: "提示",
      }], 1, PAGE_SIZE, 1);
    } else {
      url = BASE + (p <= 1 ? "/" : "/page/" + p + "/");
    }

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = await fillBadges(this, this.wrapImages(parseCards(html)));
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }

    const d = parseDetail(html);

    const lines = [];
    if (d.catName) lines.push("分类：" + d.catName);
    if (d.tags.length) lines.push(d.tags.slice(0, 14).join(" · "));
    const parts = [];
    if (d.imgs.length) parts.push(d.imgs.length + " 张图");
    if (d.vids.length) parts.push(d.vids.length + " 个视频");
    if (parts.length) lines.push(parts.join(" · "));

    const badge = (d.imgs.length ? d.imgs.length + "P" : "") +
      (d.vids.length ? (d.imgs.length ? "·" : "") + d.vids.length + "V" : "");

    let playFrom = "图集";
    let playUrl = "图集$" + url;
    if (d.vids.length) {
      playFrom = "视频";
      playUrl = d.vids.map((u, i) => ("视频" + (i + 1)) + "$" + u).join("#");
    }

    return {
      list: [{
        vod_id: url,
        vod_name: d.title || url,
        vod_pic: imgProxy(this, d.cover),
        vod_content: lines.join("\n"),
        vod_remarks: badge || d.duration,
        gallery: true,
        vod_play_from: playFrom,
        vod_play_url: playUrl,
      }],
    };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    if (/\.m3u8/.test(url)) {
      return { parse: 1, url: url, header: { "User-Agent": UA, "Referer": BASE + "/" } };
    }
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    const d = parseDetail(html);
    if (!d.vids.length) throw new Error("这篇没有视频");
    return { parse: 1, url: d.vids[0], header: { "User-Agent": UA, "Referer": BASE + "/" } };
  }

  async action(op) {
    if (!op) return [];
    if (op.indexOf("gal|") === 0) {
      const url = pageUrlOf(op.substring(4));
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }
      const d = parseDetail(html);
      return {
        list: d.imgs.map((u) => ({ url: imgProxy(this, u) })),
        tags: d.tags.slice(0, 8).map((t) => ({ name: t, id: "q:" + t })),
      };
    }
    return [];
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/" + (p <= 1 ? "" : "page/" + p + "/") + "?s=" + encodeURIComponent(key);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = await fillBadges(this, this.wrapImages(parseCards(html)));
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
