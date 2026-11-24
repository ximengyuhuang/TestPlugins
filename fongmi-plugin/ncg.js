// NudeCosplayGirls（nudecosplaygirls.com）—— BiliTV / catvod QuickJS 插件
//
// 站点：WordPress + Bimber(g1) 主题，混合站（视频 + 图集），部分帖子两者都有
//
// 侦查结论（2026-11-24）
//   列表   /  、/page/N/                       15 张卡片
//   分类   /category/<slug>/ 、/page/N/        Videos(696) Albums(2399) Top(312) Hot(3217)
//          另有 ~318 个模特分类（/category/helly-valentine/ 这种）
//   标签   /tag/<slug>/ 、/page/N/             600 个
//   排序   /category/x/?order=most_views|oldest   ✅ 生效
//          首页 /?order=… ❌ 不生效（实测首条不变）
//   搜索   /?s=<kw>、/page/N/?s=<kw>
//   详情   /<slug>/  → <video src="…mp4"> + 正文 <figure class="wp-block-image"><img class="wp-image-N">
//          article class 里 format-video / format-standard 能区分视频帖和图集帖
//   相关   <aside class="g1-more-from">（同 SFM，取到 </aside> 为止）
//   接口   /wp-json/wp/v2/categories|tags?per_page=100&page=N ✅（拿全量分类/标签）

import { Spider, openWeb } from "catvod";

const BASE = "https://nudecosplaygirls.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 15;

// 四个主分类（导航里的），其余 318 个都是模特
const MAIN_CATS = [
  { slug: "nude-cosplay-videos", name: "Videos" },
  { slug: "nude-cosplay-albums", name: "Albums" },
  { slug: "nude-cosplay", name: "Top Cosplayers" },
  { slug: "nude-cosplayers", name: "Hot Cosplayers" },
];
const MAIN_SLUGS = MAIN_CATS.map((x) => x.slug);

const CHIPS = [
  { n: "全部", v: "" },
  { n: "Videos", v: "nude-cosplay-videos" },
  { n: "Albums", v: "nude-cosplay-albums" },
  { n: "Top Cosplayers", v: "nude-cosplay" },
  { n: "Hot Cosplayers", v: "nude-cosplayers" },
];

const ORDERS = [
  { n: "最新", v: "" },
  { n: "最旧", v: "oldest" },
  { n: "最多播放", v: "most_views" },
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

function prettySlug(slug) {
  return String(slug || "").split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
    .join(" ").trim();
}

/** 尺寸后缀（-364x205.jpg / -952x1024.jpg），图集要的是同前缀里最大的那张 */
const SIZE_RE = /-(\d{2,4})x(\d{2,4})(\.(?:jpg|jpeg|png|webp))$/i;

function baseKey(u) {
  return String(u).replace(SIZE_RE, "$3");
}

function picArea(u) {
  const m = String(u).match(SIZE_RE);
  return m ? Number(m[1]) * Number(m[2]) : 1e12;   // 无后缀 = 原图，优先级最高
}
/** 站点水印图，不算图集内容 */
const WATERMARK = /18plus300\.(?:png|jpg)/i;

function isRealPic(u) {
  if (!u || u.indexOf("/wp-content/uploads/") < 0) return false;
  return !WATERMARK.test(u);
}

/** 列表卡片：<article class="… post-N … format-video … category-x …"> */
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

    const link = seg.match(/<a[^>]*title="([^"]{2,160})"[^>]*class="g1-frame"[^>]*href="([^"]+)"/) ||
      seg.match(/<a[^>]*href="(https:\/\/nudecosplaygirls\.com\/[^"\/]+\/)"[^>]*title="([^"]{2,160})"/);
    if (!link) continue;
    let url, title;
    if (link[2] && link[2].indexOf("http") === 0) {
      title = link[1]; url = link[2];
    } else {
      url = link[1]; title = link[2];
    }
    url = decode(url);
    if (seen[url]) continue;
    seen[url] = 1;

    const pic = seg.match(/<img[^>]*src="(https:\/\/nudecosplaygirls\.com\/wp-content\/uploads\/[^"]+)"/);
    // 分类：取正文里第一个 entry-category（列表卡片里通常只有一个）
    const cat = seg.match(/class="entry-category[^"]*"[^>]*>([^<]{1,40})</);
    const isVideo = /\sformat-video\s/.test(seg.substring(0, 400));

    out.push({
      vod_id: url,
      vod_name: strip(title) || url,
      vod_pic: pic ? decode(pic[1]) : "",
      // 先给个粗角标，后面再用详情页的 P/V 数量覆盖
      vod_remarks: (cat ? strip(cat[1]) + "|" : "") + (isVideo ? "1V" : ""),
      kindVideo: isVideo,
    });
  }
  return out;
}

