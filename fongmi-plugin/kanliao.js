// 今日看料（kanliao19.one）—— BiliTV / catvod QuickJS 插件
//
// 站点结构（2026-11-24 侦查）
//   首页   /                      25/页，/page/N/
//   分类   /category/<slug>/       rdgz 热点关注 dy 抖音 ks 快手 douyu 斗鱼 hy 虎牙
//                                  hj 花椒 tt 推特 wh 网红 asmr ASMR xb X播 xsp 小视频
//   排行   /top.html
//   标签   /tags.html（766 个）→ /tag/<slug>/
//   搜索   /search/<关键词>/       ⚠ 无分页（page/2/ 是 404），单页 10 条
//   详情   /archives/<id>/
//   播放   <div class="dplayer" data-config='{"video":{"url":"…index.m3u8"}}'>  → 标准 HLS
//
// 卡片（无封面、无时长，只有渐变底色 + 标题 + 作者/日期/分类）：
//   <article>
//     <a href="https://kanliao19.one/archives/43176/">
//       <div class="post-card"><h2 class="post-card-title">…</h2>
//         <div class="post-card-info">今日看料 • March 10, 2024 • 热点关注</div>
//
// ⚠ CDN 域名在部分网络下 DNS 被污染（解析到 28.0.0.54），插件侧无法绕过

import { Spider, openWeb } from "catvod";

const BASE = "https://kanliao19.one";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 25;

// chips：最新 + 排行榜 + 11 个分类
const CHIPS = [
  { n: "最新", v: "" },
  { n: "排行榜", v: "top" },
  { n: "热点关注", v: "rdgz" },
  { n: "抖音", v: "dy" },
  { n: "快手", v: "ks" },
  { n: "斗鱼", v: "douyu" },
  { n: "虎牙", v: "hy" },
  { n: "花椒", v: "hj" },
  { n: "推特", v: "tt" },
  { n: "网红", v: "wh" },
  { n: "ASMR", v: "asmr" },
  { n: "X播", v: "xb" },
  { n: "小视频", v: "xsp" },
];

const CAT_NAME = {
  rdgz: "热点关注", dy: "抖音", ks: "快手", douyu: "斗鱼", hy: "虎牙", hj: "花椒",
  tt: "推特", wh: "网红", asmr: "ASMR", xb: "X播", xsp: "小视频",
};

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

/** 列表 URL */
function listUrl(chip, p) {
  if (chip === "top") return BASE + "/top.html";
  if (!chip) return BASE + "/" + (p > 1 ? "page/" + p + "/" : "");
  return BASE + "/category/" + chip + "/" + (p > 1 ? "page/" + p + "/" : "");
}

/** 解析卡片（Typecho post-card） */
function parseCards(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const re = /<a href="(https:\/\/kanliao19\.one\/archives\/\d+\/)"[\s\S]{0,2500}?<\/article>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const b = m[0];
    const url = m[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const title = b.match(/class="post-card-title"[^>]*>([\s\S]{0,400}?)<\/h2>/);
    // info 里有三层 span（作者/日期/分类），窗口要够大，否则分类被截断
    const info = b.match(/class="post-card-info"[^>]*>([\s\S]{0,600}?)<\/div>/);
    const hot = /class="wraps"[^>]*>([^<]{1,10})</.test(b);

    // 分类：post-card-info 最后一段（作者 • 日期 • 分类）
    let cat = "";
    if (info) {
      const parts = strip(info[1]).split(/[•·]/).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 3) cat = parts[parts.length - 1];
    }

    // 角标：分类放左上（`分类|`，右半留空 → App 只显示左上）
    const remarks = cat ? cat + "|" : (hot ? "HOT|" : "");

    // 标题里嵌了 <div class="wrap"><span class="wraps">热搜HOT</span></div>，要去掉
    let name = title ? String(title[1]).replace(/<div class="wrap">[\s\S]*?<\/div>/g, "") : "";
    const idM = url.match(/\/archives\/(\d+)\//);
    out.push({
      vod_id: url,
      // 站里有一批卡片的 h2 是空的（只有「热搜HOT」角标），别拿整条 URL 当标题
      vod_name: strip(name) || ("无标题 · " + (idM ? idM[1] : "")),
      vod_pic: "",
      vod_remarks: remarks,
    });
  }
  return out;
}

/** 有没有下一页 */
function hasNext(html, p) {
  const t = String(html || "");
  const n = p + 1;
  return t.indexOf("page/" + n + "/") >= 0 || t.indexOf("page=" + n) >= 0 || /rel="next"/.test(t);
}

/**
 * 详情页的所有播放地址（m3u8）。
 * ⚠ 一篇可以有多个播放器（合集/短剧），实测单篇最多 26 个 —— 全部按出现顺序取出来当「集」
 */
function parsePlays(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const re = /data-config='([^']+)'/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let url = "";
    try {
      const cfg = JSON.parse(m[1].replace(/&quot;/g, '"'));
      url = (cfg.video && cfg.video.url) || "";
    } catch (e) {
      const u = m[1].match(/"url"\s*:\s*"([^"]+)"/);
      url = u ? u[1].replace(/\\\//g, "/") : "";
    }
    if (!url || seen[url]) continue;
    seen[url] = 1;
    out.push(url);
  }
  return out;
}

