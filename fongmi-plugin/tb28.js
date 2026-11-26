// h3lv--8ivi.taobao28setuku.com —— BiliTV / catvod QuickJS 插件
//
// 侦查结论（2026-11-26）：
//   站型   MacCMS + stui 模板，**图集站**（art 模块，非视频）
//   列表   /arttype/0/         「全部」列表，每页 16~32 个卡片，分页 ?page=N
//           /arttype/<id>/      分类页，同样 ?page=N
//   卡片   a.stui-vodlist__thumb[href=/artdetail/<id>/][title=…][data-original=封面(avif)]
//          内部 span.pic-text 是张数位（站点多为 0P，不可靠）
//   详情   /artdetail-<id>-<页>/   ⚠ **每页只有 1 张图**，整本图集的页数 = 分页条里的最大页号
//          正文图在 div.news-content 里，直接 <img src="https://img.img12345.com/comics/…">
//          详情页自带相关推荐（其它 /artdetail-<id>/ 卡片，实测 28 条）
//   搜索   站点**没有搜索接口**（/artsearch、/search 全 404/500）→ searchContent 返回空
//
// 约束：一个图集要抓 N 个页面（每页 1 张图），N 可达 20+；gal| 必须并发抓且限制并发数。

import { Spider, openWeb } from "catvod";

const BASE = "https://h3lv--8ivi.taobao28setuku.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

// 站点自带三种排序：/artshow-<cat>/by/<key>/（实测 by/hits、by/score 首条都不同）
// 站点导航里没有、但 /artshow-<id>/ 真实存在的分类（2026-11-26 探测）
// 实测内容量：157 海堂美图 8 条、160 模特儿露出 2 条；149 少女色图 / 159 顶级白虎 当前 0 条
const EXTRA_CATS = [
  { id: "149", name: "少女色图" },
  { id: "157", name: "海堂美图" },
  { id: "159", name: "顶级白虎" },
  { id: "160", name: "模特儿露出" },
];

const SORTS = [
  { key: "time", name: "最新" },
  { key: "hits", name: "最热" },
  { key: "score", name: "评分" },
];
const CACHE_MS = 180000;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/arttype/0/",
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

/** 列表卡片：a.stui-vodlist__thumb */
function parseCards(html) {
  const src = String(html || "");
  const out = [];
  const seen = {};
  const re = /<a[^>]*class="[^"]*stui-vodlist__thumb[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[0];
    const href = tag.match(/href="(\/artdetail-(\d+)\/?)"/) || tag.match(/href="([^"]*\/artdetail-(\d+)[^"]*)"/);
    if (!href) continue;
    const id = href[2];
    if (seen[id]) continue;
    seen[id] = 1;

    const t = tag.match(/title="([^"]{1,200})"/);
    const pic = tag.match(/data-original="([^"]+)"/) || tag.match(/data-src="([^"]+)"/);
    if (!t) continue;

    // 紧跟其后的 span.pic-text 是张数位（站点多为 0P，能取就用）
    const tail = src.substring(m.index, m.index + 800);
    const pt = tail.match(/class="[^"]*pic-text[^"]*"[^>]*>([\s\S]{0,20}?)</);
    let remark = "";
    if (pt) {
      const n = strip(pt[1]).match(/(\d{1,4})\s*P/i);
      if (n && Number(n[1]) > 0) remark = n[1] + "P";
    }

    out.push({
      url: BASE + "/artdetail-" + id + "/",
      id: id,
      title: strip(t[1]),
      pic: abs((pic && pic[1]) || ""),
      remark: remark,
    });
  }
  return out;
}

