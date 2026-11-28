import { Spider, openWeb } from "catvod";

// ============================================================
// MissKon（misskon.com）—— 纯图集站（用户确认；连 video 分类的 296 篇也没有可播放视频，
// 视频只以网盘外链存在：terabox / mediafire / mega / ouo 短链）
//
// 站点事实（2026-11-28 侦察）：
//   · WordPress + TIE 主题；REST API 开放
//   · 文章总数 51,152；标签 7,777；分类只有 6 个：
//       models(158, 15218) / chinese-models(2400, 35568) / asian-models(1, 365)
//       korean-models(398, 2) / vietnamese-models(781, 0) / video(163, 296)
//   · 列表：<article class="item-list"> + div.post-thumbnail>a>img + h2.post-box-title>a
//     每页 20 条，分页 /page/N/
//   · **张数直接写在 slug 里**：`...-27-photos`、`...-89-photos` → 角标 NP 不用抓详情
//   · 详情页内部分页：`<slug>/2/`、`<slug>/3/`…（每页 12 张，`a.post-page-numbers`）
//   · 搜索：`/?s=<kw>` 有效
//   · 分类形态（用户拍板 A）：一级 tab = 最新 + 5 个分类；标签 7777 进侧栏 + 搜索式分面
//   · 路由：config style.kind = "gallery"（纯图集站，点卡片直达图集）
// ============================================================

const BASE = "https://misskon.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 20;

// 一级分类（id 来自 /wp-json/wp/v2/categories）
const CATS = [
  { id: "158", name: "Models" },
  { id: "2400", name: "Chinese" },
  { id: "1", name: "Asian" },
  { id: "398", name: "Korean" },
  { id: "163", name: "Video" },
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

/** slug → 张数：`...-27-photos` → 27；`...-89-photos` → 89 */
function photosFromSlug(slug) {
  const m = String(slug || "").match(/(?:^|-)(\d{1,4})-photos?(?:-|$)/i);
  return m ? Number(m[1]) : 0;
}

// ── 列表解析 ──
function parseCards(html) {
  const src = String(html || "");
  const out = [];
  const seen = {};
  const re = /<article[^>]*class="[^"]*item-list[^"]*"[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const b = m[0];
    const a = b.match(/<a[^>]+href="(https:\/\/misskon\.com\/([a-z0-9\-]+)\/)"[^>]*>/i);
    if (!a) continue;
    const url = a[1], slug = a[2];
    if (seen[url]) continue;
    seen[url] = 1;

    let title = "";
    const h2 = b.match(/<h2[^>]*class="[^"]*post-box-title[^"]*"[^>]*>[\s\S]{0,80}?<a[^>]*>([\s\S]{0,200}?)<\/a>/i);
    if (h2) title = strip(h2[1]);
    if (!title) {
      const at = b.match(/<a[^>]+title="([^"]{2,200})"/i);
      if (at) title = strip(at[1]);
    }
    if (!title) title = slug;

    let pic = "";
    const im = b.match(/<img[^>]+src="([^"]+)"/i) || b.match(/<img[^>]+data-src="([^"]+)"/i);
    if (im) pic = abs(im[1]);

    const n = photosFromSlug(slug);
    out.push({ url: url, slug: slug, title: title, pic: pic, photos: n });
  }
  return out;
}

export default class MissKon extends Spider {
  init() {
    this.tagCache = null;
  }