/** 详情页：视频列表 + 图集图片 */
function parseDetail(html) {
  const text = String(html || "");

  // 视频：<video … src="…mp4"> 或 <source src>
  const vids = [];
  const seenV = {};
  const reV = /<video[^>]*\ssrc="([^"]+\.(?:mp4|m4v|webm)[^"]*)"|<source[^>]*src="([^"]+\.(?:mp4|m4v|webm)[^"]*)"/gi;
  let vm;
  while ((vm = reV.exec(text)) !== null) {
    const u = decode(vm[1] || vm[2] || "");
    if (!u || seenV[u]) continue;
    seenV[u] = 1;
    vids.push(u);
  }

  // 图集：正文区（entry-inner → entry-tags）里的 wp-block-image
  let imgs = [];
  const i0 = text.indexOf("entry-inner");
  if (i0 > 0) {
    const i1 = text.indexOf("entry-tags", i0);
    const seg = text.substring(i0, i1 > i0 ? i1 : i0 + 120000);
    const seen = {};
    // 注意顺序不定：有的 <img class="wp-image-1" src="…">，有的 src 在前 →
    // 先切出整个 <img> 标签，再分别取 class 和 src
    const reTag = /<img\b[^>]*>/gi;
    let im;
    while ((im = reTag.exec(seg)) !== null) {
      const tag = im[0];
      if (!/class="[^"]*wp-image-\d+/.test(tag)) continue;
      const sm = tag.match(/\ssrc="([^"]+)"/);
      if (!sm) continue;
      const u = decode(sm[1]);
      if (!isRealPic(u) || seen[u]) continue;
      seen[u] = 1;
      imgs.push(u);
    }
    // 兜底：没有 wp-image 类时，取正文里的 uploads 图
    if (!imgs.length) {
      const re2 = /<img[^>]*src="(https:\/\/nudecosplaygirls\.com\/wp-content\/uploads\/[^"]+)"/g;
      while ((im = re2.exec(seg)) !== null) {
        const u = decode(im[1]);
        if (!isRealPic(u) || seen[u]) continue;
        seen[u] = 1;
        imgs.push(u);
      }
    }

    // 同一张图会有多个尺寸（-952x1024 / -364x205 …）→ 按前缀归并，取最大的一张
    const best = {};
    for (const u of imgs) {
      const k = baseKey(u);
      if (!best[k] || picArea(u) > picArea(best[k])) best[k] = u;
    }
    imgs = Object.keys(best).map((k) => best[k]);
  }
  return { videos: vids, images: imgs };
}

export default class Ncg extends Spider {
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
      class: [
        { type_id: "latest", type_name: "最新" },
        { type_id: "cosplayersearch", type_name: "模特" },
        { type_id: "tagsearch", type_name: "标签" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        latest: [
          { key: "media", name: "内容", value: CHIPS },
          // 分类页支持 ?order=（首页不支持，选「全部」时排序会被忽略）
          { key: "order", name: "排序", value: ORDERS },
        ],
        cosplayersearch: [{ key: "order", name: "排序", value: ORDERS }],
        tagsearch: [{ key: "order", name: "排序", value: ORDERS }],
      },
    };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    let t = String(tid || "latest");
    const ext = extend || {};

    // 详情页 chips 点进来时，tid 就是 "cat:xxx" / "tag:xxx"
    if (t.indexOf("tag:") === 0) {
      ext.sub = t;
      t = "tagsearch";
    } else if (t.indexOf("cat:") === 0) {
      ext.sub = t;
      t = "cosplayersearch";
    }

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const order = String(ext.order || "");
    const sub = String(ext.sub || "");

    // 模特面板 / 标签面板选中值
    if (t === "cosplayersearch" || t === "tagsearch") {
      const isTag = t === "tagsearch";
      const pre = isTag ? "tag:" : "cat:";
      if (sub.indexOf(pre) !== 0) {
        return this.page([{
          vod_id: "", vod_name: isTag ? "在上方选一个标签（可搜索）" : "在上方选一个模特（可搜索）",
          vod_pic: "", vod_remarks: "提示",
        }], 1, PAGE_SIZE, 1);
      }
      const slug = sub.substring(pre.length);
      const path = (isTag ? "/tag/" : "/category/") + slug + "/";
      const html = await this.getHtml(this.listUrl2(path, p, order));
      return this.withBadges(html, p);
    }