/** 详情页正文里的图片（每页 1 张） */
function bodyImgs(html) {
  const src = String(html || "");
  const m = src.match(/class="news-content"([\s\S]*?)<div class="(?:share|clearfix|stui)/);
  const body = m ? m[1] : src;
  const out = [];
  const seen = {};
  const re = /<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp|avif)[^"]*)"/gi;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    const u = abs(mm[1].trim());
    if (!u || seen[u]) continue;
    if (/\/static\/|logo|favicon|avatar|\/ico\//i.test(u)) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

/** 图集总页数：分页条里 /artdetail-<id>-<n>/ 的最大 n */
function maxPage(html, id) {
  const src = String(html || "");
  let max = 1;
  const re = new RegExp("/artdetail-" + id + "-(\\d+)/", "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    const n = Number(m[1]) || 0;
    if (n > max) max = n;
  }
  return max;
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

export default class Tb28 extends Spider {
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

  /** 分类清单：从「全部」列表页的导航里取 /arttype/<id>/ */
  async loadCats() {
    if (this.catCache) return this.catCache;
    const html = await this.getHtml(BASE + "/arttype/0/");
    const out = [];
    const seen = {};
    const re = /href="\/arttype\/(\d+)\/"[^>]*>([\s\S]{0,200}?)<\/a>/g;
    let m;
    const used = {};
    while ((m = re.exec(html || "")) !== null) {
      const id = m[1];
      // 分类名里带 ✿ ★ 之类的装饰，去掉；「综合色圖」这种异体字保留原样
      let nm = strip(m[2]).replace(/^[\s✿❀★☆·•*\-]+|[\s✿❀★☆·•*\-]+$/g, "").trim();
      if (!nm || seen[id] || nm.length > 20) continue;
      seen[id] = 1;
      // 站点存在同名分类（如 143 与 154 都叫「日本色图」）→ 后者加序号，便于区分
      let finalName = nm;
      if (used[nm]) {
        used[nm] += 1;
        finalName = nm + " (" + used[nm] + ")";
      } else {
        used[nm] = 1;
      }
      out.push({ id: id, name: finalName });
      if (out.length >= 60) break;
    }
    // 追加隐藏分类（若导航以后补上同名，则跳过避免重复）
    for (const ex of EXTRA_CATS) {
      if (seen[ex.id]) continue;
      seen[ex.id] = 1;
      out.push({ id: ex.id, name: ex.name });
    }
    this.catCache = out;
    return out;
  }

  async homeContent() {
    const cats = await this.loadCats();
    const media = [{ n: "全部", v: "" }];
    for (const c of cats) media.push({ n: c.name, v: "c:" + c.id });

    return {
      class: [
        { type_id: "latest", type_name: "最新" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        latest: [
          { key: "media", name: "分类", value: media },
          { key: "order", name: "排序", value: SORTS.map((x) => ({ n: x.name, v: x.key })) },
        ],
      },
    };
  }

  /** 详情页张数（站点列表里的 pic-text 全是 0P，只能进详情数页数） */
  async picPages(id) {
    const html = await this.getHtml(BASE + "/artdetail-" + id + "-1/");
    if (!html) return 0;
    return maxPage(html, id);
  }

  /** 给前 limit 条补 `NP` 角标（有界 + 硬截止） */
  async fillCounts(cards, limit, deadlineMs) {
    const todo = cards.slice(0, limit);
    const jobs = todo.map((c) => (async () => {
      try {
        const n = await this.picPages(c.id);
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
    // 纯图集站：列表没有张数（站点 pic-text 全 0P）→ 首页前 4 条补抓，给出 NP 角标，
    // 这样卡片才有「图集」按钮、点卡片能直达图集
    if (p === 1 && cards.length) await this.fillCounts(cards, 4, 2500);
    const more = html.indexOf("page=" + (p + 1)) >= 0 || html.indexOf("下一页") >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "latest");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + "/taobao28/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const media = String(ext.media || "");
    let catId = "";
    if (media.indexOf("c:") === 0) catId = media.substring(2);
    else if (ext.sub && String(ext.sub).indexOf("cat:") === 0) catId = String(ext.sub).substring(4);
    else if (t.indexOf("cat:") === 0) catId = t.substring(4);

    const id = catId || "0";
    // 排序：extend.order（App 的 filters 组）→ /artshow-<id>/by/<key>/
    const sortKey = String(ext.order || ext.sort || "time");
    const sort = SORTS.some((x) => x.key === sortKey) ? sortKey : "time";
    // 分类 0 表示「全部」；实测 /artshow-0/by/hits/ 有效
    const url = BASE + "/artshow-" + id + "/by/" + sort + "/" + (p > 1 ? "?page=" + p : "");
    return this.listFrom(url, p);
  }

  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const idm = pageUrl.match(/artdetail-(\d+)/);
    const id = idm ? idm[1] : "";
    const first = await this.getHtml(BASE + "/artdetail-" + id + "-1/");
    if (!first) return { list: [] };

    let title = "";
    const og = first.match(/property="og:title"[^>]*content="([^"]{2,200})"/);
    if (og) title = strip(og[1]);
    if (!title) {
      const h1 = first.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
      if (h1) title = strip(h1[1]);
    }
    if (!title) {
      const tt = first.match(/<title>([^<]*)<\/title>/);
      if (tt) title = strip(tt[1]).split(/[-|_]/)[0].trim();
    }

    const imgs1 = bodyImgs(first);
    const pages = maxPage(first, id);

    // 分类 chips
    const cats = [];
    const seenC = {};
    const reC = /href="\/arttype\/(\d+)\/"[^>]*>([\s\S]{0,200}?)<\/a>/g;
    let m;
    while ((m = reC.exec(first)) !== null) {
      const nm = strip(m[2]);
      if (!nm || seenC[m[1]] || nm.length > 20) continue;
      seenC[m[1]] = 1;
      cats.push({ id: m[1], name: nm });
      if (cats.length >= 4) break;
    }
    const lines = [];
    if (cats.length) lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.id + '"}/]' + x.name + "[/a]").join(" · "));

    const item = {
      vod_id: BASE + "/artdetail-" + id + "-1/",
      vod_name: title || "图集",
      vod_pic: imgs1[0] || "",
      vod_content: lines.join("\n"),
      vod_remarks: pages + "P",          // 张数 = 页数（每页 1 张）
      gallery: true,
      vod_play_from: "tb28",
      vod_play_url: "图集$gal://" + id,
    };

    // 相关推荐：详情页自带的其它图集卡片（实测 28 条）
    const rel = [];
    const seenR = {};
    seenR[id] = 1;
    for (const c of parseCards(first)) {
      if (rel.length >= 8) break;
      if (seenR[c.id]) continue;
      seenR[c.id] = 1;
      rel.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: c.remark || "" });
    }

    return { list: [item].concat(rel) };
  }

  async playerContent(flag, id) {
    throw new Error("这是图集站，请在详情页点「图集」查看");
  }

  async searchContent(key, quick, pg) {
    // 站点没有搜索接口（/artsearch、/search 全 404/500）
    return this.page([], Number(pg) || 1, PAGE_SIZE, 0);
  }

  /** 并发抓 N 页（每页 1 张图），限并发 6 */
  async collectImages(id, pages, deadlineMs) {
    const out = [];
    const seen = {};
    const list = [];
    for (let p = 1; p <= pages; p++) list.push(p);
    const t0 = Date.now();
    const CONC = 6;
    let idx = 0;

    async function worker(sp) {
      while (true) {
        if (Date.now() - t0 > deadlineMs) return;
        const cur = idx++;
        if (cur >= list.length) return;
        const p = list[cur];
        const html = await sp.getHtml(BASE + "/artdetail-" + id + "-" + p + "/");
        if (!html) continue;
        for (const u of bodyImgs(html)) {
          if (seen[u]) continue;
          seen[u] = 1;
          out.push(u);
        }
      }
    }

    const workers = [];
    for (let i = 0; i < CONC; i++) workers.push(worker(this));
    try {
      await Promise.race([Promise.all(workers), new Promise((r) => setTimeout(r, deadlineMs))]);
    } catch (e) { }
    return out;
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];

    // 图集：gal|<id> 或 gal|<页面URL>
    if (s.indexOf("gal|") === 0) {
      let raw = s.substring(4).replace(/^gal:\/\//, "");
      const idm = raw.match(/artdetail-(\d+)/) || raw.match(/^(\d+)$/);
      const id = idm ? idm[1] : "";
      if (!id) return { list: [] };
      const first = await this.getHtml(BASE + "/artdetail-" + id + "-1/");
      const pages = first ? maxPage(first, id) : 1;
      const imgs = await this.collectImages(id, pages, 11000);   // 11 秒硬截止（App 单次 15 秒）
      return { list: imgs.map((u) => ({ url: u })) };
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
