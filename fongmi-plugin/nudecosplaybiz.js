import { Spider, openWeb } from "catvod";

// ============================================================
// Nudecosplay.biz（nudecosplay.biz）—— 纯图集站（用户确认）
//
// 站点事实（2026-11-28 侦察）：
//   · WordPress 7.x + jNews 主题，REST API 开放
//   · 文章总数 5,525；分类只有 4 个（无标签体系）：
//       ero-cosplay(1790, 5066) / nude(1794, 1874) / online-video(1806, 1047) / sexy-set(1811, 459)
//   · 列表：div.jeg_post（30/页）+ h3.jeg_post_title>a + 封面 img；分页 /page/N/
//   · 详情：entry-content 里 10~50 张图（data-src），**无内部分页**、无视频
//   · **站点没有相关推荐块** → 相关推荐按站点为准，给 0 条
//   · 搜索：/?s= 有效（不存在的词返回 0 条）
//   · 分类形态（用户拍板 A）：一级 tab = 最新 + 4 个分类
//   · 张数角标：REST 一次拉 30 篇带 content → 数 <img> 即得张数（零额外请求）
// ============================================================

const BASE = "https://nudecosplay.biz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 30;

const CATS = [
  { id: "1790", name: "Ero Cosplay" },
  { id: "1794", name: "Nude" },
  { id: "1806", name: "Online Video" },
  { id: "1811", name: "Sexy Set" },
];

// ── 工具 ──
function strip(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#8211;|&ndash;/g, "–").replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, c) => { try { return String.fromCharCode(Number(c)); } catch (e) { return " "; } })
    .replace(/\s+/g, " ")
    .trim();
}

function abs(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.indexOf("//") === 0) return "https:" + s;
  if (s.indexOf("http") === 0) return s;
  return BASE + (s.charAt(0) === "/" ? s : "/" + s);
}

const IMG_RE = /(?:data-src|src)="(https?:\/\/[^"]+?\.(?:webp|jpe?g|png|gif))"/gi;

/** 站点封面是 3 图拼图（文件名带 -Cover-），图集里不该出现 → 剔掉 */
function isCover(u) {
  return /-Cover-/i.test(String(u || ""));
}

/** 从 HTML 片段里按顺序取图（去重） */
function imagesOf(html) {
  const out = [];
  const seen = {};
  let m;
  const re = new RegExp(IMG_RE.source, "gi");
  while ((m = re.exec(String(html || ""))) !== null) {
    const src = m[1];
    if (seen[src]) continue;
    seen[src] = 1;
    out.push(src);
  }
  return out;
}

/** HTML 列表页（搜索/兜底用） */
function parseCards(html) {
  const src = String(html || "");
  const out = [];
  const seen = {};
  const re = /<div[^>]*class="[^"]*jeg_post\b[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*jeg_post\b|$)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const b = m[0];
    const a = b.match(/<h3[^>]*class="[^"]*jeg_post_title[^"]*"[^>]*>[\s\S]{0,120}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/i)
      || b.match(/<a[^>]+href="(https:\/\/nudecosplay\.biz\/[a-z0-9\-]+\/)"[^>]*>([\s\S]{0,120}?)<\/a>/i);
    if (!a) continue;
    const url = a[1];
    if (seen[url]) continue;
    seen[url] = 1;
    const im = b.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
    out.push({ url: url, title: strip(a[2]) || url, pic: im ? abs(im[1]) : "", photos: 0 });
  }
  return out;
}

/** 相关推荐：站点自带「Related Posts」块（jnews_related_post_container，实测 6 条）
 *  注意标题在 HTML 里是 Related<strong> Posts</strong>，直接搜 "Related Posts" 搜不到 */