    // 最新：media 决定分类页（空 = 首页）
    const media = String(ext.media || "");
    if (!media) {
      const html = await this.getHtml(BASE + "/" + (p > 1 ? "page/" + p + "/" : ""));
      return this.withBadges(html, p);
    }
    const html = await this.getHtml(this.listUrl2("/category/" + media + "/", p, order));
    return this.withBadges(html, p);
  }

  listUrl2(path, p, order) {
    const base = BASE + path + (p > 1 ? "page/" + p + "/" : "");
    return order ? base + "?order=" + order : base;
  }

  /** 出列表 + 用详情页的真实 P/V 数量补角标（并发 + 8 秒总预算） */
  async withBadges(html, p) {
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));
    const cards = parseCards(html);

    let alive = cards;
    if (cards.length) {
      const deadline = Date.now() + 9000;
      const dead = {};
      await Promise.all(cards.map(async (c) => {
        if (Date.now() > deadline) return;
        const det = await this.getHtml(c.vod_id);
        if (!det) return;
        const d = parseDetail(det);

        // 既没有视频也没有图 → 站外广告文章（category-blog 那批），从列表里剔掉
        if (!d.videos.length && !d.images.length) {
          dead[c.vod_id] = 1;
          return;
        }
        const nv = d.videos.length;
        const np = d.images.length;
        let badge = "";
        if (np && nv) badge = np + "P·" + nv + "V";
        else if (nv) badge = (nv > 1 ? nv + "V" : "1V");
        else if (np) badge = np + "P";
        if (badge) {
          const left = c.vod_remarks ? c.vod_remarks.split("|")[0] : "";
          c.vod_remarks = (left ? left + "|" : "") + badge;
        }
        // 顺手补封面（列表卡片的图是缩略图，够用；没图时用详情封面）
        if (!c.vod_pic) {
          const pic = det.match(/property="og:image"[^>]*content="([^"]+)"/);
          if (pic) c.vod_pic = decode(pic[1]);
        }
      }));
      alive = cards.filter((c) => !dead[c.vod_id]);
    }

    const n = p + 1;
    const more = html.indexOf("/page/" + n + "/") >= 0 || html.indexOf("page/" + n) >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + alive.length;
    return this.page(alive, p, PAGE_SIZE, total);
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
      if (t) title = strip(t[1]).replace(/\s*-\s*NudeCosplayGirls.*$/, "").trim();
    }

    const poster = html.match(/property="og:image"[^>]*content="([^"]+)"/) ||
      html.match(/<img[^>]*class="[^"]*wp-post-image[^"]*"[^>]*src="([^"]+)"/);

    // 分类（正文头部，避开导航菜单）
    const cats = [];
    const seenCat = {};
    const ci = html.indexOf("entry-categories-inner");
    if (ci > 0) {
      const seg = html.substring(ci, ci + 1200);
      const reCat = /<a[^>]*href="https:\/\/nudecosplaygirls\.com\/category\/([^"]+)\/"[^>]*>([\s\S]{0,80}?)<\/a>/g;
      let cm;
      while ((cm = reCat.exec(seg)) !== null) {
        if (seenCat[cm[1]]) continue;
        seenCat[cm[1]] = 1;
        const nm = strip(cm[2]);
        if (nm) cats.push({ slug: cm[1], name: nm });
        if (cats.length >= 4) break;
      }
    }

    // 标签
    const tags = [];
    const seenTag = {};
    const ti = html.indexOf("entry-tags-inner");
    if (ti > 0) {
      const seg = html.substring(ti, ti + 2000);
      const reTag = /<a[^>]*href="https:\/\/nudecosplaygirls\.com\/tag\/([^"]+)\/"[^>]*>([^<]{1,40})<\/a>/g;
      let tm;
      while ((tm = reTag.exec(seg)) !== null) {
        if (seenTag[tm[1]]) continue;
        seenTag[tm[1]] = 1;
        tags.push({ slug: tm[1], name: strip(tm[2]) });
        if (tags.length >= 12) break;
      }
    }

    const d = parseDetail(html);
    const nv = d.videos.length;
    const np = d.images.length;

    const lines = [];
    if (cats.length) {
      lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.slug + '"}/]' + x.name + "[/a]").join(" · "));
    }
    if (tags.length) {
      lines.push(tags.map((x) => '[a=cr:{"id":"tag:' + x.slug + '"}/]#' + x.name + "[/a]").join(" "));
    }
    if (!lines.length) lines.push("视频 " + nv + " 个 · 图集 " + np + " 张");

    // 角标：xP / xV / xP·yV
    let badge = "";
    if (np && nv) badge = np + "P·" + nv + "V";
    else if (nv) badge = nv > 1 ? nv + "V" : "1V";
    else if (np) badge = np + "P";

    // 播放/图集地址
    let playUrl = "";
    if (nv) {
      playUrl = nv > 1
        ? d.videos.map((u, i) => "第" + (i + 1) + "段$" + u).join("#")
        : "正片$" + d.videos[0];
    } else {
      playUrl = "正片$" + url;          // 纯图集：靠角标 NP 让 App 显示「查看图集」
    }

    const item = {
      vod_id: url,
      vod_name: title || url,
      vod_pic: poster ? decode(poster[1]) : "",
      vod_content: lines.join("\n"),
      vod_remarks: (cats.length ? cats[0].name + "|" : "") + badge,
      gallery: !nv && np > 0,
      vod_play_from: "NCG",
      vod_play_url: playUrl,
    };

    // 相关推荐：g1-more-from 区块 + 同分类补满 8 条
    const rel = [];
    const seen = {};
    seen[url] = 1;
    let region = "";
    let moreFromCat = "";
    const mi = html.indexOf("g1-more-from");
    if (mi > 0) {
      const ei = html.indexOf("</aside>", mi);
      region = html.substring(mi, ei > mi ? ei : mi + 12000);
      const c = region.match(/href="https:\/\/nudecosplaygirls\.com\/category\/([^"]+)\/"/);
      if (c) moreFromCat = c[1];
    }
    for (const c of parseCards(region)) {
      if (rel.length >= 8) break;
      if (seen[c.vod_id]) continue;
      seen[c.vod_id] = 1;
      rel.push({
        vod_id: c.vod_id, vod_name: c.vod_name, vod_pic: c.vod_pic,
        vod_remarks: (c.vod_remarks || "").split("|").pop(),
      });
    }
    if (moreFromCat && rel.length < 8) {
      const catHtml = await this.getHtml(BASE + "/category/" + moreFromCat + "/");
      for (const c of parseCards(catHtml)) {
        if (rel.length >= 8) break;
        if (seen[c.vod_id]) continue;
        seen[c.vod_id] = 1;
        rel.push({
          vod_id: c.vod_id, vod_name: c.vod_name, vod_pic: c.vod_pic,
          vod_remarks: (c.vod_remarks || "").split("|").pop(),
        });
      }
    }

    return { list: [item].concat(rel) };
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];

    // 图集：App 点「查看图集」时调 action("gal|<页面URL>")
    if (s.indexOf("gal|") === 0) {
      const u = s.substring(4).trim();
      let html = await this.getHtml(u);
      if (!html) return { list: [] };
      const d = parseDetail(html);
      return { list: d.images.map((x) => ({ url: x })) };
    }

    // 模特面板：REST 全量分类，剔掉 4 个主分类
    if (s.indexOf("facet|cosplayer|") === 0 || s.indexOf("facet|cosplayers|") === 0) {
      const prefix = s.indexOf("facet|cosplayers|") === 0 ? "facet|cosplayers|" : "facet|cosplayer|";
      const rest = s.substring(prefix.length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

      const all = await this.loadCats();
      const models = all.filter((c) => MAIN_SLUGS.indexOf(c.slug) < 0);
      const hit = kw
        ? models.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0 || x.slug.toLowerCase().indexOf(kw) >= 0)
        : models;
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => ({
          id: "cat:" + x.slug,
          name: x.name,
          count: x.count ? x.count + " 部" : "",
        })),
      };
    }

    // 标签面板
    if (s.indexOf("facet|tags|") === 0) {
      const rest = s.substring("facet|tags|".length);
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

    return [];
  }

  /** REST：全部分类（含 4 个主分类） */
  async loadCats() {
    if (this.cats && this.cats.length) return this.cats;
    const out = [];
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
          out.push({ slug: c.slug, name: c.name || c.slug, count: c.count || 0 });
        }
        if (arr.length < 100) break;
      }
    } catch (e) { }
    out.sort((a, b) => (b.count || 0) - (a.count || 0));
    if (out.length) this.cats = out;
    return out;
  }

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

  async playerContent(flag, id) {
    const raw = String(id);
    const header = { "User-Agent": UA, "Referer": BASE + "/" };
    if (/\.(?:mp4|m4v|webm)(?:$|\?)/i.test(raw)) return { parse: 0, url: raw, header: header };

    const html = await this.getHtml(raw);
    const d = html ? parseDetail(html) : { videos: [] };
    if (!d.videos.length) throw new Error("没找到播放地址");
    return { parse: 0, url: d.videos[0], header: header };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const kw = encodeURIComponent(key);
    const url = p > 1 ? BASE + "/page/" + p + "/?s=" + kw : BASE + "/?s=" + kw;
    return this.withBadges(await this.getHtml(url), p);
  }
}
