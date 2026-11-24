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

// 旧版硬编码父类（现在分类走 REST API 全量，仅保留做兜底）
const PARENTS = [
  { n: "Overwatch", v: "overwatch" },
  { n: "英雄联盟", v: "league-of-legend" },
  { n: "Marvel", v: "marvel" },
  { n: "DC", v: "dc" },
  { n: "绝区零", v: "zenless-zone-zero" },
  { n: "街霸", v: "street-fighter" },
  { n: "GTA", v: "grand-theft-auto" },
  { n: "生化危机", v: "resident-evil" },
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
function feedUrl(chip, p) {
  const pg = p > 1 ? "/page/" + p + "/" : "/";
  if (chip === "top") return BASE + "/tag/sound/" + (p > 1 ? "page/" + p + "/" : "") + "?order=most_views";
  if (chip === "trending") return BASE + pg + "?filter-by=trending";
  if (chip === "sound") return BASE + "/tag/sound/" + (p > 1 ? "page/" + p + "/" : "");
  if (chip === "long") return BASE + "/tag/" + LONG_TAG + "/" + (p > 1 ? "page/" + p + "/" : "");
  return BASE + pg;                       // 最新
}

/** 分类 tab 的 URL：父类 或 父类/子类 */
function catUrl(slug, p) {
  if (!slug) return BASE + "/";
  return BASE + "/category/" + slug + "/" + (p > 1 ? "page/" + p + "/" : "");
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
    const poster = seg.match(/data-poster-image="([^"]+)"/) || seg.match(/data-poster-webp="([^"]+)"/);
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
  const m = t.match(/<source[^>]*src="([^"]+\.mp4[^"]*)"/) || t.match(/<video[^>]*\ssrc="([^"]+\.mp4[^"]*)"/);
  return m ? decode(m[1]) : "";
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
        { type_id: "categorysearch", type_name: "分类" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        video: [{ key: "media", name: "入口", value: CHIPS }],
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

      const html = await this.getHtml(feedUrl(chip, p));
      return this.fromHtml(html, p);
    }

    // 分类 tab（搜索面板）：选中值在 extend.sub，形如 cat:<slug>
    const sub = String(ext.sub || "");
    if (sub.indexOf("cat:") !== 0) {
      return this.page([{ vod_id: "", vod_name: "在上方选一个分类（可搜索）", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
    }
    const slug = sub.substring(4);
    this.lastCat = slug;                       // 记住当前分类，二级 chips 要用
    const html = await this.getHtml(catUrl(slug, p));
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

    // 相关推荐：详情页其它帖子
    const rel = [];
    const seen = {};
    seen[url] = 1;
    const reRel = /<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a href="([^"]+)"/g;
    let rm;
    while ((rm = reRel.exec(html)) !== null) {
      const u = decode(rm[1]);
      if (seen[u]) continue;
      seen[u] = 1;
      const seg = html.substring(rm.index, rm.index + 1200);
      const t2 = seg.match(/rel="bookmark"[^>]*>([\s\S]{0,160}?)<\/a>/);
      const p2 = seg.match(/data-poster-image="([^"]+)"/);
      const c2 = seg.match(/class="entry-category[^"]*"[^>]*>([^<]{1,24})</);
      rel.push({
        vod_id: u,
        vod_name: strip(t2 ? t2[1] : "") || u,
        vod_pic: p2 ? decode(p2[1]) : "",
        vod_remarks: c2 ? strip(c2[1]) + "|" : "",
      });
      if (rel.length >= 8) break;
    }

    return { list: [item].concat(rel) };
  }

  /** 三级 chips：父类 → 子类 */
  async action(op) {
    if (!op) return [];
    if (op.indexOf("gal|") === 0) return { list: [] };

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

    // 选中某个顶层分类后，把它的子类作为二级 chips 返回
    if (op === "sub|categorysearch" || op.indexOf("sub|categorysearch|") === 0) {
      const cur = this.lastCat || "";
      if (!cur || cur.indexOf("/") >= 0) return [];      // 已经在子类里了，不再往下钻
      const kids = await this.kidsOf(cur);
      return kids.map((k) => ({ name: k.name, value: "cat:" + k.path }));
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
    if (raw.indexOf(".mp4") > 0) return { parse: 0, url: raw, header: header };

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
