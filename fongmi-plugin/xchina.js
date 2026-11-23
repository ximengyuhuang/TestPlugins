// xChina（xchina.co）—— BiliTV / catvod QuickJS 插件
//
// 站类型：混合站（视频 + 套图）
//   影片   /videos/N                     分页用数字路径，?page= 无效
//          分类 /video-category/<slug>/N   jav|cn|movie|ai|other
//   套图   /photos/N
//   自拍   /amateurs/N
//   模特   /models  → /model/<id>（该模特的作品：视频 + 套图）
//   热门   /trend
//   详情   /video/<id>、/photo/<id>
//   搜索   /search?q=<词>
//
// 卡片：
//   <a href="/video/6ae4aea8d28b8"><span class="ph aspect-video">
//     <img src="https://r2.xchina.download/cover/6ae4aea8d28b8.webp">
//     <span class="cover-pill">模特私拍</span>
//     <span class="cover-pill tabular-nums">17:30</span>
//   套图的角标是「429P + 1V」这种
//
// 播放：<div id="video-player" data-src="/hls/<id>/master.m3u8">  → HLS
// 套图：img.xchina.io/photos/<id>/NNNNN_600x0.webp（_600x0 是尺寸后缀）
//
// 分类形式（2026-11-23 拍板 A）：内容类型做 tab，影片分类做二级 chips。

import { Spider, openWeb } from "catvod";

const BASE = "https://xchina.co";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

// 影片分类（作为「影片」tab 的二级 chips）
const VIDEO_CATS = [
  { slug: "jav", name: "日本AV" },
  { slug: "cn", name: "国产" },
  { slug: "movie", name: "电影" },
  { slug: "ai", name: "AI视频" },
  { slug: "other", name: "其他" },
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

/** 列表卡片：视频和套图两种结构，统一解析 */
function parseCards(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};

  // 以 <a href="/(video|photo)/xxx" 为锚点切块
  const marks = [];
  const re = /<a[^>]+href="\/(video|photo|amateur)\/([a-z0-9]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ at: m.index, kind: m[1], id: m[2] });
  }

  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].at;
    const to = i + 1 < marks.length ? marks[i + 1].at : Math.min(text.length, from + 3000);
    const b = text.substring(from, to);

    // 只要有封面的卡片：侧边栏/相关推荐里的纯文字链接会被排除
    if (b.indexOf("r2.xchina.download/cover/") < 0
        && b.indexOf("img.xchina.io/photos/") < 0
        && b.indexOf("img.xchina.io/amateurs/") < 0) continue;

    const key = marks[i].kind + "/" + marks[i].id;
    if (seen[key]) continue;
    seen[key] = 1;

    const img = b.match(/<img[^>]*src="([^"]+)"/);
    const alt = b.match(/<img[^>]*alt="([^"]*)"/);

    // 角标：取 cover-pill 里像「17:30」「429P + 1V」的那个
    let badge = "";
    const pills = b.match(/<span class="cover-pill[^"]*"[^>]*>([^<]{1,20})<\/span>/g) || [];
    for (const p of pills) {
      const t = clean(p);
      if (/^\d{1,2}:\d{2}/.test(t) || /^\d+\s*P/i.test(t) || /P\s*\+\s*\d+\s*V/i.test(t)) {
        badge = t;
        break;
      }
    }

    let name = clean(alt ? alt[1] : "");
    // 有的 alt 是「名字 名字」重复，去掉重复段
    const parts = name.split(" ");
    if (parts.length === 2 && parts[0] === parts[1]) name = parts[0];
    if (!name) {
      // 兜底：块内的标题文本
      const tt = b.match(/<span class="[^"]*truncate[^"]*"[^>]*>([^<]{1,60})</);
      if (tt) name = clean(tt[1]);
    }

    out.push({
      vod_id: BASE + "/" + marks[i].kind + "/" + marks[i].id,
      vod_name: name || (marks[i].kind + " " + marks[i].id),
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: badge,
    });
  }
  return out;
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|p):/, "");
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

