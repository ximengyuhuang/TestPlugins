// 小葱资源（xiaocongzy.com）—— BiliTV / catvod QuickJS 插件
//
// 站类型：混合站（视频 + 图集），WordPress
//   全部   /page/N/
//   视频   /page/N/?post_format=video        （站点支持正向筛视频）
//   归档   /<slug>/page/N/                    （10 个归档分类，走二级 chips）
//   博主   /tags/<URL编码名>/page/N/          （2448 个标签，索引见下）
//   详情   /post/<id>.html
//          视频：<source src="…mp4">  直链
//          图集：<img src="…jpg"> 若干张
//   搜索   /?s=<词>，翻页 /page/N/?s=<词>
//
// 关键：/tags 页面内嵌了全部标签的 JSON 字面量
//   { name: "阿拉蕾", count: 836, group: "A", type: "post_tag", link: "…/tags/…/" }
//   一次请求就能拿到 2448 个标签 + 帖子数，据此做模糊搜索与分页浏览
//
// 卡片结构：
//   视频帖 <article id="post-1" class="post-card post-video …">  <video><source src="…mp4">
//   图集帖 <article id="post-2" class="post-card … format-standard …"> <div class="post-gallery"><img…>
//          <span class="img-count-badge">共 7 张</span>

import { Spider, openWeb } from "catvod";

const BASE = "https://www.xiaocongzy.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 12;
const FACET_PAGE_SIZE = 200;

// 归档分类（名称运行时从 /navigation 校正，这里只是兜底顺序）
const ARCHIVES = [
  { slug: "daoyuqudao", name: "更新归档1" },
  { slug: "huanyuxingqiu", name: "更新归档2" },
  { slug: "weimiquan", name: "更新归档3" },
  { slug: "gengxinyuan1", name: "更新归档4" },
  { slug: "gengxinyuan2", name: "更新归档5" },
  { slug: "gengxinyuan3", name: "更新归档6" },
  { slug: "siyuquan", name: "更新归档7" },
  { slug: "miyukongjian", name: "更新归档8" },
  { slug: "yutangquan", name: "更新归档9" },
  { slug: "tiefenkongjian", name: "更新归档10" },
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
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

function clean(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** 解析列表卡片 */
function parseCards(html) {
  const text = String(html || "");
  const marks = [];
  const re = /<article id="post-\d+"/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : text.length;
    const b = text.substring(from, to);

    const idm = b.match(/<article id="post-(\d+)"/);
    if (!idm) continue;
    const id = idm[1];
    if (seen[id]) continue;
    seen[id] = 1;
    // 站点公告（站长说说）不是内容，跳过
    if (b.indexOf("category-zhanzhang") >= 0) continue;

    const isVideo = b.indexOf("post-video") >= 0 || b.indexOf("format-video") >= 0;

    // 标题
    const tm = b.match(/class="post-title"[^>]*>\s*<a[^>]*>([\s\S]{0,240}?)<\/a>/);
    const title = clean(tm ? tm[1] : "") || ("post " + id);

    let pic = "";
    let remarks = "";

    if (isVideo) {
      const pm = b.match(/<video[^>]*poster="([^"]+)"/) || b.match(/<source[^>]*src="([^"]+)"/);
      pic = pm ? decode(pm[1]) : "";
    } else {
      const im = b.match(/class="post-gallery"[\s\S]{0,600}?<img[^>]*src="([^"]+)"/) || b.match(/<img[^>]*src="([^"]+)"/);
      pic = im ? decode(im[1]) : "";
      // 图集角标必须是纯「NP」，App 才判定为图集、点卡片直接进图集
      const cm = b.match(/class="img-count-badge"[^>]*>\s*共\s*(\d+)\s*张/);
      if (cm) remarks = cm[1] + "P";
    }

    out.push({
      vod_id: BASE + "/post/" + id + ".html",
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      // 视频封面是 16:9 拼图 → 用横版裁切；图集是竖图 → 0 表示跟随站点（自适应不裁切）
      vod_ratio: isVideo ? 1.78 : 0,
    });
  }
  return out;
}

/** 详情页：视频 mp4 或图集图片 + 标签 */
function parseDetail(html) {
  const text = String(html || "");

  const tm = text.match(/class="post-title"[^>]*>\s*([\s\S]{0,240}?)<\/h1>/) ||
    text.match(/<title>([^<]*)<\/title>/);
  let title = clean(tm ? tm[1] : "").replace(/\s*-\s*小葱资源\s*$/, "").trim();

  // 视频
  const mp4 = text.match(/<source[^>]*src="([^"]+\.mp4[^"]*)"/) ||
    text.match(/<video[^>]*src="([^"]+\.mp4[^"]*)"/);
  const video = mp4 ? decode(mp4[1]) : "";

  // 图集图片（只取正文里的，排除 logo/头像）
  const imgs = [];
  const seen = {};
  const re = /<img[^>]*src="(https:\/\/img\.[^"]+\.(?:jpg|jpeg|png|webp|gif))"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = decode(m[1]);
    if (!seen[u]) { seen[u] = 1; imgs.push(u); }
  }

  const cover = video ? video + ".jpg" : (imgs.length ? imgs[0] : "");

  // 标签（博主）
  const tags = [];
  const seenT = {};
  const tre = /<a[^>]*href="[^"]*\/tags\/([^"\/]+)\/"[^>]*>\s*([^<]{1,40})</g;
  while ((m = tre.exec(text)) !== null) {
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (e) { }
    slug = decode(slug).trim();
    if (!slug || seenT[slug]) continue;
    seenT[slug] = 1;
    tags.push({ slug: slug, name: clean(m[2]) || slug });
  }

  const descM = text.match(/class="post-excerpt"[^>]*>([\s\S]{0,400}?)<\/p>/);
  const desc = clean(descM ? descM[1] : "");

  return { title: title, video: video, imgs: imgs, tags: tags, cover: cover, desc: desc };
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|p):/, "");
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

