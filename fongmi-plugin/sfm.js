// SFM Compile（sfmcompile.club）—— BiliTV / catvod QuickJS 插件
//
// 站点结构（2026-11-24 侦查）
//   ── 站点自己的导航（截图核对过，feedback/theporndude 不算分类）──
//     Top Animations  /tag/sound/?order=most_views
//     Trending        /?filter-by=trending
//     Overwatch       /category/overwatch/   （下挂 17 个角色子类）
//     Sound           /tag/sound
//     Longer Clips    /tag/20secs,30secs+,1min+,2mins+,3mins+,4mins+,5mins+,9mins+/
//     All-Category    /all-category/         （99 个分类，两级）
//     Random          /?redirect_to=random   （302 到随机帖子）
//
//   分页：列表 /page/N/ ；标签 /tag/<x>/page/N/ ；排序 /page/N/?filter-by=trending
//   搜索：/?s=<kw>，分页 /page/N/?s=
//   详情：/<slug>/  → <video … src="…mp4">  直链，parse 0
//
// 卡片（两种模板都要认）：文章里已经带齐 poster + mp4，不用抓详情
//   <article id="post-1" class="… entry-tpl-stream|entry-tpl-grid-fancy … category-juno category-overwatch …">
//     <h2 class="…entry-title…"><a href="…/<slug>/" rel="bookmark">标题</a></h2>
//     <video … data-poster-image="…/xxx-608x342.jpg"><source src="…/xxx.mp4">
//     <a class="entry-category" href="…/category/overwatch/juno/">Juno</a>

import { Spider, openWeb } from "catvod";

const BASE = "https://sfmcompile.club";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 13;
const LONG_TAG = "20secs,30secs+,1min+,2mins+,3mins+,4mins+,5mins+,9mins+";

// 视频 tab：对齐站点导航
const CHIPS = [
  { n: "最新", v: "" },
  { n: "TOP动画", v: "top" },
  { n: "热门", v: "trending" },
  { n: "声音", v: "sound" },
  { n: "长视频", v: "long" },
  { n: "随机", v: "random" },
];

// 分类 chips：严格按站点文章数取前 16（Others 也保留，顺序即排行）
// 数据来源：/wp-json/wp/v2/categories?per_page=100&page=1..N 里的 count 字段
const PARENTS = [
  { n: "Overwatch", v: "overwatch" },              // 8144
  { n: "Final Fantasy", v: "final-fantasy" },      // 3009
  { n: "Fortnite", v: "fortnite" },                // 2356
  { n: "Resident Evil", v: "resident-evil" },      // 2326
  { n: "Marvel", v: "marvel" },                    // 2106
  { n: "英雄联盟", v: "league-of-legend" },         // 2076
  { n: "Others", v: "others-2" },                  // 1960
  { n: "Dead Or Alive", v: "dead-or-alive" },      // 1591
  { n: "DC Comics", v: "dc" },                     // 1313
  { n: "Nier", v: "nier" },                        // 1192
  { n: "Street Fighter", v: "street-fighter" },    // 1188
  { n: "Genshin Impact", v: "genshin-impact" },    // 960
  { n: "Cyberpunk 2077", v: "cyberpunk-2077" },    // 738
  { n: "绝区零", v: "zenless-zone-zero" },          // 624
  { n: "Witcher", v: "witcher" },                  // 591
  { n: "Lara Croft", v: "lara-croft" },            // 577
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
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

function strip(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** 视频 tab 的入口 → URL（p 为页码） */
function feedUrl(chip, p, sort) {
  const pg = p > 1 ? "/page/" + p + "/" : "/";
  const mk = (tagPath, defSort) => {
    const base = BASE + tagPath + (p > 1 ? "page/" + p + "/" : "");
    const o = sort || defSort || "";
    return o ? base + "?order=" + o : base;
  };
  if (chip === "top") return mk("/tag/sound/", "most_views");
  if (chip === "trending") return BASE + pg + "?filter-by=trending";     // 该页不支持排序
  if (chip === "sound") return mk("/tag/sound/", "");
  if (chip === "long") return mk("/tag/" + LONG_TAG + "/", "");
  return BASE + pg;                                                       // 最新（不支持排序）
}

/** 分类 tab 的 URL：父类 或 父类/子类，可带排序（?order=most_views） */
function catUrl(slug, p, sort) {
  if (!slug) return BASE + "/";
  const base = BASE + "/category/" + slug + "/" + (p > 1 ? "page/" + p + "/" : "");
  return sort ? base + "?order=" + sort : base;
}

/** 解析卡片（两种模板都按 <article 切块） */
function parseCards(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const marks = [];
  const reArt = /<article\s/g;
  let m;
  while ((m = reArt.exec(text)) !== null) marks.push(m.index);

  for (let i = 0; i < marks.length; i++) {
    const seg = text.substring(marks[i], i + 1 < marks.length ? marks[i + 1] : marks[i] + 6000);

    const link = seg.match(/<a href="(https:\/\/sfmcompile\.club\/[^"\/]+\/)"[^>]*rel="bookmark"/) ||
      seg.match(/class="[^"]*entry-title[^"]*"[^>]*>\s*<a href="([^"]+)"/);
    if (!link) continue;
    const url = decode(link[1]);
    if (/\/(category|tag|page|author|wp-[a-z]+|feed|all-category|feedback|register|snax_collection)\//.test(url)) continue;
    if (seen[url]) continue;
    seen[url] = 1;

    const title = seg.match(/<a href="[^"]+" rel="bookmark"[^>]*>([\s\S]{0,200}?)<\/a>/);
    // 封面有两种：带视频的卡片用 data-poster-image / data-poster-webp；
    // 另一批卡片没有视频标记，只有普通 <img src="…uploads/xxx.jpg">
    const poster = seg.match(/data-poster-image="([^"]+)"/) ||
      seg.match(/data-poster-webp="([^"]+)"/) ||
      // 老帖（2019~2020 那批）用普通 poster 属性
      seg.match(/<video[^>]*\sposter="([^"]+\.(?:jpg|jpeg|png|webp))"/i) ||
      seg.match(/<img[^>]*src="(https:\/\/sfmcompile\.club\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);
    const cat = seg.match(/class="entry-category[^"]*"[^>]*>([^<]{1,24})</);

    out.push({
      vod_id: url,
      vod_remarks: cat ? strip(cat[1]) + "|" : "",
      vod_name: strip(title ? title[1] : "") || url,
      vod_pic: poster ? decode(poster[1]) : "",
    });
  }
  return out;
}

