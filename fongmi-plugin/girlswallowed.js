import { Spider, openWeb } from "catvod";

// ============================================================
// GirlSwallowed（girlswallowed.com）—— 纯视频站
// 站点事实（2026-11-26 侦察）：
//   · WordPress + retrotube 主题，且是 simply-static 静态镜像
//   · 列表：<article class="loop-video thumb-block …">，含 permalink / img / span.duration / span.hd-video
//   · 分页：/page/N/（1 起）
//   · 没有分类归档页（/category/xxx/ 全 404）；可浏览维度是：
//       系列/站点页 7 个、标签 /tag/<slug>/（约 1000 个）、演员 /actor/<slug>/（约 1260 个）
//   · 搜索：/?s= 被静态镜像忽略（返回首页）→ searchContent 返回空
//   · 播放：详情页只有 <iframe src="https://voe.sx/e/…">，voe 带 JS 反爬（PC 直取 403）
//           → 用户决定「先不做播放」，playerContent 返回空
//   · 分类形态（用户拍板 C）：一级 tab = 最新 / 系列（chips）；标签与演员全部进侧边抽屉
// ============================================================

const BASE = "https://girlswallowed.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

// 系列 / 站点页（导航里的一级页，2026-11-26）
const SERIES = [
  { slug: "all-swallowed-videos", name: "All Swallowed" },
  { slug: "swallowed-com-updates", name: "Swallowed 更新" },
  { slug: "trueanal-com-updates", name: "TrueAnal 更新" },
  { slug: "allanal-com-updates", name: "AllAnal 更新" },
  { slug: "nympho", name: "Nympho" },
  { slug: "mike-adriano-evilangel", name: "EvilAngel" },
  { slug: "mike-adriano-4k-upscale", name: "4K 修复" },
];