  async getHtml(url, ref) {
    const r = await this.net.req(url, {
      headers: {
        "User-Agent": UA,
        "Referer": ref || BASE + "/",
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: 1,
    });
    const c = r && (r.content !== undefined ? r.content : r.body);
    return typeof c === "string" ? c : "";
  }

  async getJson(url) {
    const t = await this.getHtml(url);
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

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      // 纯图集站：有张数就写 NP（App 据此显示「图集」按钮并直达图集）
      vod_remarks: c.photos > 0 ? c.photos + "P" : "图集",
      vod_type: "gallery",
    }));
  }

  async listFrom(url, pg) {
    const html = await this.getHtml(url);
    const cards = parseCards(html);
    const list = this.cardsToList(cards);
    const hasMore = cards.length >= PAGE_SIZE - 2;
    const total = hasMore ? pg * PAGE_SIZE + 1 : (pg - 1) * PAGE_SIZE + cards.length;
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
      // 走 REST：分类过滤 + 分页（比抓 HTML 快且稳）
      const id = t.substring(4);
      const arr = await this.getJson(
        BASE + "/wp-json/wp/v2/posts?categories=" + id +
        "&per_page=" + PAGE_SIZE + "&page=" + p +
        "&_fields=id,slug,link,title,date");
      if (!arr || !arr.length) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
      const cards = arr.map((x) => {
        const slug = String(x.slug || "");
        const link = String(x.link || BASE + "/" + slug + "/");
        const title = x.title && x.title.rendered ? strip(x.title.rendered) : slug;
        const n = photosFromSlug(slug);
        return { url: link, slug: slug, title: title, pic: "", photos: n };
      });
      const list = this.cardsToList(cards);
      const total = arr.length >= PAGE_SIZE ? p * PAGE_SIZE + 1 : (p - 1) * PAGE_SIZE + arr.length;
      return this.page(list, p, PAGE_SIZE, total);
    }

    // 最新：直接抓列表页（有封面）
    const url = BASE + (p > 1 ? "/page/" + p + "/" : "/");
    return this.listFrom(url, p);
  }

  // ── 详情 ──
  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const html = await this.getHtml(pageUrl);
    if (!html) return { list: [] };

    const slug = (pageUrl.replace(BASE, "").split("/").filter(Boolean)[0] || "");
    const photos = photosFromSlug(slug);

    let title = "";
    const og = html.match(/<meta\s+property="og:title"\s+content="([^"]{1,200})"/i);
    if (og) title = strip(og[1]).replace(/\s*[-–]\s*MissKon\.com\s*$/i, "");
    if (!title) {
      const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
      if (h1) title = strip(h1[1]);
    }

    let pic = "";
    const oi = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (oi) pic = abs(oi[1]);

    // 标签：详情页里的 /tag/ 链接（cosplayer / 作品名都在这里）
    const tags = [];
    const seen = {};
    let m;
    const tre = /<a[^>]+href="https:\/\/misskon\.com\/tag\/([^"\/]+)\/"[^>]*>([\s\S]{0,80}?)<\/a>/gi;
    while ((m = tre.exec(html)) !== null) {
      const ts = m[1];
      if (seen[ts]) continue;
      seen[ts] = 1;
      const nm = strip(m[2]);
      if (!nm) continue;
      tags.push({ slug: ts, name: nm });
      if (tags.length >= 30) break;
    }

    // 简介：略过 INFORMATION 框，取正文第一段可读文字
    let desc = "";
    const md = html.match(/<meta\s+property="og:description"\s+content="([^"]{0,400})"/i);
    if (md) desc = strip(md[1]);

    const lines = [];
    if (tags.length) {
      lines.push(tags.map((x) => "[a=cr:{\"id\":\"tag:" + x.slug + "\"}/]" + x.name + "[/a]").join(" "));
    }
    if (desc) lines.push(desc);

    return {
      list: [{
        vod_id: pageUrl,
        vod_name: title || slug,
        vod_pic: pic,
        vod_remarks: photos > 0 ? photos + "P" : "",
        vod_content: lines.join("\n"),
        // 图集站：没有播放列表，靠 gallery + gal|
        vod_play_from: "",
        vod_play_url: "",
        gallery: true,
      }],
    };
  }

  /** 图集：帖子内部有分页（/slug/2/ …），逐页取 data-src 原图 */
  async galleryImages(pageUrl) {
    const base = pageUrl.replace(/\/$/, "");
    const imgs = [];
    const seen = {};
    let page = 1;
    let maxPage = 1;
    let guard = 0;

    while (page <= 60 && guard++ < 60) {
      const u = page === 1 ? base + "/" : base + "/" + page + "/";
      const html = await this.getHtml(u, pageUrl);
      if (!html) break;

      let added = 0;
      const re = /data-src="(https:\/\/kul\.misskon\.com\/[^"]+?\.(?:webp|jpe?g|png|gif))"/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const src = m[1];
        if (seen[src]) continue;
        seen[src] = 1;
        imgs.push(src);
        added++;
      }

      // 分页深度：把本页出现的所有「/slug/<数字>/」都算进最大页码（含 next 链接）
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pre = new RegExp(esc + "\\/(\\d+)\\/", "gi");
      while ((m = pre.exec(html)) !== null) {
        const n = Number(m[1]);
        if (n > maxPage && n < 200) maxPage = n;
      }

      if (added === 0 || page >= maxPage) break;
      page++;
    }
    return imgs;
  }

  async playerContent() {
    return { parse: 0, url: "", msg: "纯图集站，没有视频" };
  }

  // ── 搜索 ──
  async searchContent(key, quick, pg) {
    const p = Math.max(1, Number(pg) || 1);
    const kw = String(key || "").trim();
    if (!kw) return this.page([], p, PAGE_SIZE, 0);
    const url = BASE + "/?s=" + encodeURIComponent(kw) + (p > 1 ? "&paged=" + p : "");
    return this.listFrom(url, p);
  }

  // ── 侧栏：热门标签（count 排序）+ 搜索式分面 ──
  async topTags() {
    if (this.tagCache) return this.tagCache;
    const arr = await this.getJson(
      BASE + "/wp-json/wp/v2/tags?per_page=60&orderby=count&order=desc&_fields=id,name,slug,count");
    const out = (arr || []).map((x) => ({
      id: "tag:" + x.slug,
      name: strip(x.name) || x.slug,
      count: String(x.count || ""),
    }));
    this.tagCache = out;
    return out;
  }

  async action(action) {
    const raw = String(action || "");

    // 图集：gal|<页面URL> → { list: [{url}] }
    if (raw.indexOf("gal|") === 0) {
      const u = raw.substring(4).replace(/^gal:\/\//, "");
      const pageUrl = u.indexOf("http") === 0 ? u : BASE + u;
      const imgs = await this.galleryImages(pageUrl);
      return { list: imgs.map((x) => ({ url: x })) };
    }

    if (raw.indexOf("side|") === 0) {
      const groups = [];
      try {
        const top = await this.topTags();
        if (top.length) groups.push({ name: "热门标签", facet: "tagsearch", items: top });
      } catch (e) { }
      return { groups: groups };
    }

    if (raw.indexOf("facet|") === 0) {
      const parts = raw.split("|");
      const kind = String(parts[1] || "");
      const kw = String(parts[2] || "").trim();
      const pg = Math.max(1, Number(parts[3] || 1) || 1);
      if (kind === "tags") {
        const q = BASE + "/wp-json/wp/v2/tags?per_page=100&page=" + pg +
          (kw ? "&search=" + encodeURIComponent(kw) : "&orderby=count&order=desc") +
          "&_fields=id,name,slug,count";
        const arr = await this.getJson(q);
        const items = (arr || []).map((x) => ({
          id: "tag:" + x.slug,
          name: strip(x.name) || x.slug,
          count: String(x.count || ""),
        }));
        return { items: items };
      }
      return { items: [] };
    }

    return "";
  }
}
