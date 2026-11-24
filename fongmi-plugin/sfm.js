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

// 分类 tab：8 个父类
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
        { type_id: "category", type_name: "分类" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        video: [{ key: "media", name: "入口", value: CHIPS }],
        category: [{ key: "media", name: "分类", value: [{ n: "全部", v: "" }].concat(PARENTS) }],
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

    // 分类 tab：media = 父类；sub = cat:<父类>/<子类>
    let slug = String(ext.media || "");
    const sub = String(ext.sub || "");
    if (sub.indexOf("cat:") === 0) slug = sub.substring(4);

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