// ── 通用小工具 ──
function strip(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
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

/** slug → 可读名：lucy-mochi → Lucy Mochi */
function pretty(slug) {
  return String(slug || "").split("-").filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** ISO8601 时长（P0DT0H52M39S）→ mm:ss */
function isoDuration(v) {
  const m = String(v || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return "";
  const d = Number(m[1] || 0), h = Number(m[2] || 0), mi = Number(m[3] || 0), se = Number(m[4] || 0);
  let total = d * 86400 + h * 3600 + mi * 60 + se;
  if (!total) return "";
  const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
  const p2 = (n) => (n < 10 ? "0" + n : "" + n);
  return hh > 0 ? hh + ":" + p2(mm) + ":" + p2(ss) : mm + ":" + p2(ss);
}

// ── 列表 / 详情解析 ──
function parseCards(html) {
  const src = String(html || "");
  const out = [];
  const seen = {};
  const re = /<article[^>]*>[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const b = m[0];
    if (b.indexOf("loop-video") < 0) continue;

    const a = b.match(/<a[^>]+href="(https:\/\/girlswallowed\.com\/[a-z0-9\-]+\/)"[^>]*>/i);
    if (!a) continue;
    const url = a[1];
    if (seen[url]) continue;
    seen[url] = 1;

    // 标题：优先 <a title="…">，其次 img alt，最后拿 h2 里的 <a> 文本
    let title = "";
    const at = b.match(/<a[^>]+title="([^"]{2,200})"/i);
    if (at) title = strip(at[1]);
    if (!title) {
      const alt = b.match(/<img[^>]+alt="([^"]{2,200})"/i);
      if (alt) title = strip(alt[1]);
    }
    if (!title) {
      const h2 = b.match(/<h2[^>]*>[\s\S]{0,120}?<a[^>]*>([\s\S]{0,200}?)<\/a>/i);
      if (h2) title = strip(h2[1]);
    }
    if (!title) title = pretty(url.replace(BASE, "").split("/").filter(Boolean)[0] || "video");

    // 封面：data-src 优先（懒加载），其次 src
    let pic = "";
    const im = b.match(/<img[^>]+(?:data-src|data-original)="([^"]+)"/i) || b.match(/<img[^>]+src="([^"]+)"/i);
    if (im) pic = abs(im[1]);

    // 时长：span.duration / div.duration 里的 mm:ss
    let dur = "";
    const dm = b.match(/<div[^>]*class="[^"]*duration[^"]*"[^>]*>\s*([\d:]{3,10})\s*</i) ||
               b.match(/<span[^>]*class="[^"]*duration[^"]*"[^>]*>\s*([\d:]{3,10})\s*</i);
    if (dm) dur = dm[1].trim();

    // 画质：span.hd-video 的文本（HD / 4K）
    let q = "";
    const qm = b.match(/<span[^>]*class="[^"]*hd-video[^"]*"[^>]*>([^<]{1,12})</i);
    if (qm) q = strip(qm[1]).toUpperCase();

    out.push({
      url: url,
      title: title,
      pic: pic,
      // 「类型|时长」→ App 把类型画在左上角、时长画在右下角
      remark: q ? q + "|" + (dur || "") : (dur || ""),
    });
  }
  return out;
}

function parseDetail(html, pageUrl) {
  const t = String(html || "");

  let title = "";
  const og = t.match(/<meta\s+property="og:title"\s+content="([^"]{1,200})"/i);
  if (og) title = strip(og[1]);
  if (!title) {
    const h1 = t.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
    if (h1) title = strip(h1[1]);
  }

  let pic = "";
  const oi = t.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (oi) pic = abs(oi[1]);

  let dur = "";
  const dm = t.match(/itemprop="duration"\s+content="([^"]+)"/i);
  if (dm) dur = isoDuration(dm[1]);

  // 演员 / 标签：站点详情页里就是这两组链接
  // 注意：锚点里面往往包着整块缩略图，</a> 可能很远 → 只从标签属性里取名字
  function linksByPrefix(text, prefix) {
    const out = [];
    const seen = {};
    const re = new RegExp('<a[^>]+href="https:\\/\\/girlswallowed\\.com\\/' + prefix +
      '\\/([a-z0-9\\-]+)\\/"[^>]*>', "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      const tag = m[0];
      const tm = tag.match(/title="([^"]{1,120})"/i) || tag.match(/alt="([^"]{1,120})"/i);
      out.push({ slug: slug, name: tm ? strip(tm[1]) : pretty(slug) });
    }
    return out;
  }

  const actors = linksByPrefix(t, "actor").slice(0, 12);
  const tags = linksByPrefix(t, "tag").slice(0, 40);

  // 简介：itemprop description / og:description，去掉开头的下载提示
  let desc = "";
  let dd = t.match(/<meta\s+itemprop="description"\s+content="([\s\S]{0,3000}?)"/i);
  if (!dd) dd = t.match(/<meta\s+property="og:description"\s+content="([^"]{0,2000})"/i);
  if (dd) {
    desc = strip(dd[1])
      .replace(/^DOWNLOAD\s*&\s*STREAM\s*ONLINE[^A-Za-z]{0,8}/i, "")
      .replace(/FREE\s+DOWNLOAD\s*/gi, "")
      .replace(/^\d+(\.\d+)?\s*GB\s*/gi, "");
  }

  const lines = [];
  if (actors.length) {
    lines.push(actors.map((x) => "[a=cr:{\"id\":\"actor:" + x.slug + "\"}/]" + x.name + "[/a]").join(" "));
  }
  if (tags.length) {
    lines.push(tags.map((x) => "[a=cr:{\"id\":\"tag:" + x.slug + "\"}/]" + x.name + "[/a]").join(" "));
  }

  return {
    vod_id: pageUrl,
    vod_name: title || pageUrl,
    vod_pic: pic,
    vod_remarks: dur,
    vod_content: lines.join("\n") + (desc ? "\n简介：" + desc : ""),
    // 播放：voe.sx 需要跑 JS 挑战，用户决定先不做 → 不给选集
    vod_play_from: "",
    vod_play_url: "",
    gallery: false,
  };
}

export default class GirlSwallowed extends Spider {
  init() {
    this.catCache = null;
  }