/** 详情页里的 mp4 */
function parsePlay(html) {
  const t = String(html || "");
  // 新帖是 .mp4，老帖（2019~2020）是 .m4v —— 两种都要认
  const m = t.match(/<source[^>]*src="([^"]+\.(?:mp4|m4v|webm)[^"]*)"/) ||
    t.match(/<video[^>]*\ssrc="([^"]+\.(?:mp4|m4v|webm)[^"]*)"/);
  return m ? decode(m[1]) : "";
}

/** slug → 可读名（final-fantasy → Final Fantasy） */
function prettySlug(slug) {
  return String(slug || "")
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
    .join(" ")
    .trim();
}

export default class Sfm extends Spider {
  init() {
    this.cache = {};
  }

  async getHtml(url) {
    const c = this.cache[url];
    if (c && Date.now() - c.ts < 180000) return c.html;
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) {
        this.cache[url] = { html: r.content, ts: Date.now() };
        return r.content;
      }
    } catch (e) { }
    return "";
  }

  async homeContent() {
    return {
      // 分类 tab 选中父类后，App 用 action("sub|<父类slug>") 取子类
      subFromTab: true,
      class: [
        { type_id: "video", type_name: "视频" },
        { type_id: "category", type_name: "分类" },
        { type_id: "categorysearch", type_name: "全部分类" },
        { type_id: "tagsearch", type_name: "标签" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        video: [
          { key: "media", name: "入口", value: CHIPS },
          // 声音 / 长视频 本质是 tag 页，支持 ?order=；最新/热门不支持，切到它们时排序会被忽略
          {
            key: "order",
            name: "排序",
            value: [
              { n: "最新", v: "" },
              { n: "最旧", v: "oldest" },
              { n: "最多播放", v: "most_views" },
            ],
          },
        ],
        // 标签页支持 ?order=most_views（首页/搜索页不支持，所以只给标签加）
        tagsearch: [
          {
            key: "order",
            name: "排序",
            // 站点下拉框的三个值：newest(默认) / oldest / most_views
            value: [
              { n: "最新", v: "" },
              { n: "最旧", v: "oldest" },
              { n: "最多播放", v: "most_views" },
            ],
          },
        ],
        // 分类 tab：一排父类 chips + 排序（站点支持 ?order=most_views）
        category: [
          { key: "media", name: "分类", value: [{ n: "全部", v: "" }].concat(PARENTS) },
          {
            key: "order",
            name: "排序",
            // 站点下拉框的三个值：newest(默认) / oldest / most_views
            value: [
              { n: "最新", v: "" },
              { n: "最旧", v: "oldest" },
              { n: "最多播放", v: "most_views" },
            ],
          },
        ],
      },
    };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "video");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 视频 tab
    if (t === "video") {
      const chip = String(ext.media || "");
      if (chip === "random") return this.randomCards();

      const html = await this.getHtml(feedUrl(chip, p, String(ext.order || "")));
      return this.fromHtml(html, p);
    }

    // 标签面板：选中值 tag:<slug> → /tag/<slug>/
    const subRaw = String(ext.sub || "");
    if (t === "tagsearch") {
      if (subRaw.indexOf("tag:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个标签（可搜索）", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      const tslug = subRaw.substring(4);
      const sort = String(ext.order || "");
      const tbase = BASE + "/tag/" + tslug + "/" + (p > 1 ? "page/" + p + "/" : "");
      const turl = sort ? tbase + "?order=" + sort : tbase;
      return this.fromHtml(await this.getHtml(turl), p);
    }

    // 「全部分类」面板：选中值在 extend.sub，形如 cat:<父类/子类>
    const sub = String(ext.sub || "");
    if (t === "categorysearch") {
      if (sub.indexOf("cat:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个分类（可搜索）", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      const html = await this.getHtml(catUrl(sub.substring(4), p));
      return this.fromHtml(html, p);
    }

    // 分类 tab：media = 父类；选了角色时 sub = cat:<父类>/<角色>；order = 排序
    let slug = String(ext.media || "");
    if (sub.indexOf("cat:") === 0) slug = sub.substring(4);

    const html = await this.getHtml(catUrl(slug, p, String(ext.order || "")));
    return this.fromHtml(html, p);
  }

  fromHtml(html, p) {
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));
    const cards = parseCards(html);
    const n = p + 1;
    const more = html.indexOf("/page/" + n + "/") >= 0 || html.indexOf("page/" + n) >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  /** 随机：/?redirect_to=random 是 302，用 redirect:0 读 Location */
  async randomCards() {
    const cards = [];
    const seen = {};
    for (let i = 0; i < 4 && cards.length < 3; i++) {
      let loc = "";
      try {
        const r = await this.net.req(BASE + "/?redirect_to=random", { headers: hdrs(), redirect: 0 });
        const h = (r && r.headers) || {};
        for (const k of Object.keys(h)) {
          if (String(k).toLowerCase() === "location") loc = String(h[k] || "");
        }
      } catch (e) { }
      if (!loc) continue;
      const url = loc.indexOf("http") === 0 ? loc : BASE + loc;
      if (seen[url]) continue;
      seen[url] = 1;

      const html = await this.getHtml(url);
      if (!html) continue;
      const one = parseCards(html).filter((x) => x.vod_id === url);
      if (one.length) {
        cards.push(one[0]);
      } else {
        const t = html.match(/<title>([^<]*)<\/title>/);
        const p2 = html.match(/data-poster-image="([^"]+)"/);
        cards.push({
          vod_id: url,
          vod_name: strip(t ? t[1] : "") || url,
          vod_pic: p2 ? decode(p2[1]) : "",
          vod_remarks: "",
        });
      }
    }
    return this.page(cards, 1, PAGE_SIZE, cards.length);
  }

  /**
   * 全量分类：WP REST API（实测 300 个 = 顶层 96 + 子类 204）
   * 每项算出 path（父类/子类），分类页地址是 /category/<path>/
   */
  async loadCats() {
    if (this.cats && this.cats.length) return this.cats;

    const raw = [];
    try {
      for (let page = 1; page <= 6; page++) {
        const r = await this.net.req(BASE + "/wp-json/wp/v2/categories?per_page=100&page=" + page, {
          headers: { "User-Agent": UA, "Accept": "application/json,*/*", "Referer": BASE + "/" },
        });
        if (!r || r.code !== 200) break;
        let arr = null;
        try { arr = JSON.parse(r.content); } catch (e) { arr = null; }
        if (!arr || !arr.length) break;
        for (const c of arr) {
          if (!c || !c.slug) continue;
          raw.push({ id: c.id, slug: c.slug, name: c.name || c.slug, count: c.count || 0, parentId: c.parent || 0 });
        }
        if (arr.length < 100) break;
      }
    } catch (e) { }

    const byId = {};
    for (const c of raw) byId[c.id] = c;
    for (const c of raw) {
      const parent = c.parentId ? byId[c.parentId] : null;
      c.path = parent ? parent.slug + "/" + c.slug : c.slug;
      c.parentSlug = parent ? parent.slug : "";
    }
    // 顶层按文章数排，子类挂在父类下
    const tops = raw.filter((c) => !c.parentId).sort((a, b) => (b.count || 0) - (a.count || 0));
    for (const t of tops) {
      t.kids = raw.filter((c) => c.parentId === t.id).sort((a, b) => (b.count || 0) - (a.count || 0));
    }
    const out = [];
    for (const t of tops) {
      out.push(t);
      for (const k of t.kids) out.push(k);
    }
    if (out.length) this.cats = out;
    if (tops.length) this.tops = tops;
    return out;
  }

  /** 全量标签：WP REST API（700 个，按文章数排序） */
  async loadTags() {
    if (this.tags && this.tags.length) return this.tags;
    const out = [];
    try {
      for (let page = 1; page <= 8; page++) {
        const r = await this.net.req(BASE + "/wp-json/wp/v2/tags?per_page=100&page=" + page, {
          headers: { "User-Agent": UA, "Accept": "application/json,*/*", "Referer": BASE + "/" },
        });
        if (!r || r.code !== 200) break;
        let arr = null;
        try { arr = JSON.parse(r.content); } catch (e) { arr = null; }
        if (!arr || !arr.length) break;
        for (const t of arr) {
          if (!t || !t.slug) continue;
          out.push({ slug: t.slug, name: t.name || t.slug, count: t.count || 0 });
        }
        if (arr.length < 100) break;
      }
    } catch (e) { }
    out.sort((a, b) => (b.count || 0) - (a.count || 0));
    if (out.length) this.tags = out;
    return out;
  }

  /** 顶层分类（面板只列顶层，子类在选中后作为二级 chips 出现） */
  async loadTops() {
    await this.loadCats();
    return this.tops || [];
  }

  /** 某个父类的子类 */
  async kidsOf(parentPath) {
    await this.loadCats();
    const tops = this.tops || [];
    for (const t of tops) if (t.path === parentPath) return t.kids || [];
    return [];
  }

  async detailContent(ids) {
    const url = String(ids[0] || "");
    const html = await this.getHtml(url);
    if (!html) return { list: [] };

    let title = "";
    const h1 = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]{0,200}?)<\/h1>/) ||
      html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
    if (h1) title = strip(h1[1]);
    if (!title) {
      const t = html.match(/<title>([^<]*)<\/title>/);
      if (t) title = strip(t[1]).replace(/\s*\|\s*SFM.*$/, "").trim();
    }

    const poster = html.match(/data-poster-image="([^"]+)"/) ||
      html.match(/property="og:image"[^>]*content="([^"]+)"/);

    // 分类做成可点 chips（子类在前，父类在后）
    const cats = [];
    const seenCat = {};
    const reCat = /href="https:\/\/sfmcompile\.club\/category\/([^"]+)\/"[^>]*>([^<]{1,24})</g;
    let cm;
    while ((cm = reCat.exec(html)) !== null) {
      const slug = cm[1];
      if (seenCat[slug]) continue;
      seenCat[slug] = 1;
      cats.push({ slug: slug, name: strip(cm[2]) });
      if (cats.length >= 5) break;
    }
    const lines = [];
    if (cats.length) {
      lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.slug + '"}/]' + x.name + "[/a]").join(" · "));
    }

    const play = parsePlay(html);
    const item = {
      vod_id: url,
      vod_name: title || url,
      vod_pic: poster ? decode(poster[1]) : "",
      vod_content: lines.join("\n"),
      vod_remarks: cats.length ? cats[cats.length - 1].name + "|" : "",
      gallery: false,
      vod_play_from: "SFM",
      vod_play_url: play ? "正片$" + play : "网页查看$web://" + url,
    };

    // 相关推荐：详情页右侧「More From: <角色>」区块
    //   卡片结构：<article class="entry-tpl-grid … category-juno …">
    //     <a title="标题" class="g1-frame" href="…/slug/">
    //     <img … src="data:image/svg+xml…" data-src="…uploads/xxx.jpg">   ← 懒加载，src 是占位符
    const rel = [];
    const seen = {};
    seen[url] = 1;

    const mIdx = html.indexOf("g1-more-from");
    const region = mIdx > 0 ? html.substring(mIdx) : html;

    const marks = [];
    const reArt = /<article\s/g;
    let am;
    while ((am = reArt.exec(region)) !== null) marks.push(am.index);

    for (let i = 0; i < marks.length && rel.length < 8; i++) {
      const seg = region.substring(marks[i], i + 1 < marks.length ? marks[i + 1] : marks[i] + 4000);

      const link = seg.match(/<a[^>]*href="(https:\/\/sfmcompile\.club\/[^"\/]+\/)"/);
      if (!link) continue;
      const u = decode(link[1]);
      if (seen[u]) continue;
      seen[u] = 1;

      // 标题：优先 a 的 title 属性，其次 alt
      const tAttr = seg.match(/<a[^>]*\stitle="([^"]{2,120})"/) || seg.match(/<img[^>]*\salt="([^"]{2,120})"/);
      // 封面：懒加载在 data-src / data-src-webp，src 是 data:image 占位
      const cov = seg.match(/data-src="(https:[^"]+\.(?:jpg|jpeg|png|webp))"/i) ||
        seg.match(/data-src-webp="(https:[^"]+\.(?:jpg|jpeg|png|webp))"/i) ||
        seg.match(/srcset="(https:[^\s"]+\.(?:jpg|jpeg|png|webp))/i);
      // 角标：取 article class 里的 category-xxx（第一个通常是角色）
      const cat = seg.match(/\scategory-([a-z0-9\-]+)/);

      rel.push({
        vod_id: u,
        vod_name: tAttr ? decode(tAttr[1]) : u,
        vod_pic: cov ? decode(cov[1]) : "",
        vod_remarks: cat ? prettySlug(cat[1]) + "|" : "",
      });
    }

    return { list: [item].concat(rel) };
  }

  /** 三级 chips：父类 → 子类 */
  async action(op) {
    if (!op) return [];
    if (op.indexOf("gal|") === 0) return { list: [] };

    // 标签面板：WP REST API（实测 700 个标签，带文章数）
    if (op.indexOf("facet|tags|") === 0) {
      const rest = op.substring("facet|tags|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      const all = await this.loadTags();
      const hit = kw
        ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0 || x.slug.toLowerCase().indexOf(kw) >= 0)
        : all;
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => ({
          id: "tag:" + x.slug,
          name: x.name,
          count: x.count ? x.count + " 部" : "",
        })),
      };
    }

    // 分类面板：WP REST API 一次拿全（顶层 41 + 子类 59），带文章数
    if (op.indexOf("facet|category|") === 0 || op.indexOf("facet|categories|") === 0) {
      const prefix = op.indexOf("facet|categories|") === 0 ? "facet|categories|" : "facet|category|";
      const rest = op.substring(prefix.length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

      // 有搜索词 → 全量（含子类，方便直接找 Tifa/Kiriko）；没搜索词 → 只列顶层
      const all = await this.loadCats();
      const hit = kw
        ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0 || x.path.toLowerCase().indexOf(kw) >= 0)
        : (this.tops || []);
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => {
          const kids = (x.kids || []).length;
          const nm = x.parentSlug ? (x.parentSlug + " · " + x.name) : x.name;
          return {
            id: "cat:" + x.path,
            name: nm,
            count: x.count ? x.count + " 部" + (kids ? " · " + kids + " 角色" : "") : "",
          };
        }),
      };
    }

    if (op.indexOf("sub|") === 0) {
      const parent = op.substring(4).trim();
      if (!parent) return [];

      const html = await this.getHtml(BASE + "/category/" + parent + "/");
      const out = [];
      const seen = {};
      const reSub = new RegExp('href="https://sfmcompile\\.club/category/' + parent + '/([^"/]+)/"[^>]*>([^<]{1,24})<', "g");
      let m;
      while ((m = reSub.exec(html || "")) !== null) {
        const slug = m[1];
        if (seen[slug]) continue;
        seen[slug] = 1;
        const nm = strip(m[2]);
        if (!nm) continue;
        out.push({ name: nm, value: "cat:" + parent + "/" + slug });
      }
      return out;
    }
    return [];
  }

  async playerContent(flag, id) {
    const raw = String(id);
    const header = { "User-Agent": UA, "Referer": BASE + "/" };
    // 直链（新帖 .mp4 / 老帖 .m4v / 少量 .webm）
    if (/\.(?:mp4|m4v|webm)(?:$|\?)/i.test(raw)) return { parse: 0, url: raw, header: header };

    const html = await this.getHtml(raw);
    const play = html ? parsePlay(html) : "";
    if (!play) throw new Error("没找到播放地址");
    return { parse: 0, url: play, header: header };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const kw = encodeURIComponent(key);
    const url = p > 1 ? BASE + "/page/" + p + "/?s=" + kw : BASE + "/?s=" + kw;
    return this.fromHtml(await this.getHtml(url), p);
  }
}