/** 兼容旧调用 */
function parsePlay(html) {
  const list = parsePlays(html);
  return list.length ? list[0] : "";
}

/** 选集文本：单集叫「正片」，多集叫「第N集」；一集都没有就退回详情页地址 */
function playLines(html, pageUrl) {
  const list = parsePlays(html);
  if (!list.length) return "正片$" + pageUrl;
  if (list.length === 1) return "正片$" + list[0];
  return list.map((u, i) => "第" + (i + 1) + "集$" + u).join("#");
}

export default class Kanliao extends Spider {
  init() {
    this.tagCache = null;
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
        { type_id: "video", type_name: "视频" },
        { type_id: "tagsearch", type_name: "标签" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        video: [
          { key: "media", name: "分类", value: CHIPS },
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

    // 标签面板选中 → /tag/<slug>/
    if (t === "tagsearch") {
      const sub = String(ext.sub || "");
      if (sub.indexOf("tag:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个标签", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      const slug = sub.substring(4);
      return this.listFromUrl(BASE + "/tag/" + slug + "/" + (p > 1 ? "page/" + p + "/" : ""), p);
    }

    return this.listFromUrl(listUrl(String(ext.media || ""), p), p);
  }

  /** 排行榜：/top.html 是一串 <a href="…/archives/N/">[当月评论N条]标题</a>，还指向镜像域名 */
  parseRank(html) {
    const out = [];
    const seen = {};
    const re = /<a href="[^"]*\/archives\/(\d+)\/"[^>]*>([^<]{1,80})<\/a>/g;
    let m;
    while ((m = re.exec(String(html || ""))) !== null) {
      const id = m[1];
      if (seen[id]) continue;
      seen[id] = 1;
      out.push({
        vod_id: BASE + "/archives/" + id + "/",
        vod_name: strip(m[2]) || id,
        vod_pic: "",
        vod_remarks: "排行|",
      });
    }
    return out;
  }

  async listFromUrl(url, p) {
    const html = await this.getHtml(url);
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = url.indexOf("/top.html") >= 0 ? this.parseRank(html) : parseCards(html);

    // 列表页的卡片没有封面（只有渐变底色），封面只在详情页的 itemprop="image"
    // → 并行为本页每个条目取一次详情（结果进 180 秒缓存，点开详情时复用）
    let alive = cards;
    if (cards.length) {
      const deadline = Date.now() + 10000;   // 总预算 10 秒：超时就用已拿到的封面，不让整页卡住
      const dead = {};
      await Promise.all(cards.map(async (c) => {
        if (Date.now() > deadline) return;
        const det = await this.getHtml(c.vod_id);

        // 站点列表里混着一批「死帖/落地页」：详情页要么是 3KB 空壳，
        // 要么是 hex2bin 混淆的广告页 —— 既没有 post-title 也没有 itemprop=image
        if (!det || (!/class="post-title/.test(det) && !/itemprop="image"/.test(det))) {
          dead[c.vod_id] = 1;
          return;
        }

        const cov = det.match(/itemprop="image"\s+content="([^"]+)"/);
        if (cov) c.vod_pic = cov[1].indexOf("http") === 0 ? cov[1] : BASE + cov[1];
        // 顺手用详情页的分类修正角标（列表页偶尔给「无分类」）
        if (!c.vod_remarks || c.vod_remarks === "|" || c.vod_remarks === "无分类|") {
          const catM = det.match(/\/category\/([a-z0-9]+)\/"[^>]*>([^<]{1,20})</);
          if (catM) c.vod_remarks = strip(catM[2]) + "|";
        }
      }));
      // 只过滤「确认是死帖」的；预算内没来得及判定的保留，避免慢网下误删正常内容
      alive = cards.filter((c) => !dead[c.vod_id]);
    }

    const total = hasNext(html, p) ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + alive.length;
    return this.page(alive, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = String(ids[0] || "");
    const html = await this.getHtml(url);
    if (!html) return { list: [] };

    let title = "";
    const h1 = html.match(/<h1[^>]*class="post-title[^"]*"[^>]*>([\s\S]{0,300}?)<\/h1>/) ||
      html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/);
    if (h1) title = strip(h1[1]);
    if (!title) {
      const t = html.match(/<title>([^<]*)<\/title>/);
      if (t) title = strip(t[1]).replace(/\s*-\s*今日看料.*$/, "").trim();
    }

    // 封面（详情页有，列表页没有）
    const cover = html.match(/itemprop="image"\s+content="([^"]+)"/) ||
      html.match(/<img[^>]*class="post-cover"[^>]*src="([^"]+)"/);
    const coverUrl2 = cover ? (cover[1].indexOf("http") === 0 ? cover[1] : BASE + cover[1]) : "";

    // 分类（/category/<slug>/ 链接）
    const catM = html.match(/\/category\/([a-z0-9]+)\/"[^>]*>([^<]{1,20})</);
    const catName = catM ? strip(catM[2]) : "";

    // 文本区：作者 / 日期 / 分类
    const info = html.match(/<ul class="post-meta"[^>]*>([\s\S]{0,600}?)<\/ul>/) ||
      html.match(/class="post-card-info"[^>]*>([\s\S]{0,600}?)<\/div>/);
    const lines = [];
    if (info) {
      const parts = strip(info[1]).split(/[•·]/).map((x) => x.trim()).filter(Boolean);
      const uniq = [];
      for (const x of parts) if (uniq.indexOf(x) < 0) uniq.push(x);
      if (uniq.length) lines.push(uniq.join(" · "));
    }
    const tags = listUnique(html, /href="https:\/\/kanliao19\.one\/tag\/([^"\/]+)\/"[^>]*>([^<]{1,20})</g);
    if (tags.length) {
      lines.push(tags.slice(0, 6).map((x) => '[a=cr:{"id":"tag:' + x.slug + '"}/]' + x.name + "[/a]").join(" · "));
    }

    const dur = "";
    const item = {
      vod_id: url,
      vod_name: title || url,
      vod_pic: coverUrl2,
      vod_content: lines.join("\n"),
      vod_remarks: (catName || (info ? (strip(info[1]).split(/[•·]/).pop() || "").trim() : "")) + "|",
      gallery: false,
      vod_play_from: "今日看料",
      vod_play_url: playLines(html, url),
    };

    // 相关推荐：上一篇/下一篇 + 同分类兜底
    const rel = await this.relatedOf(html, url);

    return { list: [item].concat(rel) };
  }

  /** 相关推荐：站点只给上一篇/下一篇，不足 8 条就用同分类补齐 */
  async relatedOf(html, selfUrl) {
    const out = [];
    const seen = {};
    seen[selfUrl] = 1;

    const push = (url, name, cat) => {
      if (!url || seen[url] || out.length >= 8) return;
      seen[url] = 1;
      out.push({ vod_id: url, vod_name: name || url, vod_pic: "", vod_remarks: cat ? cat + "|" : "" });
    };

    // 1) 详情页里其它 archives 链接（上一篇/下一篇/推荐位）
    for (const c of parseCards(html)) push(c.vod_id, c.vod_name, (c.vod_remarks || "").replace("|", ""));

    // 2) 不足 8 条 → 同分类第一页补齐
    if (out.length < 8) {
      const cat = String((html.match(/\/category\/([a-z]+)\//) || [])[1] || "");
      const listUrl2 = cat ? BASE + "/category/" + cat + "/" : BASE + "/";
      const page = await this.getHtml(listUrl2);
      if (page) for (const c of parseCards(page)) push(c.vod_id, c.vod_name, CAT_NAME[cat] || "");
    }
    return out;
  }

  /** 标签全量：/tags.html（766 个） */
  async loadTags() {
    if (this.tagCache && this.tagCache.length) return this.tagCache;
    const html = await this.getHtml(BASE + "/tags.html");
    const out = [];
    const seen = {};
    const re = /href="https:\/\/kanliao19\.one\/tag\/([^"\/]+)\/"[^>]*>([^<]{1,24})</g;
    let m;
    while ((m = re.exec(html || "")) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      const nm = strip(m[2]);
      if (nm) out.push({ slug: slug, name: nm });
    }
    if (out.length) this.tagCache = out;
    return out;
  }

  async action(op) {
    if (!op) return [];

    if (op.indexOf("gal|") === 0) return { list: [] };

    // 标签搜索面板（tagsearch → kind = tags）
    if (op.indexOf("facet|tags|") === 0) {
      const rest = op.substring("facet|tags|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);
      const all = await this.loadTags();
      const hit = kw ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0) : all;
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => ({ id: "tag:" + x.slug, name: x.name, count: "" })),
      };
    }
    return [];
  }

  async playerContent(flag, id) {
    const raw = String(id);
    const header = { "User-Agent": UA, "Referer": BASE + "/" };

    // 详情页已经把每一集的 m3u8 解出来了，直接用
    if (raw.indexOf(".m3u8") > 0) return { parse: 1, url: raw, header: header };

    const html = await this.getHtml(raw);
    if (!html) throw new Error("详情页打不开");

    const play = parsePlay(html);
    if (!play) throw new Error("没找到播放地址");
    return { parse: 1, url: play, header: header };
  }

  /** 搜索：/search/<kw>/，站点无分页 */
  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    if (p > 1) return this.page([], 1, PAGE_SIZE, 10);   // 站点搜索没有第二页
    const url = BASE + "/search/" + encodeURIComponent(key) + "/";
    const html = await this.getHtml(url);
    const cards = html ? parseCards(html) : [];
    return this.page(cards, 1, PAGE_SIZE, cards.length);
  }
}

/** 抓一组唯一链接（slug + 显示名） */
function listUnique(html, re) {
  const out = [];
  const seen = {};
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(String(html || ""))) !== null) {
    const slug = m[1];
    if (seen[slug]) continue;
    seen[slug] = 1;
    const nm = strip(m[2]);
    if (nm) out.push({ slug: slug, name: nm });
    if (out.length >= 12) break;
  }
  return out;
}