function parseRelated(html) {
  const src = String(html || "");
  const i = src.indexOf('jnews_related_post_container');
  if (i < 0) return [];
  let end = src.indexOf('<script', i);
  if (end < 0) end = Math.min(src.length, i + 30000);
  const blk = src.substring(i, end);

  const out = [];
  const seen = {};
  const re = /<(?:article|div)[^>]*class="[^"]*jeg_post\b[^"]*"[\s\S]*?(?=<(?:article|div)[^>]*class="[^"]*jeg_post\b|$)/g;
  let m;
  while ((m = re.exec(blk)) !== null) {
    const b = m[0];
    const a = b.match(/<a[^>]+href="(https:\/\/nudecosplay\.biz\/[a-z0-9\-]+\/)"/i);
    if (!a) continue;
    const url = a[1];
    if (seen[url]) continue;
    seen[url] = 1;

    let title = "";
    const tt = b.match(/class="jeg_post_title"[^>]*>[\s\S]{0,80}?<a[^>]*>([\s\S]{0,200}?)<\/a>/i)
      || b.match(/<img[^>]+alt="([^"]{1,200})"/i);
    if (tt) title = strip(tt[1]);
    if (!title) title = url.replace(/\/$/, "").split("/").pop();

    const im = b.match(/<img[^>]+(?:data-src|src)="(https?:\/\/[^"]+\.(?:webp|jpe?g|png))"/i);
    out.push({ url: url, title: title, pic: im ? abs(im[1]) : "" });
  }
  return out;
}

export default class NudeCosplayBiz extends Spider {
  init() {
    this.cache = {};
  }

