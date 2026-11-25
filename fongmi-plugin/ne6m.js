// ne.6m9ynw.cc —— BiliTV / catvod QuickJS 插件
//
// 侦查结论（2026-11-25）：
//   类型   视频站。详情页播放器配置在 <div data-config='{…}'>，取 video.url（m3u8），
//          另有 video.pic / video.type / video.thumbnails
//   渲染   SSR：首屏就有 22 个 <article> 卡片，分页也走服务端
//   列表   /page/N                     每页 22
//           /category/<slug>/?page=N    分类（9 个，来自首页导航）
//           /tag/<name>?page=N          标签
//   搜索   GET /search?s=<词>&page=N
//   卡片   <article itemscope> → <a href data-id> → <img data-src>（封面）
//          <h2 class="post-card-title">标题</h2>，.post-card-tag 是标签，meta-item 含数字
//          无时长字段 → 角标用 itemprop="datePublished" 的日期（MM-DD）
//   反爬   无 Cloudflare；直连可访问（本机代理不通时也能跑）

import { Spider, openWeb } from "catvod";

const BASE = "https://ne.6m9ynw.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 22;

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
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 名字首字母（A-Z；中文归 #） */
function headLetter(name) {
  const s = String(name || "").trim();
  if (!s) return "#";
  const c = s.charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

/** 列表分页：首页走 /page/N，其它列表走 ?page=N */
function listUrl(kind, key, p) {
  if (kind === "category") return BASE + "/category/" + key + "/" + (p > 1 ? "?page=" + p : "");
  if (kind === "tag") return BASE + "/tag/" + key + (p > 1 ? "?page=" + p : "");
  if (kind === "search") return BASE + "/search?s=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
  return BASE + (p > 1 ? "/page/" + p : "/");
}

/** 列表卡片 */
function parseCards(html, cdn) {
  const cdnBase = String(cdn || "");
  const src = String(html || "");
  const parts = src.split("<article").slice(1);
  const out = [];
  const seen = {};
  for (const raw of parts) {
    const seg = raw.substring(0, 2600);

    // 链接：先看 itemprop="url" 的 content，再退回第一个 href
    let url = "";
    const u1 = seg.match(/itemprop="url"[^>]*content="([^"]+)"/) ||
      seg.match(/content="([^"]+)"[^>]*itemprop="url"/);
    if (u1) url = abs(u1[1]);
    if (!url) {
      const u2 = seg.match(/<a[^>]+href="([^"]+)"[^>]*data-id=/);
      if (u2) url = abs(u2[1]);
    }
    if (!url) {
      const u3 = seg.match(/<a[^>]+href="([^"]*\/archives\/[^"]+)"/);
      if (u3) url = abs(u3[1]);
    }
    if (!url || seen[url]) continue;
    seen[url] = 1;

    // 标题：h2.post-card-title，其次 itemprop=headline
    let title = "";
    const t1 = seg.match(/<h2[^>]*class="[^"]*post-card-title[^"]*"[^>]*>([\s\S]{0,200}?)<\/h2>/);
    if (t1) title = strip(t1[1]);
    if (!title) {
      const t2 = seg.match(/itemprop="headline"[^>]*content="([^"]{2,160})"/);
      if (t2) title = strip(t2[1]);
    }
    if (!title) {
      const t3 = seg.match(/<img[^>]+alt="([^"]{2,120})"/);
      if (t3) title = strip(t3[1]);
    }
    if (!title) continue;

    // 封面：img 的 data-src / src
    let pic = "";
    const cands = [];
    // 注意站点的写法是 data-src= "…"（等号后带空格），正则要放宽
    const p1 = seg.match(/<img[^>]*\sdata-src\s*=\s*"([^"]+)"/);
    const p2 = seg.match(/<img[^>]*\ssrc\s*=\s*"([^"]+)"/);
    const p3 = seg.match(/\sdata-cdn\s*=\s*"([^"]+)"/);
    for (const c of [p1 && p1[1], p3 && p3[1], p2 && p2[1]]) if (c) cands.push(c);
    for (const c of cands) {
      const raw = String(c || "").trim();
      if (!raw || raw.indexOf("data:") === 0) continue;
      // 站点占位图（/assets/place/...）不是封面
      if (/\/assets\/place\//.test(raw) || /\/assets\/images\//.test(raw)) continue;
      // 站点图片是「CDN 线路 + data-src」拼出来的（app.js: img.src = cdnLine + dataset.src）
      if (raw.charAt(0) === "/" && cdnBase) {
        pic = cdnBase.replace(/\/+$/, "") + raw;
      } else {
        pic = abs(raw);
      }
      break;
    }

    // 日期 → 角标 MM-DD
    let remark = "";
    const dm = seg.match(/itemprop="datePublished"[^>]*content="([^"]+)"/) ||
      seg.match(/content="([^"]+)"[^>]*itemprop="datePublished"/);
    if (dm) {
      const d = dm[1].match(/(\d{4})-(\d{2})-(\d{2})/);
      if (d) remark = d[2] + "-" + d[3];
    }

    // 卡片上的标签（后面可能用于筛选）
    const tags = [];
    const reTag = /class="[^"]*post-card-tag[^"]*"[^>]*>([\s\S]{0,40}?)</g;
    let tm;
    while ((tm = reTag.exec(seg)) !== null) {
      const nm = strip(tm[1]);
      if (nm && tags.indexOf(nm) < 0) tags.push(nm);
      if (tags.length >= 3) break;
    }

    out.push({ url: url, title: title, pic: pic, remark: remark, tags: tags });
  }
  return out;
}