export default class Xiaocong extends Spider {
  init() { }

  async homeContent() {
    const classes = [
      { type_id: "all", type_name: "全部" },
      { type_id: "video", type_name: "视频" },
      { type_id: "archive", type_name: "归档" },
      { type_id: "tagsearch", type_name: "博主" },
      { type_id: "web", type_name: "网页" },
    ];

    // 站点没有排序参数，只有「视频」这个正向筛选，所以不给 filters
    return { class: classes, filters: {}, subFromTab: true };
  }

  /** 列表 URL */
  listUrl(tid, extend, p) {
    const ex = extend || {};
    if (tid === "video") {
      return BASE + (p <= 1 ? "/" : "/page/" + p + "/") + "?post_format=video";
    }
    if (tid === "archive") {
      const slug = ex.sub || "";
      if (!slug) return "";
      return BASE + "/" + slug + "/" + (p <= 1 ? "" : "page/" + p + "/");
    }
    return BASE + (p <= 1 ? "/" : "/page/" + p + "/");
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "all");

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }
    if (t === "tagsearch") return this.page([], p, PAGE_SIZE, 0);

    // 博主（标签）列表
    if (t.indexOf("tag:") === 0) {
      const name = t.substring(4).trim();
      if (!name) return this.page([], p, PAGE_SIZE, 0);
      const enc = encodeURIComponent(name);
      const url = BASE + "/tags/" + enc + "/" + (p <= 1 ? "" : "page/" + p + "/");
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }
      const cards = html ? parseCards(html) : [];
      if (!cards.length && p === 1) {
        return this.page([{
          vod_id: "", vod_name: "博主「" + name + "」没有内容",
          vod_pic: "", vod_remarks: "提示",
        }], 1, PAGE_SIZE, 1);
      }
      const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
      return this.page(cards, p, PAGE_SIZE, total);
    }

    const url = this.listUrl(t, extend, p);
    if (!url) {
      // 「归档」tab 还没选二级 chip → 先给提示
      return this.page([{
        vod_id: "", vod_name: "请在上方选择一个归档分类",
        vod_pic: "", vod_remarks: "提示",
      }], 1, PAGE_SIZE, 1);
    }

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }

    const d = parseDetail(html);

    const lines = [];
    if (d.tags.length) {
      lines.push(d.tags.slice(0, 12)
        .map((t) => '[a=cr:{"id":"tag:' + t.slug + '"}/]' + t.name + "[/a]")
        .join(" · "));
    }
    if (d.desc) lines.push(d.desc);

    if (d.video) {
      // 视频帖
      return {
        list: [{
          vod_id: url,
          vod_name: d.title || url,
          vod_pic: d.cover,
          vod_content: lines.join("\n"),
          vod_remarks: "",
          gallery: false,
          vod_play_from: "小葱资源",
          vod_play_url: "正片$" + d.video,
        }],
      };
    }

    // 既没有视频也没有图片（公告/说明帖）
    if (!d.imgs.length) {
      return {
        list: [{
          vod_id: url,
          vod_name: d.title || url,
          vod_pic: d.cover,
          vod_content: lines.join("\n") || "这条内容没有视频或图片",
          vod_remarks: "提示",
          gallery: false,
          vod_play_from: "小葱资源",
          vod_play_url: "正片$" + url,
        }],
      };
    }

    // 图集帖
    return {
      list: [{
        vod_id: url,
        vod_name: d.title || url,
        vod_pic: d.cover,
        vod_content: lines.join("\n"),
        vod_remarks: d.imgs.length + "P",
        gallery: true,
        vod_play_from: "小葱资源",
        vod_play_url: "图集$" + url,
      }],
    };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    if (/\.mp4(\?|$)/.test(url)) {
      return { parse: 0, url: url, header: { "User-Agent": UA, "Referer": BASE + "/" } };
    }
    // 兜底再抓一次详情页
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    const d = parseDetail(html);
    if (!d.video) throw new Error("没找到播放地址");
    return { parse: 0, url: d.video, header: { "User-Agent": UA, "Referer": BASE + "/" } };
  }

  /** 全部博主（从 /tags 页内嵌的 JSON 字面量里取，进程内缓存） */
  async allTags() {
    if (this.tagCache) return this.tagCache;
    let html = "";
    try {
      const r = await this.net.req(BASE + "/tags", { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return [];

    const out = [];
    const seen = {};
    const re = /\{\s*name:\s*"([^"]*)",\s*count:\s*(\d+),\s*group:\s*"([^"]*)",\s*type:\s*"post_tag",\s*link:\s*"([^"]*)"\s*\}/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = clean(m[1]);
      if (!name || seen[name]) continue;
      seen[name] = 1;
      out.push({ name: name, count: Number(m[2]), group: m[3] });
    }
    // 按帖子数从多到少，热门博主排前面
    out.sort((a, b) => b.count - a.count);
    this.tagCache = out;
    return out;
  }

  async action(op) {
    if (!op) return [];

    // 博主（标签）模糊搜索 + 分页浏览
    if (op.indexOf("facet|tags|") === 0) {
      const rest = op.substring("facet|tags|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim();
      const pg = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

      const tags = await this.allTags();
      if (!tags.length) return { items: [] };

      const low = kw.toLowerCase();
      const hit = [];
      for (const t of tags) {
        if (!kw || t.name.toLowerCase().indexOf(low) >= 0) hit.push(t);
      }
      const from = (pg - 1) * FACET_PAGE_SIZE;
      const items = hit.slice(from, from + FACET_PAGE_SIZE)
        .map((t) => ({ id: t.name, name: t.count > 0 ? t.name + " " + t.count : t.name, count: String(t.count) }));
      return { items: items };
    }

    // 归档分类（二级 chips）
    if (op.indexOf("sub|") === 0) {
      const tid = op.substring(4).trim();
      if (tid !== "archive") return [];
      return ARCHIVES.map((a) => ({ name: a.name, value: a.slug, count: "" }));
    }

    // 图集页
    if (op.indexOf("gal|") === 0) {
      const url = pageUrlOf(op.substring(4));
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }
      const d = parseDetail(html);
      return {
        list: d.imgs.map((u) => ({ url: u })),
        tags: d.tags.map((t) => ({ name: t.name, id: "tag:" + t.slug })),
      };
    }

    return [];
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + (p <= 1 ? "/" : "/page/" + p + "/") + "?s=" + encodeURIComponent(key);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