  async getHtml(url, ref) {
    const r = await this.net.req(url, {
      headers: {
        "User-Agent": UA,
        "Referer": ref || BASE + "/",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: 1,
    });
    const c = r && (r.content !== undefined ? r.content : r.body);
    return typeof c === "string" ? c : "";
  }

  page(list, pg, limit, total) {
    return {
      list: list || [],
      page: pg,
      limit: limit,
      total: total || (list ? list.length : 0),
      pagecount: Math.max(1, Math.ceil((total || 0) / limit)),
    };
  }

  /** 列表页通用：url 里已含分页时直接抓 */
  async listFrom(url, pg) {
    const html = await this.getHtml(url);
    const cards = parseCards(html);
    const list = cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.remark,
      vod_type: "video",
    }));
    // 站点一页给很多条（实测 170+），所以 limit 用实际条数；
    // 满页推定：这一页差不多给满 → 认为还有下一页
    const limit = cards.length || PAGE_SIZE;
    const hasMore = cards.length >= PAGE_SIZE;
    const total = hasMore ? pg * limit + 1 : (pg - 1) * limit + cards.length;
    return this.page(list, pg, limit, total);
  }

  // ── 分类 / 筛选 ──
  async homeContent() {
    const media = [{ n: "全部", v: "" }];
    for (const s of SERIES) media.push({ n: s.name, v: "s:" + s.slug });

    return {
      class: [{ type_id: "latest", type_name: "最新" }],
      filters: {
        latest: [{ key: "media", name: "系列", value: media }],
      },
    };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const ext = extend || {};
    const media = String(ext.media || "");
    let path = "";

    if (media.indexOf("s:") === 0) {
      path = "/" + media.substring(2) + "/";
    } else if (media.indexOf("tag:") === 0) {
      path = "/tag/" + media.substring(4) + "/";
    } else if (media.indexOf("actor:") === 0) {
      path = "/actor/" + media.substring(6) + "/";
    } else {
      const t = String(tid || "");
      if (t.indexOf("tag:") === 0) path = "/tag/" + t.substring(4) + "/";
      else if (t.indexOf("actor:") === 0) path = "/actor/" + t.substring(6) + "/";
      else if (t.indexOf("s:") === 0) path = "/" + t.substring(2) + "/";
      else path = "/";
    }

    const url = BASE + path + (p > 1 ? "page/" + p + "/" : "");
    return this.listFrom(url, p);
  }

  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const html = await this.getHtml(pageUrl);
    if (!html) return { list: [] };
    return { list: [parseDetail(html, pageUrl)] };
  }

  /** 播放：本站播放器是 voe.sx 的 iframe，需要 JS 挑战；按用户决定暂不实现 */
  async playerContent(flag, id, flags) {
    return { parse: 0, url: "", msg: "本站暂不支持播放（播放器在 voe.sx，需要网页环境）" };
  }

  /** 站点搜索被静态镜像忽略（/?s= 返回首页）→ 不做搜索 */
  async searchContent(key, quick, pg) {
    return this.page([], Number(pg) || 1, PAGE_SIZE, 0);
  }

  // ── 侧边抽屉：标签（约 1000）/ 演员（约 1260）──
  async sideTags() {
    if (this.tagCache) return this.tagCache;
    const html = await this.getHtml(BASE + "/tags/");
    const out = [];
    const seen = {};
    let m;
    const re = /<a[^>]+href="https:\/\/girlswallowed\.com\/tag\/([a-z0-9\-]+)\/"[^>]*>/gi;
    while ((m = re.exec(html)) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      const tm = m[0].match(/title="([^"]{1,120})"/i) || m[0].match(/alt="([^"]{1,120})"/i);
      out.push({ id: "tag:" + slug, name: tm ? strip(tm[1]) : pretty(slug) });
    }
    this.tagCache = out;
    return out;
  }

  async action(action) {
    const raw = String(action || "");

    if (raw.indexOf("side|") === 0) {
      const groups = [];
      try {
        const tags = await this.sideTags();
        groups.push({
          name: "标签（" + tags.length + "）",
          facet: "tagsearch",
          items: tags.slice(0, 60),
        });
      } catch (e) { }
      try {
        const act = await this.facetActors("", 1);
        groups.push({
          name: "演员",
          facet: "actorsearch",
          items: (act || []).slice(0, 60),
        });
      } catch (e) { }
      return JSON.stringify({ groups: groups });
    }

    if (raw.indexOf("facet|") === 0) {
      const parts = raw.split("|");
      const kind = String(parts[1] || "");
      const kw = String(parts[2] || "").toLowerCase().trim();
      const pg = Number(parts[3] || 1) || 1;

      if (kind === "tags") {
        const all = await this.sideTags();
        const hit = kw
          ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0 || x.id.toLowerCase().indexOf(kw) >= 0)
          : all;
        const slice = hit.slice((pg - 1) * 100, pg * 100);
        return JSON.stringify({ items: slice });
      }
      if (kind === "actor") {
        const list = await this.facetActors(kw, pg);
        return JSON.stringify({ items: list });
      }
      return JSON.stringify({ items: [] });
    }
    return "";
  }

  /** 演员候选：/actors/page/N/ 每页 60 个；有关键字时在本页内过滤 */
  async facetActors(kw, pg) {
    const page = Math.max(1, Number(pg) || 1);
    const html = await this.getHtml(BASE + "/actors/" + (page > 1 ? "page/" + page + "/" : ""));
    const out = [];
    const seen = {};
    let m;
    const re = /<a[^>]+href="https:\/\/girlswallowed\.com\/actor\/([a-z0-9\-]+)\/"[^>]*>/gi;
    while ((m = re.exec(html)) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      const tm = m[0].match(/title="([^"]{1,120})"/i) || m[0].match(/alt="([^"]{1,120})"/i);
      const name = tm ? strip(tm[1]) : pretty(slug);
      if (kw && name.toLowerCase().indexOf(kw) < 0 && slug.indexOf(kw) < 0) continue;
      out.push({ id: "actor:" + slug, name: name });
    }
    return out;
  }
}