/** 详情页媒体：视频（data-config.video.url）+ 图集图片（.image-grid-image 的 data-src） */
function parseMedia(html) {
  const t = String(html || "");
  const videos = [];
  const play = parsePlay(t);
  if (play.url) videos.push(play.url);

  // 真实图集的路径形如 /image/<日期>/…；站内的 /system/…（广告位）和 /assets/… 都不是内容
  const imgs = [];
  const seen = {};
  const re = /(?:data-src|src)\s*=\s*"(\/image\/[^"\s]+|https?:\/\/[^"\s]+\/image\/[^"\s]+)"/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const u = m[1];
    if (!u || seen[u]) continue;
    if (/\/assets\//.test(u)) continue;
    seen[u] = 1;
    imgs.push(u);
  }

  return { videos: videos, images: imgs, pic: play.pic || "" };
}

/** 详情页播放配置：<div data-config='{...}'> 里的 video.url */
function parsePlay(html) {
  const t = String(html || "");
  const m = t.match(/data-config='([^']{20,})'/) || t.match(/data-config="([^"]{20,})"/);
  if (!m) return { url: "", pic: "" };
  let raw = m[1]
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  try {
    const obj = JSON.parse(raw);
    const v = (obj && obj.video) || {};
    return { url: String(v.url || ""), pic: String(v.pic || ""), type: String(v.type || "") };
  } catch (e) {
    const u = raw.match(/"url"\s*:\s*"([^"]+)"/);
    return { url: u ? u[1].replace(/\\\//g, "/") : "", pic: "" };
  }
}

export default class Ne6m extends Spider {
  init() {
    this.cache = {};
    this.menuCache = null;
    this.cdn = "";
  }