  async req(url) {
    const r = await this.net.req(url, {
      headers: {
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: 1,
    });
    const c = r && (r.content !== undefined ? r.content : r.body);
    return typeof c === "string" ? c : "";
  }

  async json(url) {
    const t = await this.req(url);
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  page(list, pg, limit, total) {
    return {
      list: list || [],
      page: pg,
      limit: limit,
      total: total || (list ? list.length : 0),
      pagecount: Math.max(1, Math.ceil((total || 0) / Math.max(1, limit))),
    };
  }

  /** REST → 卡片（一次请求带 content，张数免费算出） */
  toCards(arr) {
    return (arr || []).map((x) => {
      const content = (x.content && x.content.rendered) || "";
      const allImgs = imagesOf(content);
      const imgs = allImgs.filter((u) => !isCover(u));
      const slug = String(x.slug || "");
      const link = String(x.link || BASE + "/" + slug + "/");
      const title = x.title && x.title.rendered ? strip(x.title.rendered) : slug;
      return {
        url: link,
        slug: slug,
        title: title,
        pic: allImgs.length ? allImgs[0] : "",
        photos: imgs.length,
      };
    });
  }

  toList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.photos > 0 ? c.photos + "P" : "图集",
      vod_type: "gallery",
    }));
  }

  async restList(query, pg, totalHint) {
    const url = BASE + "/wp-json/wp/v2/posts?per_page=" + PAGE_SIZE + "&page=" + pg +
      "&_fields=id,slug,link,title,content,categories,date" + (query || "");
    const arr = await this.json(url);
    if (!arr || !arr.length) return this.page([], pg, PAGE_SIZE, (pg - 1) * PAGE_SIZE);
    const list = this.toList(this.toCards(arr));
    const total = arr.length >= PAGE_SIZE ? pg * PAGE_SIZE + 1 : (pg - 1) * PAGE_SIZE + arr.length;
    return this.page(list, pg, PAGE_SIZE, total);
  }

  // ── 首页 / 分类 ──
  async homeContent() {
    const cls = [{ type_id: "latest", type_name: "最新" }];
    for (const c of CATS) cls.push({ type_id: "cat:" + c.id, type_name: c.name });
    return { class: cls };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Math.max(1, Number(pg) || 1);
    const t = String(tid || "latest");
    if (t.indexOf("cat:") === 0) {
      return this.restList("&categories=" + t.substring(4), p);
    }
    return this.restList("", p);
  }

  // ── 详情 ──
  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const slug = (pageUrl.replace(BASE, "").split("/").filter(Boolean)[0] || "").replace(/\.html$/, "");

    // 优先 REST（一次拿到全部图片 + 标题 + 日期），失败再抓 HTML
    let title = "", imgs = [], cats = "";
    if (slug) {
      const arr = await this.json(BASE + "/wp-json/wp/v2/posts?slug=" + encodeURIComponent(slug) +
        "&_fields=id,slug,link,title,content,categories,date");
      if (arr && arr.length) {
        const x = arr[0];
        title = strip((x.title && x.title.rendered) || slug);
        const allD = imagesOf((x.content && x.content.rendered) || "");
        imgs = allD.filter((u) => !isCover(u));
        if (!imgs.length) imgs = allD;
        const ids2 = (x.categories || []).map(String);
        cats = ids2.map((id) => (CATS.find((c) => c.id === id) || {}).name).filter(Boolean).join(" / ");
      }
    }

    if (!imgs.length) {
      const html = await this.req(pageUrl);
      if (!html) return { list: [] };
      const og = html.match(/<meta\s+property="og:title"\s+content="([^"]{1,200})"/i);
      if (og && !title) title = strip(og[1]);
      const body = html.substring(Math.max(0, html.indexOf("entry-content")));
      const allH = imagesOf(body);
      imgs = allH.filter((u) => !isCover(u));
      if (!imgs.length) imgs = allH;
      const cs = [];
      const cre = /\/category\/([a-z0-9\-]+)\//gi;
      let m;
      while ((m = cre.exec(html)) !== null) {
        const nm = (CATS.find((c) => c.name.toLowerCase().replace(/\s+/g, "-") === m[1]) || {}).name;
        if (nm && cs.indexOf(nm) < 0) cs.push(nm);
        if (cs.length > 4) break;
      }
      cats = cs.join(" / ");
    }

    const lines = [];
    if (cats) lines.push("分类：" + cats);
    lines.push("共 " + imgs.length + " 张");

    const self = {
      vod_id: pageUrl,
      vod_name: title || slug,
      vod_pic: imgs.length ? imgs[0] : "",
      vod_remarks: imgs.length + "P",
      vod_content: lines.join("\n"),
      vod_play_from: "",
      vod_play_url: "",
      gallery: true,
    };

    // 相关推荐：站点自带 Related Posts 块，有几个给几个
    let rel = [];
    try {
      const html = await this.req(pageUrl);
      rel = parseRelated(html).filter((x) => x.url !== pageUrl).slice(0, 8).map((x) => ({
        vod_id: x.url,
        vod_name: x.title,
        vod_pic: x.pic,
        vod_remarks: "",
        vod_type: "gallery",
      }));
    } catch (e) { }

    return { list: [self].concat(rel) };
  }

  /** 图集：REST 一次拿全（无内部分页） */
  async galleryImages(pageUrl) {
    const slug = (pageUrl.replace(BASE, "").split("/").filter(Boolean)[0] || "").replace(/\.html$/, "");
    if (slug) {
      const arr = await this.json(BASE + "/wp-json/wp/v2/posts?slug=" + encodeURIComponent(slug) +
        "&_fields=content");
      if (arr && arr.length) {
        const all = imagesOf((arr[0].content && arr[0].content.rendered) || "");
        const imgs = all.filter((u) => !isCover(u));
        if (imgs.length) return imgs;
        if (all.length) return all;
      }
    }
    const html = await this.req(pageUrl);
    const body = html.substring(Math.max(0, html.indexOf("entry-content")));
    return imagesOf(body);
  }

  async playerContent() {
    return { parse: 0, url: "", msg: "纯图集站，没有视频" };
  }

  // ── 搜索（REST 优先，失败退回 /?s=）──
  async searchContent(key, quick, pg) {
    const p = Math.max(1, Number(pg) || 1);
    const kw = String(key || "").trim();
    if (!kw) return this.page([], p, PAGE_SIZE, 0);
    const arr = await this.json(BASE + "/wp-json/wp/v2/posts?search=" + encodeURIComponent(kw) +
      "&per_page=" + PAGE_SIZE + "&page=" + p + "&_fields=id,slug,link,title,content");
    if (arr && arr.length) {
      const list = this.toList(this.toCards(arr));
      const total = arr.length >= PAGE_SIZE ? p * PAGE_SIZE + 1 : (p - 1) * PAGE_SIZE + arr.length;
      return this.page(list, p, PAGE_SIZE, total);
    }
    const html = await this.req(BASE + "/?s=" + encodeURIComponent(kw) + (p > 1 ? "&paged=" + p : ""));
    const cards = parseCards(html);
    return this.page(this.toList(cards), p, PAGE_SIZE, cards.length);
  }

  // ── 没有标签体系 → 侧栏不渲染 ──
  async action(action) {
    const raw = String(action || "");
    if (raw.indexOf("gal|") === 0) {
      const u = raw.substring(4).replace(/^gal:\/\//, "");
      const pageUrl = u.indexOf("http") === 0 ? u : BASE + u;
      const imgs = await this.galleryImages(pageUrl);
      return { list: imgs.map((x) => ({ url: x })) };
    }
    if (raw.indexOf("side|") === 0) return { groups: [] };
    return "";
  }
}
