// pped-gayd-deck.xofulitu-108.com —— BiliTV / catvod QuickJS 插件
// 发布自检标记 2026-11-26（验证 publish.ps1 全链路）
//
// 侦查结论（2026-11-25）：
//   站型   MacCMS 类「图集站」（album / art 体系，非视频）
//   列表   /xoxo                     每页 48 个相册，**没有分页**（固定 48 条）
//           /arttype/<id>/            分类，每页 24 个，分页 ?page=N 有效
//   详情   /art/pic/id/<id>/          一页 23 张图（data-src）
//   搜索   GET /artsearch/?wd=<词>
//   图片   https://img.<host>/comics/images<N>/<id>.jpg
//   卡片   div.album-item → a[href=/art/pic/id/N/] + .album-img>img + .album-name + .image-total
//   分类   首页 nav 里 60 个 /arttype/<id>/（名字 2~4 字）

import { Spider, openWeb } from "catvod";

const BASE = "https://pped-gayd-deck.xofulitu-108.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;
const CACHE_MS = 180000;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/xoxo",
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

/** 列表卡片：div.album-item 块 */
function parseCards(html) {
  const src = String(html || "");
  // 注意：album-item 是 <a> 的 class（不是 div）→ 按位置切片，窗口 1600
  const marks = [];
  const reMark = /class="[^"]*album-item/g;
  let mk;
  while ((mk = reMark.exec(src)) !== null) marks.push(mk.index);
  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1] : marks[i] + 1600;
    const seg = src.substring(Math.max(0, marks[i] - 400), Math.min(end, marks[i] + 1600));
    const link = seg.match(/href="([^"]*\/art\/pic\/id\/(\d+)\/)"/);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;
    seen[url] = 1;

    let title = "";
    const nm = seg.match(/class="[^"]*album-name[^"]*"[^>]*>([\s\S]{0,160}?)<\/div>/);
    if (nm) title = strip(nm[1]);
    if (!title) {
      const alt = seg.match(/<img[^>]+alt="([^"]{2,120})"/);
      if (alt) title = strip(alt[1]);
    }
    if (!title) continue;

    let pic = "";
    const p1 = seg.match(/<img[^>]*\sdata-src\s*=\s*"([^"]+)"/);
    const p2 = seg.match(/<img[^>]*\ssrc\s*=\s*"([^"]+)"/);
    pic = abs((p1 && p1[1]) || (p2 && p2[1]) || "");
    if (pic && pic.indexOf("data:") === 0) pic = "";

    // 张数：.image-total 里通常是「40」或「40P」
    let remark = "";
    const tm = seg.match(/class="[^"]*image-total[^"]*"[^>]*>([\s\S]{0,40}?)</);
    if (tm) {
      const n = strip(tm[1]).match(/(\d{1,4})/);
      if (n) remark = n[1] + "P";
    }

    out.push({ url: url, title: title, pic: pic, remark: remark });
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

export default class Xof extends Spider {
  init() {
    this.cache = {};
    this.catCache = null;
  }