  async getHtml(url) {
    const c = this.cache[url];
    if (c && Date.now() - c.ts < 180000) return c.html;
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (!r || r.code !== 200) this.log("fetch fail " + (r ? r.code : "null") + " " + url.slice(0, 60));
      if (r && r.code === 200) {
        this.cache[url] = { html: r.content, ts: Date.now() };
        return r.content;
      }
    } catch (e) { }
    return "";
  }

  /** CDN 线路：页面里的 {"cdnLine":"https://…","cdnName":"…"} 列表（用来拼封面地址） */
  pickCdn(html) {
    if (this.cdn) return this.cdn;
    const list = [];
    const re = /"cdnLine"\s*:\s*"(https?:[^"]+)"/g;
    let m;
    while ((m = re.exec(String(html || ""))) !== null) {
      const u = m[1].replace(/\\\//g, "/");
      if (list.indexOf(u) < 0) list.push(u);
      if (list.length >= 4) break;
    }
    if (list.length) this.cdn = list[0];
    return this.cdn || "";
  }

  /** 首页导航里的分类 / 标签（9 + 3），缓存 15 分钟 */
  async loadMenu() {
    if (this.menuCache) return this.menuCache;
    const html = await this.getHtml(BASE + "/");
    this.pickCdn(html);
    const cats = [];
    const tags = [];
    const seenC = {};
    const seenT = {};

    const reC = /href="(?:https?:\/\/[^\/"]+)?\/category\/([^"\/]+)\/"[^>]*>([\s\S]{0,40}?)<\/a>/g;
    let m;
    while ((m = reC.exec(html || "")) !== null) {
      const slug = m[1];
      if (seenC[slug]) continue;
      seenC[slug] = 1;
      const nm = strip(m[2]) || decodeURIComponent(slug);
      cats.push({ slug: slug, name: nm });
    }
    const reT = /href="(?:https?:\/\/[^\/"]+)?\/tag\/([^"\/]+)"[^>]*>([\s\S]{0,40}?)<\/a>/g;
    while ((m = reT.exec(html || "")) !== null) {
      const slug = m[1];
      if (seenT[slug]) continue;
      seenT[slug] = 1;
      const nm = strip(m[2]) || decodeURIComponent(slug);
      tags.push({ slug: slug, name: nm });
    }

    this.menuCache = { cats: cats, tags: tags };
    return this.menuCache;
  }

  async homeContent() {
    const menu = await this.loadMenu();
    const media = [{ n: "全部", v: "" }];
    for (const c of menu.cats) media.push({ n: c.name, v: "c:" + c.slug });
    for (const t of menu.tags) {
      const nm = String(t.name).replace(/^#+/, "").trim();
      media.push({ n: "#" + nm, v: "t:" + t.slug });
    }

    return {
      class: [
        { type_id: "latest", type_name: "最新" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        latest: [
          { key: "media", name: "分类", value: media },
        ],
      },
    };
  }

  /** 判断详情页是「视频 / 图集 / 混合」→ 角标 1V / 1P / 1P·1V */
  badgeOf(html) {
    if (!html) return "";
    const media = parseMedia(html);
    const nv = media.videos.length;
    let np = media.images.length;
    if (nv > 0 && np <= 1) np = 0;
    if (np && nv) return "1P·1V";
    if (nv) return "1V";
    if (np) return "1P";
    return "";
  }

  /**
   * 列表角标：站点列表页没有类型信息，只能补抓详情。
   * 有界：最多补 limit 条，超过 deadline 就放弃（剩下的留空/日期），不影响首屏。
   */
  async enrichBadges(cards, limit, deadlineMs) {
    const t0 = Date.now();
    const n = Math.min(limit, cards.length);
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      jobs.push((async () => {
        if (Date.now() - t0 > deadlineMs) return;
        try {
          const html = await this.getHtml(c.url);
          const b = this.badgeOf(html);
          if (b) c.badge = b;
        } catch (e) { }
      })());
    }
    // 硬截止：到点就不等了（否则会拖到 App 的 15 秒看门狗）
    try {
      await Promise.race([
        Promise.all(jobs),
        new Promise((r) => setTimeout(r, Math.max(800, deadlineMs))),
      ]);
    } catch (e) { }
    return cards;
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      // 优先用补抓到的 1V/1P/1P·1V，没有就退回日期
      vod_remarks: c.badge || c.remark || "",
    }));
  }

  async listFrom(url, p) {
    const html = await this.getHtml(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseCards(html, this.cdn || this.pickCdn(html));
    // 只给第 1 页补角标（后续页留空，避免翻页变慢）
    // 手机直连实测一页 22 条并发补抓约 1.3 秒 → 整页都补，截止放宽到 5 秒
    if (p === 1 && cards.length) await this.enrichBadges(cards, PAGE_SIZE, 5000);
    // 下一页信号：页面里出现下一页的链接/页码
    const more = html.indexOf("page=" + (p + 1)) >= 0
      || html.indexOf("/page/" + (p + 1)) >= 0
      || html.indexOf("下一页") >= 0
      || html.indexOf('rel="next"') >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "latest");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const media = String(ext.media || "");
    if (media.indexOf("c:") === 0) return this.listFrom(listUrl("category", media.substring(2), p), p);
    if (media.indexOf("t:") === 0) return this.listFrom(listUrl("tag", media.substring(2), p), p);

    // 详情页 chips 点进来
    if (t.indexOf("cat:") === 0) return this.listFrom(listUrl("category", t.substring(4), p), p);
    if (t.indexOf("tag:") === 0) return this.listFrom(listUrl("tag", t.substring(4), p), p);

    return this.listFrom(listUrl("latest", "", p), p);
  }

  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const html = await this.getHtml(pageUrl);
    if (!html) return { list: [] };

    let title = "";
    const ogt = html.match(/property="og:title"[^>]*content="([^"]{2,200})"/) ||
      html.match(/content="([^"]{2,200})"[^>]*property="og:title"/);
    if (ogt) title = strip(ogt[1]);
    if (!title) {
      const hl = html.match(/itemprop="headline"[^>]*content="([^"]{2,200})"/);
      if (hl) title = strip(hl[1]);
    }
    if (!title) {
      const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
      if (h1) title = strip(h1[1]);
    }
    if (!title) {
      const tt = html.match(/<title>([^<]*)<\/title>/);
      if (tt) title = strip(tt[1]).split(/[-|_]/)[0].trim();
    }

    const media = parseMedia(html);
    const nv = media.videos.length;
    // 视频帖里通常只有 1 张 /image/（封面），少于 2 张就不当成图集
    let np = media.images.length;
    if (nv > 0 && np <= 1) np = 0;
    const galleryImgs = np ? media.images.slice(0, np) : [];
    const cdn = this.cdn || this.pickCdn(html);
    const fullImgs = galleryImgs.map((u) =>
      (u.charAt(0) === "/" && cdn) ? (cdn.replace(/\/+$/, "") + u) : abs(u));

    const play = { url: nv ? media.videos[0] : "" };
    let pic = media.pic ? abs(media.pic) : (fullImgs[0] || "");
    if (!pic) {
      const og = html.match(/property="og:image"[^>]*content="([^"]+)"/) ||
        html.match(/content="([^"]+)"[^>]*property="og:image"/);
      if (og) pic = abs(og[1]);
    }

    // 分类 / 标签
    const cats = [];
    const seenC = {};
    for (const m of html.matchAll(/href="(?:https?:\/\/[^\/"]+)?\/category\/([^"\/]+)\/"[^>]*>([\s\S]{0,30}?)<\/a>/g)) {
      if (seenC[m[1]]) continue;
      seenC[m[1]] = 1;
      const nm = strip(m[2]);
      if (nm) cats.push({ slug: m[1], name: nm });
      if (cats.length >= 5) break;
    }
    const tags = [];
    const seenT = {};
    for (const m of html.matchAll(/href="(?:https?:\/\/[^\/"]+)?\/tag\/([^"\/]+)"[^>]*>([\s\S]{0,30}?)<\/a>/g)) {
      if (seenT[m[1]]) continue;
      seenT[m[1]] = 1;
      const nm = strip(m[2]);
      if (nm) tags.push({ slug: m[1], name: nm });
      if (tags.length >= 10) break;
    }

    const lines = [];
    if (cats.length) lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.slug + '"}/]' + x.name + "[/a]").join(" · "));
    if (tags.length) lines.push(tags.map((x) => '[a=cr:{"id":"tag:' + x.slug + '"}/]#' + x.name + "[/a]").join(" "));

    // 角标统一为三种固定形态：1V / 1P / 1P·1V（App 靠它决定显示「视频」「图集」按钮）
    let badge = "";
    if (np && nv) badge = "1P·1V";
    else if (nv) badge = "1V";
    else if (np) badge = "1P";

    const item = {
      vod_id: pageUrl,
      vod_name: title || "ne6m",
      vod_pic: pic,
      vod_content: lines.join("\n"),
      vod_remarks: badge,
      gallery: np > 0,
      vod_play_from: "ne6m",
      vod_play_url: nv ? "正片$" + pageUrl : "图集$gal://" + pageUrl,
    };

    // 相关推荐：详情页里的其它卡片
    const rel = [];
    const seen = {};
    seen[pageUrl] = 1;
    for (const c of parseCards(html, this.cdn || this.pickCdn(html))) {
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
    const play = html ? parsePlay(html) : { url: "" };
    if (!play.url) throw new Error("没找到播放地址");
    return { parse: 0, url: play.url, header: header };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    return this.listFrom(listUrl("search", String(key || ""), p), p);
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];
    // 原生图集：gal|<页面URL> → 图片列表（CDN 线路 + data-src 路径）
    if (s.indexOf("gal|") === 0) {
      const u = s.substring(4).replace(/^gal:\/\//, "");
      const pageUrl = u.indexOf("http") === 0 ? u : BASE + u;
      const html = await this.getHtml(pageUrl);
      if (!html) return { list: [] };
      const cdn = this.cdn || this.pickCdn(html);
      const media = parseMedia(html);
      const out = [];
      const seen = {};
      for (const raw of media.images) {
        const full = (raw.charAt(0) === "/" && cdn) ? (cdn.replace(/\/+$/, "") + raw) : abs(raw);
        if (!full || seen[full]) continue;
        seen[full] = 1;
        out.push({ url: full });
      }
      return { list: out };
    }

    // 侧栏：分类 + 标签（各 9 / 3 个，量少，仅作入口）
    if (s === "side|") {
      const menu = await this.loadMenu();
      const groups = [];
      if (menu.cats.length) {
        groups.push({
          name: "分类",
          items: menu.cats.map((c) => ({ name: c.name, count: "", id: "cat:" + c.slug })),
        });
      }
      if (menu.tags.length) {
        groups.push({
          name: "标签",
          items: menu.tags.map((t) => ({ name: t.name, count: "", id: "tag:" + t.slug })),
        });
      }
      return { groups: groups };
    }

    // 分面（预留：目前只有 9 + 3，够用就不开面板）
    if (s.indexOf("facet|") === 0) {
      const menu = await this.loadMenu();
      const kind = s.split("|")[1] || "";
      const rest = s.substring(("facet|" + kind + "|").length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      const src = /tag/i.test(kind) ? menu.tags : menu.cats;
      const letter = kw.indexOf("^") === 0 ? kw.substring(1).toUpperCase() : "";
      const hit = letter
        ? src.filter((x) => headLetter(x.name) === letter)
        : (kw ? src.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0) : src);
      const prefix = /tag/i.test(kind) ? "tag:" : "cat:";
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => ({
          id: prefix + x.slug, name: x.name, count: "",
        })),
      };
    }

    return [];
  }
}
