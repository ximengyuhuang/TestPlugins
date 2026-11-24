// 8色人体摄影（8se.me）—— BiliTV / catvod QuickJS 插件
//
// 侦查记录（2026-11-25）
//   站点类型   纯图集站（无视频）
//   卡片       <div class="item photo"> <a href="/photo/id-<hash>.html" title="…">
//              <div class="img" style="background-image:url(…/00001_600x0.webp)">
//              <div class="subs">系列 + Vol</div> <div class="title"><a>标题</a></div>
//              <div class="tags">30P</div>
//   列表       /photos/sort-hot.html（热门） /photos/sort-new.html（最新）
//              /photos/tag/<slug>            标签
//              /photos/series-<hash>.html    套图分类（站点叫「套图分类」，有 parent 分组）
//              每页 24 张
//   分页       ⚠ 路径式：把 .html 换成 /N.html（/photos/sort-hot/2.html）
//              ?page=N 在 sort-hot/tag 上也能用，但首页 / 是聚合页、?page= 无效
//   详情       /photo/id-<hash>.html，一页 18 张缩略图（…_600x0.webp）
//              多页：/photo/id-<hash>/2.html
//              原图：把 _600x0.webp 换成 .jpg（实测 447 KB image/jpeg）
//   搜索       /search.html?keyword=<词>（有效；分页待实测）
//   限流       ⚠ 连续请求会返回 403（实测抓十几个页面后被封一段时间）
//              → 必须串行 + 缓存 + 403 退避；App 侧靠 WebView cookie 时更容易通过
//   入口区块   首页有「套图标签」「最新热门套图」「最新情色套图」「最新秀人套图」
//              「最新扫描/街拍/AI图」「热门AI短剧」「今日热图」「今日热模」

import { Spider, openWeb } from "catvod";

const BASE = "https://8se.me";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;
const CACHE_MS = 5 * 60 * 1000;
const CATALOG_MS = 15 * 60 * 1000;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/",
  };
}

function clean(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function abs(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 名字首字母（A-Z；中文/数字归到 #） */
function headLetter(name) {
  const s = String(name || "").trim();
  if (!s) return "#";
  const c = s.charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

/** 列表页下一页：路径式 —— 把末尾 .html 换成 /N.html */
function pageUrl(url, p) {
  if (p <= 1) return url;
  if (/\.html$/.test(url)) return url.replace(/\.html$/, "/" + p + ".html");
  return url + (url.charAt(url.length - 1) === "/" ? "" : "/") + p + ".html";
}

/** 缩略图 → 原图：…/00001_600x0.webp → …/00001.jpg */
function toFull(img) {
  let s = String(img || "");
  s = s.replace(/_(\d+)x(\d+)\.(?:webp|jpg|jpeg|png)$/i, ".jpg");
  s = s.replace(/_600x0\.webp$/i, ".jpg");
  return s;
}

/** 封面：background-image / data-src / img src 多种写法 */
function pickPic(block, hash) {
  const cands = [];
  const b1 = block.match(/background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  if (b1) cands.push(b1[1]);
  const d1 = block.match(/data-(?:background[_-]image|bg|original|src)="([^"]+)"/);
  if (d1) cands.push(d1[1].split(/[\s,]+/)[0]);
  const i1 = block.match(/<img[^>]+src="([^"]+)"/);
  if (i1) cands.push(i1[1]);
  for (let c of cands) {
    if (!c || c.indexOf("data:") === 0) continue;
    return abs(c.replace(/&quot;/g, "").replace(/&amp;/g, "&"));
  }
  if (hash) return "https://img.xchina.io/photos/" + hash + "/00001_600x0.webp";
  return "";
}

/** 列表卡片 */
function parseCards(html) {
  const src = String(html || "");
  const parts = src.split(/<div class="item[\s"]/).slice(1);
  const out = [];
  const seen = {};
  for (const raw of parts) {
    const block = raw.substring(0, 2500);
    const link = block.match(/href="((?:https:\/\/8se\.me)?\/photo\/id-([0-9a-z]+)\.html)"/i);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;
    seen[url] = 1;
    const hash = link[2];

    let title = "";
    const t1 = block.match(/<a[^>]+title="([^"]{1,80})"/);
    if (t1) title = clean(t1[1]);
    if (!title) {
      const t2 = block.match(/class="title"[^>]*>\s*<a[^>]*>([\s\S]{0,100}?)<\/a>/);
      if (t2) title = clean(t2[1]);
    }
    if (!title) continue;

    // 张数：<div class="tags"><div>30P</div> 或文本里的 30P
    const pm = block.match(/(\d{1,4})\s*P\b/);
    const pics = pm ? Number(pm[1]) : 0;

    // 系列名：.subs 里第一个 <a>
    const sm = block.match(/class="subs"[\s\S]{0,200}?<a[^>]*>([\s\S]{0,40}?)<\/a>/);
    const series = sm ? clean(sm[1]) : "";

    out.push({
      id: url,
      title: title,
      pic: pickPic(block, hash),
      pics: pics,
      series: series,
      hash: hash,
    });
  }
  return out;
}

