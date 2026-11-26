// 7m4gg5e37m.mcdrfrange.buzz —— BiliTV / catvod QuickJS 插件
//
// 侦查结论（2026-11-25）：
//   站型   MacCMS 类视频站，模板 /template/xioaxinnu/，Cloudflare 在前
//   ⚠ 有速率限制：连续请求会超时/失败 —— 必须串行 + 缓存 + 失败重试
//   列表   /gao/                     每页 64 卡，分页 ?page=N
//           /vodtype/<id>/           分类，每页 20 卡，分页 ?page=N 或 /N-2/
//   详情   /voddetail/<id>/          含 8 条站内相关推荐（其它 voddetail 链接）
//   播放   /vodplay/<vid>-<sid>-<nid>/  播放页 JS 里是 m3u8（https:\/\/… 转义）
//   搜索   /vodsearch/-------------/?wd=<词>&page=N
//   卡片   div.video-item-card → a[href=/voddetail/id/] + img + h5 标题
//   分类名 在 mega-menu（menu1 / menu-item1）里，解析不稳 → 拿不到就用 id 兜底

import { Spider, openWeb } from "catvod";

const BASE = "https://7m4gg5e37m.mcdrfrange.buzz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 20;
const CACHE_MS = 180000;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
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

function strip(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function abs(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 列表卡片 */
function parseCards(html) {
  const src = String(html || "");
  const parts = src.split(/<div class="video-item-card/).slice(1);
  const out = [];
  const seen = {};
  for (const raw of parts) {
    const seg = raw.substring(0, 1600);
    const link = seg.match(/href="(\/voddetail\/(\d+)\/)"/) || seg.match(/href="([^"]*\/voddetail\/\d+\/)"/);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;
    seen[url] = 1;

    let title = "";
    const h5 = seg.match(/<h5[^>]*>([\s\S]{0,160}?)<\/h5>/);
    if (h5) title = strip(h5[1]);
    if (!title) {
      const alt = seg.match(/<img[^>]+alt="([^"]{2,120})"/);
      if (alt) title = strip(alt[1]);
    }
    if (!title) continue;

    let pic = "";
    const im = seg.match(/<img[^>]+src="([^"]+)"/) || seg.match(/data-src="([^"]+)"/);
    if (im) pic = abs(im[1].trim());
    if (pic && pic.indexOf("data:") === 0) pic = "";

    // 「更新至 xx」之类的角标（有就用，没有就空）
    let remark = "";
    const rm = seg.match(/class="[^"]*(?:badge|tag|remark)[^"]*"[^>]*>([\s\S]{0,20}?)</);
    if (rm) remark = strip(rm[1]);

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

export default class Mcd extends Spider {
  init() {
    this.cache = {};
    this.catCache = null;
  }

  async getHtml(url) {
    const c = this.cache[url];
    if (c && Date.now() - c.ts < CACHE_MS) return c.html;
    // 站点限流：串行 + 失败重试一次
    for (let i = 0; i < 2; i++) {
      try {
        const r = await this.net.req(url, { headers: hdrs(url) });
        if (r && r.code === 200 && r.content) {
          this.cache[url] = { html: r.content, ts: Date.now() };
          return r.content;
        }
      } catch (e) { }
      await new Promise((res) => setTimeout(res, 800));
    }
    return "";
  }

  /** 分类：优先从 mega-menu 解析，失败就给首页那批 /vodtype/ id */
  async loadCats() {
    if (this.catCache) return this.catCache;
    const html = await this.getHtml(BASE + "/gao/");
    const out = [];
    const seen = {};
    if (html) {
      // 锚点里先有 <img src="…">（URL 很长），窗口要给足 200 才够到 </a>
      const re = /href="\/vodtype\/(\d+)\/"[^>]*>([\s\S]{0,200}?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const id = m[1];
        const nm = strip(m[2]);
        if (seen[id]) continue;
        if (!nm || nm === "Watch More") continue;
        seen[id] = 1;
        out.push({ id: id, name: nm });
      }
      // 兜底：任何 /vodtype/<id>/ 链接（名字用 id）
      if (!out.length) {
        const re2 = /\/vodtype\/(\d+)\//g;
        while ((m = re2.exec(html)) !== null) {
          const id = m[1];
          if (seen[id]) continue;
          seen[id] = 1;
          out.push({ id: id, name: "分类 " + id });
          if (out.length >= 24) break;
        }
      }
    }
    this.catCache = out;
    return out;
  }

  async homeContent() {
    const cats = await this.loadCats();
    const media = [{ n: "全部", v: "" }];
    for (const c of cats.slice(0, 40)) media.push({ n: c.name, v: "c:" + c.id });

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

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.remark || "",
    }));
  }

  async listFrom(url, p) {
    const html = await this.getHtml(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseCards(html);
    const more = html.indexOf("page=" + (p + 1)) >= 0
      || html.indexOf("/" + (p + 1) + "/") >= 0
      || html.indexOf("下一页") >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "latest");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + "/gao/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 详情页 chips 点进来
    const catTid = ext.sub && String(ext.sub).indexOf("cat:") === 0 ? String(ext.sub).substring(4)
      : (t.indexOf("cat:") === 0 ? t.substring(4) : "");
    if (catTid) {
      const url = BASE + "/vodtype/" + catTid + "/" + (p > 1 ? "?page=" + p : "");
      return this.listFrom(url, p);
    }

    const media = String(ext.media || "");
    if (media.indexOf("c:") === 0) {
      const url = BASE + "/vodtype/" + media.substring(2) + "/" + (p > 1 ? "?page=" + p : "");
      return this.listFrom(url, p);
    }

    return this.listFrom(BASE + "/gao/" + (p > 1 ? "?page=" + p : ""), p);
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

    let pic = "";
    const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
    if (ogi) pic = abs(ogi[1]);
    if (!pic) {
      const im = html.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
      if (im) pic = abs(im[1]);
    }
    // 站点没有 og:image 时会抓到 favicon，剔掉
    if (pic && /favicon|\.ico(\?|$)/i.test(pic)) pic = "";
    if (!pic) {
      const im2 = html.match(/\.(?:jpg|jpeg|png|webp)\?[^"'\s]*/);   // 兜底不处理
      void im2;
    }

    // 分类 / 标签（/vodtype/ 与 /vodlabel/ 之类）
    const cats = [];
    const seenC = {};
    // 同 loadCats：锚点里可能先有 <img>，窗口要给足
    const reC = /href="\/vodtype\/(\d+)\/"[^>]*>([\s\S]{0,200}?)<\/a>/g;
    let m;
    while ((m = reC.exec(html)) !== null) {
      const nm = strip(m[2]);
      if (!nm || nm === "Watch More" || seenC[m[1]]) continue;
      seenC[m[1]] = 1;
      cats.push({ id: m[1], name: nm });
      if (cats.length >= 4) break;
    }

    const lines = [];
    if (cats.length) lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.id + '"}/]' + x.name + "[/a]").join(" · "));

    // 播放页
    const play = html.match(/\/vodplay\/([0-9]+-[0-9]+-[0-9]+)\//);

    const item = {
      vod_id: pageUrl,
      vod_name: title || "mcd",
      vod_pic: pic,
      vod_content: lines.join("\n"),
      vod_play_from: "mcd",
      vod_play_url: play ? "正片$" + BASE + "/vodplay/" + play[1] + "/" : "网页查看$web://" + pageUrl,
    };

    // 相关推荐：站点自带（详情页里其它 voddetail 链接，实测 8 条）
    const rel = [];
    const seen = {};
    seen[pageUrl] = 1;
    for (const c of parseCards(html)) {
      if (rel.length >= 8) break;
      if (seen[c.url]) continue;
      seen[c.url] = 1;
      rel.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: c.remark || "" });
    }

    return { list: [item].concat(rel) };
  }

  async playerContent(flag, id) {
    const raw = String(id || "");
    const header = { "User-Agent": UA, "Referer": BASE + "/" };
    if (/\.(?:m3u8|mp4)(?:$|\?)/i.test(raw)) return { parse: 0, url: raw, header: header };

    const pageUrl = raw.indexOf("http") === 0 ? raw : BASE + raw;
    const html = await this.getHtml(pageUrl);
    if (!html) throw new Error("播放页取不到");
    // 播放页里是 https:\/\/…\/index.m3u8（转义形式）
    let mu = html.match(/(https?:\\?\/\\?\/[^"'\s]+?\.m3u8[^"'\s]*)/);
    if (!mu) mu = html.match(/"(https?:\/\/[^"]+?\.m3u8[^"]*)"/);
    if (!mu) throw new Error("没找到 m3u8");
    const url = mu[1].replace(/\\\//g, "/");
    return { parse: 0, url: url, header: header };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/vodsearch/-------------/?wd=" + encodeURIComponent(String(key || "")) + (p > 1 ? "&page=" + p : "");
    return this.listFrom(url, p);
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];
    if (s.indexOf("gal|") === 0) return { list: [] };

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