export default class XChina extends Spider {
  init() { }

  async homeContent() {
    const classes = [
      { type_id: "video", type_name: "影片" },
      { type_id: "photo", type_name: "套图" },
      { type_id: "amateur", type_name: "自拍" },
      { type_id: "model", type_name: "模特" },
      { type_id: "trend", type_name: "热门" },
      { type_id: "web", type_name: "网页" },
    ];
    // 影片：二级 = 分类（media 组），三级 = 该分类下的系列（action("sub|<分类>")）
    const media = [{ n: "全部", v: "" }].concat(
      VIDEO_CATS.map((c) => ({ n: c.name, v: c.slug })));
    const filters = { video: [{ key: "media", name: "分类", value: media }] };
    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "video");
    const sub = (extend && extend.sub) ? String(extend.sub) : "";

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 影片 tab：三级结构 = 分类(media) → 系列(sub)
    if (t === "video") {
      const series = sub.indexOf("series:") === 0 ? sub.substring(7) : "";
      if (series) return this.listPage("/video-series/" + series, p);
      const media = (extend && extend.media) ? String(extend.media) : "";
      return this.listPage(media ? "/video-category/" + media : "/videos", p);
    }

    if (t === "photo") return this.listPage("/photos", p);
    if (t === "amateur") return this.listPage("/amateurs", p);
    if (t === "trend") return this.trendPage(p);

    // 模特 tab：模型索引（文字行，点了进该模特的作品列表）
    if (t === "model") {
      if (sub.indexOf("model:") === 0) return this.listPage("/model/" + sub.substring(6), p);
      return this.modelIndex();
    }