  async getHtml(url) {
    const c = this.cache[url];
    if (c && Date.now() - c.ts < CACHE_MS) return c.html;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await this.net.req(url, { headers: hdrs(url) });
        if (r && r.code === 200 && r.content) {
          this.cache[url] = { html: r.content, ts: Date.now() };
          return r.content;
        }
      } catch (e) { }
      await new Promise((res) => setTimeout(res, 700));
    }
    return "";
  }

  /** 分类清单：首页 nav 的 /arttype/<id>/ */
  async loadCats() {
    if (this.catCache) return this.catCache;
    const html = await this.getHtml(BASE + "/xoxo");
    const out = [];
    const seen = {};
    const re = /href="\/arttype\/(\d+)\/"[^>]*>([\s\S]{0,200}?)<\/a>/g;
    let m;
    while ((m = re.exec(html || "")) !== null) {
      const id = m[1];
      const nm = strip(m[2]);
      if (!nm || seen[id]) continue;
      seen[id] = 1;
      out.push({ id: id, name: nm });
      if (out.length >= 60) break;
    }
    this.catCache = out;
    return out;
  }

  async homeContent() {
    const cats = await this.loadCats();
    const media = [{ n: "最新", v: "" }];
    for (const c of cats) media.push({ n: c.name, v: "c:" + c.id });

    return {
      class: [
        { type_id: "latest", type_name: "最新" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        latest: [{ key: "media", name: "分类", value: media }],
      },
    };
  }

  /** 详情页张数（列表页的张数被站点注释掉了，只能进详情数） */
  async picCount(url) {
    const html = await this.getHtml(url);
    if (!html) return 0;
    const seen = {};
    let n = 0, all = 0;
    const re = /(?:data-src|src)\s*=\s*"([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const u = m[1];
      if (/\/static\/|\/MDassets\/|\/upload\/site\/|logo|favicon|avatar/i.test(u)) continue;
      if (seen[u]) continue;
      seen[u] = 1;
      all++;
      if (u.indexOf("/comics/") >= 0) n++;
    }
    return n || all;
  }

  /** 给前 limit 条补 张数角标（有界 + 截止） */
  async fillCounts(cards, limit, deadlineMs) {
    const todo = cards.slice(0, limit);
    const jobs = todo.map((c) => (async () => {
      try {
        const n = await this.picCount(c.url);
        if (n > 0) c.remark = n + "P";
      } catch (e) { }
    })());
    try {
      await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, deadlineMs))]);
    } catch (e) { }
    return cards;
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.remark || "图集",
    }));
  }

  async listFrom(url, p) {
    const html = await this.getHtml(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseCards(html);
    if (p === 1 && cards.length) await this.fillCounts(cards, 8, 2500);
    const more = html.indexOf("page=" + (p + 1)) >= 0 || html.indexOf("下一页") >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "latest");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + "/xoxo" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const media = String(ext.media || "");
    const catId = media.indexOf("c:") === 0 ? media.substring(2)
      : (ext.sub && String(ext.sub).indexOf("cat:") === 0 ? String(ext.sub).substring(4)
        : (t.indexOf("cat:") === 0 ? t.substring(4) : ""));

    if (catId) {
      return this.listFrom(BASE + "/arttype/" + catId + "/" + (p > 1 ? "?page=" + p : ""), p);
    }
    // 「最新」= /xoxo，站点固定 48 条、无分页
    return this.listFrom(BASE + "/xoxo", p);
  }

  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const html = await this.getHtml(pageUrl);
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

    // 图片：data-src（一页 23 张）
    // 注意页面前面还有站点自己的素材（/upload/site/…），只认图集的 /comics/ 路径
    const allImgs = [];
    const comicImgs = [];
    const seen = {};
    const re = /(?:data-src|src)\s*=\s*"([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const u = abs(m[1].trim());
      if (!u || seen[u]) continue;
      if (/\/static\/|\/MDassets\/|\/upload\/site\/|logo|favicon|avatar/i.test(u)) continue;
      seen[u] = 1;
      allImgs.push(u);
      if (u.indexOf("/comics/") >= 0) comicImgs.push(u);
    }
    const imgs = comicImgs.length ? comicImgs : allImgs;

    // 站点没有 og:image（实测无），封面直接用第一张图
    let pic = imgs[0] || "";
    const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
    if (!pic && ogi) pic = abs(ogi[1]);

    // 分类 chips
    const cats = [];
    const seenC = {};
    const reC = /href="\/arttype\/(\d+)\/"[^>]*>([\s\S]{0,200}?)<\/a>/g;
    while ((m = reC.exec(html)) !== null) {
      const nm = strip(m[2]);
      if (!nm || seenC[m[1]]) continue;
      seenC[m[1]] = 1;
      cats.push({ id: m[1], name: nm });
      if (cats.length >= 4) break;
    }

    const lines = [];
    if (cats.length) lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.id + '"}/]' + x.name + "[/a]").join(" · "));

    const item = {
      vod_id: pageUrl,
      vod_name: title || "图集",
      vod_pic: pic,
      vod_content: lines.join("\n"),
      vod_remarks: imgs.length ? imgs.length + "P" : "图集",
      gallery: true,
      vod_play_from: "xof",
      vod_play_url: "图集$gal://" + pageUrl,
    };

    // 相关推荐：同页里的其它相册
    const rel = [];
    const seenR = {};
    seenR[pageUrl] = 1;
    for (const c of parseCards(html)) {
      if (rel.length >= 8) break;
      if (seenR[c.url]) continue;
      seenR[c.url] = 1;
      rel.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: c.remark || "" });
    }

    return { list: [item].concat(rel) };
  }

  async playerContent(flag, id) {
    throw new Error("这是图集站，请在详情页点「图集」查看");
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/artsearch/?wd=" + encodeURIComponent(String(key || "")) + (p > 1 ? "&page=" + p : "");
    return this.listFrom(url, p);
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];

    // 图集：gal|<页面URL>
    if (s.indexOf("gal|") === 0) {
      const u = s.substring(4).replace(/^gal:\/\//, "");
      const pageUrl = u.indexOf("http") === 0 ? u : BASE + u;
      const html = await this.getHtml(pageUrl);
      if (!html) return { list: [] };
      const list = [];
      const comics = [];
      const seen = {};
      const re = /(?:data-src|src)\s*=\s*"([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const full = abs(m[1].trim());
        if (!full || seen[full]) continue;
        if (/\/static\/|\/MDassets\/|\/upload\/site\/|logo|favicon|avatar/i.test(full)) continue;
        seen[full] = 1;
        list.push({ url: full });
        if (full.indexOf("/comics/") >= 0) comics.push({ url: full });
      }
      return { list: comics.length ? comics : list };
    }

    // 侧栏：分类
    if (s === "side|") {
      const cats = await this.loadCats();
      if (!cats.length) return { groups: [] };
      return {
        groups: [{
          name: "分类",
          items: cats.slice(0, 24).map((c) => ({ name: c.name, count: "", id: "cat:" + c.id })),
        }],
      };
    }

    // 分面：分类搜索
    if (s.indexOf("facet|category|") === 0) {
      const rest = s.substring("facet|category|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      const cats = await this.loadCats();
      const hit = kw ? cats.filter((c) => c.name.toLowerCase().indexOf(kw) >= 0) : cats;
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((c) => ({ id: "cat:" + c.id, name: c.name, count: "" })),
      };
    }

    return [];
  }
}