/** 相册页里的图片（缩略图，之后 toFull 换原图） */
function parseAlbumImgs(html) {
  const src = String(html || "");
  const out = [];
  const seen = {};
  const re = /background-image:\s*url\(\s*['"]?([^'")]+?\.(?:webp|jpg|jpeg|png))['"]?\s*\)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const u = abs(m[1]);
    if (!u || seen[u]) continue;
    if (u.indexOf("img.xchina.io") < 0 && u.indexOf("/photos") < 0) continue;
    seen[u] = 1;
    out.push(u);
  }
  // 兜底：直接出现的图片 URL
  if (!out.length) {
    const re2 = /(https?:\/\/img\.xchina\.io\/[^"'\s)]+?\.(?:webp|jpg|jpeg|png))/gi;
    while ((m = re2.exec(src)) !== null) {
      const u = m[1];
      if (seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
  }
  return out;
}

export default class Se8 extends Spider {
  init() {
    this.cache = {};
    this.catalog = null;
    this.catalogTs = 0;
  }

  // ---------- 请求：串行 + 缓存 + 403 退避（站点会限流）----------
  cacheGet(key) {
    const c = this.cache[key];
    if (c && Date.now() - c.ts < CACHE_MS) return c.html;
    return "";
  }

  async fetch(url, tries) {
    const hit = this.cacheGet(url);
    if (hit) return hit;
    const max = tries === undefined ? 2 : tries;
    // 站点在 Cloudflare 后面：优先带上 WebView 里的 cookie（先开一次「网页」tab 更稳）
    let cookie = "";
    try {
      cookie = this.net.getCookie(BASE + "/") || "";
    } catch (e) {
      cookie = "";
    }
    for (let i = 0; i < max; i++) {
      try {
        const h = hdrs(url);
        if (cookie) h["Cookie"] = cookie;
        const r = await this.net.req(url, { headers: h });
        if (r && r.code === 200 && r.content) {
          this.cache[url] = { html: r.content, ts: Date.now() };
          return r.content;
        }
        if (r && (r.code === 403 || r.code === 429)) {
          await this.sleep(1200 + i * 1500);      // 被限流：退避后再试
          continue;
        }
      } catch (e) {
        await this.sleep(600);
      }
    }
    return "";
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- 目录（分类 / 标签），15 分钟缓存 ----------
  async loadCatalog() {
    if (this.catalog && Date.now() - this.catalogTs < CATALOG_MS) return this.catalog;
    const cats = [];
    const tags = [];
    const seenC = {};
    const seenT = {};

    // 分类：首页「套图分类」区块 + /categories.html 都指向 /photos/series-*
    const input = [BASE + "/", BASE + "/categories.html"];
    for (const u of input) {
      const html = await this.fetch(u);
      if (!html) continue;
      const re = /<a[^>]+href="((?:https:\/\/8se\.me)?\/photos\/series-[^"#?]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const url = abs(m[1]);
        if (seenC[url]) continue;
        const text = clean(m[2]);
        if (!text) continue;
        seenC[url] = 1;
        const c = text.match(/^(.*?)\s*\((\d+)\)/);
        cats.push({ url: url, name: (c ? c[1] : text).trim(), count: c ? Number(c[2]) : 0 });
      }
      // 标签：/photos/tag/<slug>（首页有 name + count 两块）
      // 结构：<a href="/photos/tag/<slug>"><div class="tag-item"><div class="name">名字</div><div class="count">2199</div></div></a>
      const re2 = /href="((?:https:\/\/8se\.me)?\/photos\/tag\/[^"#?]+)"[\s\S]{0,200}?<div class="name">([^<]{1,40})<\/div>\s*<div class="count">(\d+)<\/div>/g;
      while ((m = re2.exec(html)) !== null) {
        const url = abs(m[1]);
        if (seenT[url]) continue;
        seenT[url] = 1;
        tags.push({ url: url, name: clean(m[2]), count: Number(m[3]) || 0 });
      }
      // 标签兜底：href="/photos/tag/xxx">名字<
      if (!tags.length) {
        const re3 = /<a[^>]+href="((?:https:\/\/8se\.me)?\/photos\/tag\/[^"#?]+)"[^>]*>([\s\S]{0,60}?)<\/a>/g;
        while ((m = re3.exec(html)) !== null) {
          const url = abs(m[1]);
          if (seenT[url]) continue;
          const nm = clean(m[2]);
          if (!nm) continue;
          seenT[url] = 1;
          tags.push({ url: url, name: nm, count: 0 });
        }
      }
    }

    cats.sort((a, b) => b.count - a.count);
    tags.sort((a, b) => b.count - a.count);
    this.catalog = { cats: cats, tags: tags };
    this.catalogTs = Date.now();
    return this.catalog;
  }

  // ---------- 首页 ----------
  async homeContent() {
    return {
      class: [
        { type_id: "hot", type_name: "热门" },
        { type_id: "latest", type_name: "最新" },
        { type_id: "categorysearch", type_name: "分类" },
        { type_id: "tagssearch", type_name: "标签" },
        { type_id: "web", type_name: "网页" },
      ],
    };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.id,
      vod_name: c.title,
      vod_pic: c.pic,
      // 图集角标：NP（App 靠它显示「图集」按钮）
      vod_remarks: c.pics ? c.pics + "P" : "图集",
    }));
  }

  async listFrom(url, p) {
    const html = await this.fetch(pageUrl(url, p));
    if (!html) return this.page([], p, PAGE_SIZE, 0);
    const cards = parseCards(html);
    const more = html.indexOf("page=" + (p + 1)) >= 0
      || html.indexOf("/" + (p + 1) + ".html") >= 0
      || html.indexOf("下一页") >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    let t = String(tid || "hot");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 详情页 chips 点进来
    if (t.indexOf("cat:") === 0) { ext.sub = t; t = "categorysearch"; }
    else if (t.indexOf("tag:") === 0) { ext.sub = t; t = "tagssearch"; }

    if (t === "categorysearch") {
      const sub = String(ext.sub || "");
      if (sub.indexOf("cat:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个套图分类（可搜索）", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      return this.listFrom(sub.substring(4), p);
    }

    if (t === "tagssearch") {
      const sub = String(ext.sub || "");
      if (sub.indexOf("tag:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个标签（可搜索）", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      return this.listFrom(sub.substring(4), p);
    }

    if (t === "latest") return this.listFrom(BASE + "/photos/sort-new.html", p);
    return this.listFrom(BASE + "/photos/sort-hot.html", p);
  }

  // ---------- 详情（图集）----------
  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl0 = url.indexOf("http") === 0 ? url : BASE + url;
    const html = await this.fetch(pageUrl0);
    if (!html) return { list: [] };

    let title = "";
    const t = html.match(/<title>([^<]*)<\/title>/);
    if (t) title = clean(t[1]).replace(/\s*-\s*8色人体摄影\s*$/, "").trim();
    const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
    const hashM = pageUrl0.match(/id-([0-9a-z]+)/i);
    const hash = hashM ? hashM[1] : "";
    const poster = og && og[1] ? abs(og[1]) : pickPic(html, hash);

    // 系列（分类）
    const series = [];
    const seenS = {};
    const reS = /href="((?:https:\/\/8se\.me)?\/photos\/series-[^"#?]+)"[^>]*>([\s\S]{0,60}?)<\/a>/g;
    let m;
    while ((m = reS.exec(html)) !== null) {
      const u = abs(m[1]);
      const nm = clean(m[2]);
      if (!nm || seenS[u]) continue;
      seenS[u] = 1;
      series.push({ url: u, name: nm });
      if (series.length >= 4) break;
    }

    // 标签
    const tags = [];
    const seenT = {};
    const reT = /href="((?:https:\/\/8se\.me)?\/photos\/tag\/[^"#?]+)"[^>]*>([\s\S]{0,40}?)<\/a>/g;
    while ((m = reT.exec(html)) !== null) {
      const u = abs(m[1]);
      const nm = clean(m[2]);
      if (!nm || seenT[u]) continue;
      seenT[u] = 1;
      tags.push({ url: u, name: nm });
      if (tags.length >= 12) break;
    }

    const lines = [];
    if (series.length) {
      lines.push(series.map((x) => '[a=cr:{"id":"cat:' + x.url + '"}/]' + x.name + "[/a]").join(" · "));
    }
    if (tags.length) {
      lines.push(tags.map((x) => '[a=cr:{"id":"tag:' + x.url + '"}/]#' + x.name + "[/a]").join(" "));
    }

    const thumbCount = parseAlbumImgs(html).length;

    return {
      list: [{
        vod_id: pageUrl0,
        vod_name: title || "8se",
        vod_pic: poster,
        vod_content: lines.join("\n"),
        vod_remarks: thumbCount ? thumbCount + "P" : "图集",
        gallery: true,
        vod_play_from: "8se",
        vod_play_url: "图集$gal://" + pageUrl0,
      }],
    };
  }

  async playerContent(flag, id) {
    throw new Error("这是图集站，请在详情页点「图集」查看");
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const kw = encodeURIComponent(String(key || ""));
    const url = BASE + "/search.html?keyword=" + kw + (p > 1 ? "&page=" + p : "");
    return this.listFrom(url, 1);
  }

  // ---------- action ----------
  async action(op) {
    const s = String(op || "");
    if (!s) return [];

    // 原生图集：gal|<页面URL>
    if (s.indexOf("gal|") === 0) {
      const u = s.substring(4).replace(/^gal:\/\//, "");
      const pageUrl0 = u.indexOf("http") === 0 ? u : BASE + u;
      const out = [];
      const seen = {};
      for (let p = 1; p <= 20; p++) {
        const html = await this.fetch(pageUrl(p <= 1 ? pageUrl0 : pageUrl(pageUrl0, p)));
        if (!html) break;
        const imgs = parseAlbumImgs(html);
        let added = 0;
        for (const img of imgs) {
          const full = toFull(img);
          if (seen[full]) continue;
          seen[full] = 1;
          out.push({ url: full });
          added++;
        }
        if (added === 0) break;
      }
      return { list: out };
    }

    // 侧边栏：热门分类 + 热门标签
    if (s === "side|") {
      const groups = [];
      const cat = await this.loadCatalog();
      if (cat.cats.length) {
        groups.push({
          name: "热门套图分类",
          facet: "categorysearch",
          items: cat.cats.slice(0, 24).map((c) => ({
            name: c.name, count: c.count ? String(c.count) : "", id: "cat:" + c.url,
          })),
        });
      }
      if (cat.tags.length) {
        groups.push({
          name: "热门标签",
          facet: "tagssearch",
          items: cat.tags.slice(0, 24).map((t) => ({
            name: t.name, count: t.count ? String(t.count) : "", id: "tag:" + t.url,
          })),
        });
      }
      return { groups: groups };
    }

    // 分类面板
    if (s.indexOf("facet|category|") === 0 || s.indexOf("facet|categories|") === 0) {
      const prefix = s.indexOf("facet|categories|") === 0 ? "facet|categories|" : "facet|category|";
      const rest = s.substring(prefix.length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      const cat = await this.loadCatalog();
      return this.facetPage(cat.cats, kw, page, "cat:");
    }

    // 标签面板
    if (s.indexOf("facet|tags|") === 0) {
      const rest = s.substring("facet|tags|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      const cat = await this.loadCatalog();
      return this.facetPage(cat.tags, kw, page, "tag:");
    }

    return [];
  }

  facetPage(list, kw, page, prefix) {
    const letter = kw.indexOf("^") === 0 ? kw.substring(1).toUpperCase() : "";
    const hit = letter
      ? list.filter((x) => headLetter(x.name) === letter)
      : (kw ? list.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0) : list);
    const PAGE = 100;
    const from = (page - 1) * PAGE;
    return {
      items: hit.slice(from, from + PAGE).map((x) => ({
        id: prefix + x.url,
        name: x.name,
        count: x.count ? String(x.count) : "",
      })),
    };
  }
}