    return this.listPage("/videos", p);
  }

  /** 某个分类下的系列（三级 chips）；缓存 */
  async seriesOfCategory(slug) {
    if (!this.seriesCache) this.seriesCache = {};
    if (this.seriesCache[slug]) return this.seriesCache[slug];

    // 不返回空值项：App 会自动在 chips 行首插入一个「全部」
    const out = [];
    try {
      const r = await this.net.req(BASE + "/video-category/" + slug, { headers: hdrs() });
      if (r && r.code === 200) {
        const re = /<a href="\/video-series\/(\d+)"[^>]*>\s*([^<]{1,24})/g;
        let m;
        const seen = {};
        while ((m = re.exec(r.content)) !== null) {
          const id = m[1];
          const nm = clean(m[2]);
          if (!nm || seen[id]) continue;
          seen[id] = 1;
          out.push({ name: nm, value: "series:" + id });
        }
      }
    } catch (e) { }
    this.seriesCache[slug] = out;
    return out;
  }

  /** 热门榜：/trend 只有排名和标题（无封面），给前 N 个补抓详情页封面 */
  async trendPage(p) {
    let html = "";
    try {
      const r = await this.net.req(BASE + "/trend", { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const items = [];
    const seen = {};
    const re = /<a href="\/(video|photo|amateur)\/([a-z0-9]+)"[\s\S]{0,600}?<span class="block truncate group-hover:text-brand-600">([^<]{1,80})<\/span>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const kind = m[1], id = m[2];
      if (seen[kind + id]) continue;
      seen[kind + id] = 1;

      // 名次在锚点前面的序号 <span>
      const seg = html.substring(m.index, Math.min(html.length, m.index + 900));
      // 名次在锚点内部：<span class="w-8 ... tabular-nums ...">1</span>
      const rk = seg.match(/<span class="w-8[^"]*">\s*(\d{1,3})\s*<\/span>/)
        || seg.match(/tabular-nums[^"]*">\s*(\d{1,3})\s*<\/span>/);

      items.push({
        vod_id: BASE + "/" + kind + "/" + id,
        vod_name: clean(m[3]) || (kind + " " + id),
        vod_pic: "",
        vod_remarks: rk ? "#" + rk[1] : "",
      });
      if (items.length >= PAGE_SIZE) break;
    }

    await this.fillPics(items, 24);
    return this.page(items, p, PAGE_SIZE, items.length >= PAGE_SIZE ? (p + 1) * PAGE_SIZE : items.length);
  }

  /** 给没有封面的条目补抓详情页封面（限量 + 缓存） */
  async fillPics(items, limit) {
    if (!this.picCache) this.picCache = {};
    const cache = this.picCache;
    for (const it of items) {
      if (!it.vod_pic && cache[it.vod_id]) it.vod_pic = cache[it.vod_id];
    }
    const todo = items.filter((x) => !x.vod_pic).slice(0, limit);
    if (!todo.length) return;
    await Promise.all(todo.map(async (it) => {
      try {
        const r = await this.net.req(it.vod_id, { headers: hdrs(it.vod_id) });
        if (!r || r.code !== 200) return;
        const c = r.content.match(/property="og:image"[^>]*content="([^"]*)"/);
        const img = r.content.match(/<img[^>]*src="(https:\/\/img\.xchina\.io\/[^"]+)"/);
        const pic = c && c[1].indexOf("xchina") > 0 ? decode(c[1]) : (img ? decode(img[1]) : "");
        if (!pic) return;
        it.vod_pic = pic;
        cache[it.vod_id] = pic;
      } catch (e) { }
    }));
  }

  /** 通用列表页：/xxx/N（数字路径分页） */
  async listPage(base, p) {
    const url = BASE + base + (p <= 1 ? "" : "/" + p);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    const total = cards.length >= 12 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  /** 模特索引：一页 55+ 个，渲染成文字行 */
  async modelIndex() {
    const out = [];
    try {
      const r = await this.net.req(BASE + "/models", { headers: hdrs() });
      if (r && r.code === 200) {
        const re = /<a href="\/model\/([a-z0-9]+)"[\s\S]{0,400}?alt="([^"]*)"[\s\S]{0,400}?<span class="mt-2 block truncate[^"]*">([^<]{1,40})</g;
        let m;
        const seen = {};
        while ((m = re.exec(r.content)) !== null) {
          const id = m[1];
          if (seen[id]) continue;
          seen[id] = 1;
          out.push({
            vod_id: "model:" + id,
            vod_name: clean(m[3]) || clean(m[2]) || id,
            vod_pic: "",
            vod_remarks: "",
            vod_tag: "folder",
          });
        }
      }
    } catch (e) { }
    return this.page(out, 1, out.length || PAGE_SIZE, out.length);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }

    const isPhoto = url.indexOf("/photo/") > 0 || url.indexOf("/amateur/") > 0;

    // 标题
    let title = "";
    const t = html.match(/property="og:title"[^>]*content="([^"]*)"/) ||
      html.match(/<title>([^<]*)<\/title>/);
    if (t) {
      let raw = clean(t[1]);
      // 统一去掉尾巴「- 小黄书 xChina」
      raw = raw.replace(/\s*-\s*小黄书.*$/i, "").trim();
      // og:title 形如「标题 - 分类」，按 " - " 切后只取第一段（标题本身可能含空格，不含 " - "）
      const parts = raw.split(" - ");
      title = parts.length > 1 ? parts[0].trim() : raw;
    }

    // 封面
    const cov = html.match(/property="og:image"[^>]*content="([^"]*)"/);
    let pic = cov ? decode(cov[1]) : "";

    // 分类 / 模特 / 系列（面包屑）
    const lines = [];
    const crumbs = [];
    const cre = /<a href="\/(video-category|photo-category|video-series|photo-series|model)\/([^"]+)"[^>]*>([^<]{1,20})<\/a>/g;
    let cm;
    const seenC = {};
    while ((cm = cre.exec(html)) !== null) {
      const kind = cm[1], slug = cm[2], nm = clean(cm[3]);
      const key = kind + "/" + slug;
      if (seenC[key] || !nm) continue;
      seenC[key] = 1;
      crumbs.push({ kind: kind, slug: slug, name: nm });
    }
    if (crumbs.length) {
      lines.push(crumbs.map((c) => {
        const prefix = c.kind === "model" ? "m:" : (c.kind.indexOf("series") >= 0 ? "s:" : "g:");
        return '[a=cr:{"id":"' + prefix + c.slug + '"}/]' + c.name + "[/a]";
      }).join(" · "));
    }

    if (isPhoto) {
      const imgs = this.parseImages(html);
      if (imgs.length) {
        lines.push("共 " + imgs.length + " 张");
        pic = pic || imgs[0];
      }
      return {
        list: [{
          vod_id: url,
          vod_name: title || url,
          vod_pic: pic,
          vod_content: lines.join("\n"),
          vod_remarks: imgs.length ? imgs.length + "P" : "",
          gallery: true,
          vod_play_from: "xChina",
          vod_play_url: "图集$" + url,
        }],
      };
    }

    // 视频：data-src="/hls/<id>/master.m3u8"
    const sv = html.match(/data-src="(\/hls\/[^"]+\.m3u8[^"]*)"/);
    const playUrl = sv ? BASE + decode(sv[1]) : "";

    const dur = html.match(/<span class="[^"]*tabular-nums[^"]*"[^>]*>(\d{1,2}:\d{2}(?::\d{2})?)</);
    if (dur) lines.push("时长：" + clean(dur[1]));

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: pic,
        vod_content: lines.join("\n"),
        vod_remarks: dur ? clean(dur[1]) : "",
        gallery: false,          // 纯视频帖不给「查看图集」按钮
        vod_play_from: "xChina",
        vod_play_url: "正片$" + (playUrl || url),
      }],
    };
  }

  /** 套图详情里的图片（按文件名去重，_600x0 → 原图） */
  parseImages(html) {
    const out = [];
    const seen = {};
    const re = /https:\/\/img\.xchina\.io\/photos\/[a-z0-9]+\/[0-9]+(?:_600x0)?\.(?:webp|jpg|jpeg|png)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const u = m[0];
      const key = u.replace(/_\d+x\d+(?=\.)/, "");
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(u);
    }
    return out;
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    if (/\.m3u8/.test(url)) {
      return { parse: 1, url: url, header: { "User-Agent": UA, "Referer": BASE + "/" } };
    }
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    const sv = html.match(/data-src="(\/hls\/[^"]+\.m3u8[^"]*)"/);
    if (!sv) throw new Error("没找到播放地址");
    return { parse: 1, url: BASE + decode(sv[1]), header: { "User-Agent": UA, "Referer": BASE + "/" } };
  }

  async action(op) {
    if (!op) return [];

    // 三级 chips：某个分类下的系列
    if (op.indexOf("sub|") === 0) {
      const slug = op.substring(4);
      return await this.seriesOfCategory(slug);
    }

    // 图集
    if (op.indexOf("gal|") === 0) {
      const url = pageUrlOf(op.substring(4));
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }
      const imgs = this.parseImages(html);
      const tags = this.detailTags(html);
      return { list: imgs.map((u) => ({ url: u })), tags: tags };
    }

    return [];
  }

  /** 详情页的面包屑 → 标签 chips */
  detailTags(html) {
    const out = [];
    const re = /<a href="\/(video-category|video-series|model)\/([^"]+)"[^>]*>([^<]{1,20})<\/a>/g;
    let m;
    const seen = {};
    while ((m = re.exec(String(html || ""))) !== null) {
      const key = m[1] + "/" + m[2];
      if (seen[key]) continue;
      seen[key] = 1;
      const nm = clean(m[3]);
      if (!nm) continue;
      out.push({ name: nm, id: (m[1] === "model" ? "m:" : "g:") + m[2] });
    }
    return out.slice(0, 8);
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/search?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const total = cards.length >= 12 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
