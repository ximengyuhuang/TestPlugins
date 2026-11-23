// Javtiful（javtiful.com /zh）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯视频（无图集）
//
//   推荐   /zh/foryou                    服务端每次随机 → 下拉刷新 = 换一批
//   视频   /zh/videos                    全部
//          /zh/censored                  有码
//          /zh/uncensored                无码
//          /zh/reducing-mosaic           减码
//   分类   /zh/categories → /zh/category/<名字>
//   频道   /zh/channels   → /zh/channel/<slug>
//   女优   /zh/actresses  → /zh/actress/<slug>
//   搜索   /zh/search?q=<词>
//
// 排序（?sort=）：added_today/added_week/added_month、
//                 popular_today/popular_week/popular_month、most_liked/most_viewed
// 分页：?page=N（23 条/页）
//
// 卡片：
//   <article class="video-card">
//     <a href="/zh/video/116220/slug" class="video-card__thumbnail">
//       <img src="占位.svg" data-front-lazy-src="/uploads/…/thumb.jpg">   ← 封面在 data 属性
//       <span class="video-card__type">Uncensored</span>
//       <span class="video-card__details"><strong>FHD</strong>01:47:35</span>
//     </a>
//     <a class="video-card__title" title="标题">标题</a>
//     <div class="video-card__meta">5.2K 次观看 · 刚刚</div>
//
// 播放（关键：HTML 里没有 src，票是单次有效的）：
//   详情页内联 JSON  "playback":{"endpoint":"/zh/video/<id>/playback","ticket":"p1.xxx"}
//   → POST endpoint（form: ticket=<票>，带 X-Requested-With）
//   → {"sources":[{"src":"/zh/media/video/<id>/720p?expires=&signature=","type":"video/mp4"}]}
//   → 带 Referer 拉 /zh/media/... （206 video/mp4）

import { Spider, openWeb } from "catvod";

const BASE = "https://javtiful.com";
const LANG = "/zh";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 23;

// 视频类型（视频 tab 的二级）
const VIDEO_TYPES = [
  { slug: "", name: "全部", path: "/videos" },
  { slug: "censored", name: "有码", path: "/censored" },
  { slug: "uncensored", name: "无码", path: "/uncensored" },
  { slug: "reducing-mosaic", name: "减码", path: "/reducing-mosaic" },
];

// 排序 9 项
const ORDERS = [
  { n: "最新", v: "" },
  { n: "今日新增", v: "added_today" },
  { n: "本周新增", v: "added_week" },
  { n: "本月新增", v: "added_month" },
  { n: "今日热门", v: "popular_today" },
  { n: "本周热门", v: "popular_week" },
  { n: "本月热门", v: "popular_month" },
  { n: "最多点赞", v: "most_liked" },
  { n: "最多观看", v: "most_viewed" },
];

// 分类 tab 的排序（站点分类页只给 4 项）
const CAT_ORDERS = [
  { n: "最新", v: "" },
  { n: "今日新增", v: "added_today" },
  { n: "本周新增", v: "added_week" },
  { n: "本月新增", v: "added_month" },
  { n: "热门", v: "popular_week" },
];

// VIDEO TYPE（分类页的 4 项）
const CAT_TYPES = [
  { n: "全部", v: "" },
  { n: "有码", v: "censored" },
  { n: "无码", v: "uncensored" },
  { n: "减码", v: "reducing-mosaic" },
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + LANG + "/main",
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

/** 列表卡片 */
function parseCards(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const re = /<article class="video-card"[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const b = m[0];
    const link = b.match(/href="(\/zh\/video\/\d+\/[^"]*)"/);
    if (!link) continue;
    const url = BASE + link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const pic = b.match(/data-front-lazy-src="([^"]+)"/);
    const title = b.match(/class="video-card__title"[^>]*title="([^"]*)"/)
      || b.match(/class="video-card__title"[^>]*>([^<]{1,200})</);

    // 角标：优先时长（details 里的 01:47:35）
    const dur = b.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*<\/span>/);
    const meta = b.match(/class="video-card__meta">([\s\S]{0,80}?)<\/div>/);
    let remarks = dur ? dur[1] : "";
    if (!remarks && meta) remarks = "";

    out.push({
      vod_id: url,
      vod_name: clean(title ? (title[1] || title[0]) : ""),
      vod_pic: pic ? BASE + decode(pic[1]).replace(BASE, "") : "",
      vod_remarks: remarks,
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

export default class Javtiful extends Spider {
  init() { }

  async homeContent() {
    const classes = [
      { type_id: "foryou", type_name: "推荐" },
      { type_id: "video", type_name: "视频" },
      { type_id: "category", type_name: "分类" },
      { type_id: "channelsearch", type_name: "频道" },
      { type_id: "actresssearch", type_name: "女优" },
      { type_id: "web", type_name: "网页" },
    ];

    const vMedia = VIDEO_TYPES.map((t) => ({ n: t.name, v: t.slug }));


    const filters = {
      video: [
        { key: "media", name: "类型", value: vMedia },
        { key: "order", name: "排序", value: ORDERS },
      ],
      // 多组筛选会渲染在 tab 行下方独立一行（bili241 起），不会再吃掉 tab 行
      category: [
        { key: "order", name: "排序", value: CAT_ORDERS },
        { key: "vtype", name: "类型", panel: true, value: CAT_TYPES },
      ],
      // 频道 / 女优 下钻页也有同一套筛选（排序 + VIDEO TYPE）
      channelsearch: [
        { key: "order", name: "排序", value: CAT_ORDERS },
        { key: "vtype", name: "类型", panel: true, value: CAT_TYPES },
      ],
      actresssearch: [
        { key: "order", name: "排序", value: CAT_ORDERS },
        { key: "vtype", name: "类型", panel: true, value: CAT_TYPES },
      ],
    };
    // 分类 chips 走二级机制（action("sub|category")），不依赖 homeContent 联网
    return { class: classes, filters: filters, subFromTab: true };
  }

  /** 通用列表页：path + ?sort + ?page */
  async listPage(path, p, sort, vtype) {
    const qs = [];
    if (sort) qs.push("sort=" + sort);
    if (vtype) qs.push("video_type=" + vtype);   // 站点参数名是 video_type（type= 无效）
    if (p > 1) qs.push("page=" + p);
    // 必须带 /zh 前缀：不带会 302 到语言首页，设备上跟随重定向不稳定 → 空列表
    const fixed = path.indexOf(LANG + "/") === 0 ? path : LANG + path;
    const url = BASE + fixed + (qs.length ? "?" + qs.join("&") : "");

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    let cards = parseCards(html);
    // 服务端偶发返回空壳（无 article），这里重试一次并加时间戳绕开缓存
    if (!cards.length) {
      try {
        const r2 = await this.net.req(url + (url.indexOf("?") >= 0 ? "&" : "?") + "_t=" + Date.now(), { headers: hdrs() });
        if (r2 && r2.code === 200) cards = parseCards(r2.content);
      } catch (e) { }
    }
    const total = cards.length >= 12 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "foryou");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + LANG + "/main" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 推荐：服务端每次随机（下拉刷新即换一批）
    if (t === "foryou") return this.listPage("/foryou", p, "");

    // 视频：二级 = 类型
    if (t === "video") {
      const type = String(ext.media || "");
      const hit = VIDEO_TYPES.find((x) => x.slug === type) || VIDEO_TYPES[0];
      return this.listPage(hit.path, p, String(ext.order || ""));
    }

    // 分类：二级 chips = 分类名；点卡片进某分类
    if (t === "category") {
      let cat = String(ext.media || "");
      const subVal = String(ext.sub || "");
      if (!cat && subVal.indexOf("cat:") === 0) cat = subVal.substring(4);
      // 没选具体分类（= 全部）时，类型筛选走站点自己的分区路径
      if (!cat) {
        const vt = String(ext.vtype || "");
        const hit = VIDEO_TYPES.find((x) => x.slug === vt) || VIDEO_TYPES[0];
        return this.listPage(hit.path, p, String(ext.order || ""));
      }
      const vtype = String(ext.vtype || "");
      const qs = [];
      if (ext.order) qs.push("sort=" + ext.order);
      if (vtype) qs.push("video_type=" + vtype);
      if (p > 1) qs.push("page=" + p);
      const url = BASE + LANG + "/category/" + cat + (qs.length ? "?" + qs.join("&") : "");
      return this.reqPage(url, p);
    }

    // 频道 / 女优：下钻时 tid 是 ch:<slug> / ac:<slug>
    // 这两个页面同样支持 排序 + VIDEO TYPE（站点自带筛选面板）
    const dOrder = String(ext.order || "");
    const dType = String(ext.vtype || ext.media || "");
    if (t.indexOf("ch:") === 0) return this.listPage("/channel/" + t.substring(3), p, dOrder, dType);
    if (t.indexOf("ac:") === 0) return this.listPage("/actress/" + t.substring(3), p, dOrder, dType);

    // 频道 / 女优：选中值在 extend.sub 里（ch:<slug> / ac:<slug>），
    // t 可能是 channel / channelsearch（面板模式）
    if (t === "channel" || t === "actress" || t === "channelsearch" || t === "actresssearch") {
      const isCh = t.indexOf("channel") === 0;
      const sv = String(ext.sub || "");
      if (isCh && sv.indexOf("ch:") === 0)
        return this.listPage("/channel/" + sv.substring(3), p, dOrder, dType);
      if (!isCh && sv.indexOf("ac:") === 0)
        return this.listPage("/actress/" + sv.substring(3), p, dOrder, dType);
      return this.page([{
        vod_id: "",
        vod_name: isCh ? "在上方选一个频道" : "在上方选一个女优",
        vod_pic: "",
        vod_remarks: "提示",
      }], 1, PAGE_SIZE, 1);
    }

    return this.listPage("/videos", p, "");
  }

  /** 分类索引（21 个），给 chips 用；缓存一次 */
  async loadCategories() {
    if (this.catCache) return this.catCache;
    const out = [];
    try {
      const r = await this.net.req(BASE + LANG + "/categories", { headers: hdrs() });
      if (r && r.code === 200) {
        const re = /href="\/zh\/category\/([^"]+)"[\s\S]{0,900}?<\/a>/g;
        let m;
        const seen = {};
        while ((m = re.exec(r.content)) !== null) {
          const slug = m[1];
          if (seen[slug]) continue;
          seen[slug] = 1;
          const nm = m[0].match(/category-card__name">([^<]{1,40})</);
          const capt = m[0].match(/category-card__caption">([\s\S]{0,120}?)<\/span>/);
          let name = nm ? clean(nm[1]) : "";
          if (!name && capt) name = clean(capt[1]);
          if (!name) {
            try { name = decodeURIComponent(slug); } catch (e) { name = slug; }
          }
          out.push({ slug: slug, name: name });
        }
      }
    } catch (e) { }
    if (out.length) this.catCache = out;   // 空结果不缓存，避免一次抖动永久为空
    return out;
  }

  /** 分类索引（21 个，做成二级 chips 的数据源） */
  async categoryList(p) {
    const out = [];
    try {
      const r = await this.net.req(BASE + LANG + "/categories", { headers: hdrs() });
      if (r && r.code === 200) {
        const re = /href="\/zh\/category\/([^"]+)"[\s\S]{0,900}?<\/a>/g;
        let m;
        const seen = {};
        while ((m = re.exec(r.content)) !== null) {
          const slug = m[1];
          if (seen[slug]) continue;
          seen[slug] = 1;
          const nm = m[0].match(/category-card__name">([^<]{1,40})</);
          const capt = m[0].match(/category-card__caption">([\s\S]{0,120}?)<\/span>/);
          let name = nm ? clean(nm[1]) : "";
          if (!name && capt) name = clean(capt[1]);
          if (!name) {
            try { name = decodeURIComponent(slug); } catch (e) { name = slug; }
          }
          out.push({ slug: slug, name: name });
        }
      }
    } catch (e) { }

    // 分类名取不到时用 slug 兜底；作为「文件夹」行
    return this.page(out.map((c) => ({
      vod_id: "cat:" + c.slug,
      vod_name: c.name,
      vod_pic: "",
      vod_remarks: "",
      vod_tag: "folder",
    })), p, 30, out.length);
  }

  /** 频道 / 女优 的分面搜索：facet|<kind>|<kw>|<page> */
  async facetIndex(op, kind) {
    const prefix = "facet|" + kind + "|";
    const rest = op.substring(prefix.length);
    const bar = rest.lastIndexOf("|");
    const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
    const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

    const all = await this.indexChips(kind);          // 复用已有索引（带缓存）
    const hit = kw ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0) : all;
    const PAGE = 100;
    const from = (page - 1) * PAGE;
    // 必须返回对象 {items:[...]}：App 的 facets() 用 JSONObject 解析，裸数组会被丢掉
    const items = hit.slice(from, from + PAGE).map((x) => ({ id: x.value, name: x.name, count: "", pic: x.pic || "" }));
    return { items: items };
  }

  /** 频道 / 女优索引进 chips（取前 3 页，约 72 个），缓存 */
  async indexChips(kind) {
    if (!this.idxChipCache) this.idxChipCache = {};
    if (this.idxChipCache[kind]) return this.idxChipCache[kind];

    const listPath = kind === "channel" ? "/channels" : "/actresses";
    const linkKind = kind === "channel" ? "channel" : "actress";
    const prefix = kind === "channel" ? "ch:" : "ac:";
    const out = [];
    const seen = {};

    for (let p = 1; p <= 3; p++) {
      try {
        const url = BASE + LANG + listPath + (p > 1 ? "?page=" + p : "");
        const r = await this.net.req(url, { headers: hdrs() });
        if (!r || r.code !== 200) break;
        const re = new RegExp('href="/zh/' + linkKind + '/([^"]+)"[\\s\\S]{0,600}?directory-card__name">([^<]{1,60})<', "g");
        let m, added = 0;
        while ((m = re.exec(r.content)) !== null) {
          const slug = m[1];
          if (seen[slug]) continue;
          seen[slug] = 1;
          // 头像是在同一张卡片里的 <img src=...>（collections/channels|actresses）
          const img = m[0].match(/<img[^>]*src="([^"]+)"/);
          const pic = img ? (img[1].indexOf("http") === 0 ? img[1] : BASE + img[1]) : "";
          out.push({ name: clean(m[2]) || slug, value: prefix + slug, pic: pic });
          added++;
        }
        if (!added) break;
      } catch (e) { break; }
    }
    if (out.length) this.idxChipCache[kind] = out;
    return out;
  }

  /** 频道 / 女优索引（文件夹行，可翻页） */
  async directoryList(kind, p) {
    const listPath = kind === "channel" ? "/channels" : "/actresses";
    const linkKind = kind === "channel" ? "channel" : "actress";
    const out = [];
    try {
      const url = BASE + LANG + listPath + (p > 1 ? "?page=" + p : "");
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) {
        const re = new RegExp('href="/zh/' + linkKind + '/([^"]+)"[\\s\\S]{0,600}?directory-card__name">([^<]{1,60})<', "g");
        let m;
        const seen = {};
        while ((m = re.exec(r.content)) !== null) {
          const slug = m[1];
          if (seen[slug]) continue;
          seen[slug] = 1;
          const cnt = m[0].match(/directory-card__count">([^<]{1,30})</);
          out.push({
            vod_id: (kind === "channel" ? "ch:" : "ac:") + slug,
            vod_name: clean(m[2]) || slug,
            vod_pic: "",
            vod_remarks: cnt ? clean(cnt[1]) : "",
            vod_tag: "folder",
          });
        }
      }
    } catch (e) { }
    const total = out.length >= 20 ? (p + 1) * 30 : (p - 1) * 30 + out.length;
    return this.page(out, p, 30, total);
  }

  /** 直接请求某个列表 URL */
  async reqPage(url, p) {
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

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }

    let title = "";
    const t = html.match(/property="og:title"[^>]*content="([^"]*)"/) ||
      html.match(/<title>([^<]*)<\/title>/);
    if (t) title = clean(t[1]).replace(/\s*\|\s*Javtiful\s*$/i, "").trim();

    const pic = html.match(/property="og:image"[^>]*content="([^"]*)"/) ||
      html.match(/<video[^>]*poster="([^"]+)"/);
    const poster = pic ? (pic[1].indexOf("http") === 0 ? decode(pic[1]) : BASE + decode(pic[1])) : "";

    // 时长
    let dur = "";
    const dm = html.match(/"duration":"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/);
    if (dm) {
      const h = Number(dm[1] || 0), mi = Number(dm[2] || 0), se = Number(dm[3] || 0);
      const total = h * 3600 + mi * 60 + se;
      dur = Math.floor(total / 3600) > 0
        ? Math.floor(total / 3600) + ":" + ("0" + Math.floor((total % 3600) / 60)).slice(-2) + ":" + ("0" + (total % 60)).slice(-2)
        : Math.floor(total / 60) + ":" + ("0" + (total % 60)).slice(-2);
    }

    // 女优 / 频道 / 分类 → chips
    const lines = [];
    const chips = [];
    const are = /href="\/zh\/actress\/([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/g;
    let am;
    const seenA = {};
    while ((am = are.exec(html)) !== null) {
      if (seenA[am[1]]) continue;
      const nm = clean(am[2]);
      if (!nm) continue;              // 只有图片没有文字就跳过，免得出现空 chip
      seenA[am[1]] = 1;
      chips.push('[a=cr:{"id":"ac:' + am[1] + '"}/]' + nm + "[/a]");
      if (chips.length >= 6) break;
    }
    if (chips.length) lines.push(chips.join(" · "));

    const chre = /href="\/zh\/channel\/([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/g;
    let cm;
    const chanChips = [];
    const seenC = {};
    while ((cm = chre.exec(html)) !== null) {
      if (seenC[cm[1]]) continue;
      const nm = clean(cm[2]);
      if (!nm) continue;
      seenC[cm[1]] = 1;
      chanChips.push('[a=cr:{"id":"ch:' + cm[1] + '"}/]' + nm + "[/a]");
      if (chanChips.length >= 4) break;
    }
    if (chanChips.length) lines.push(chanChips.join(" · "));

    if (dur) lines.push("时长：" + dur);

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: poster,
        vod_content: lines.join("\n"),
        vod_remarks: dur,
        gallery: false,
        vod_play_from: "Javtiful",
        vod_play_url: "正片$" + url,
      }],
    };
  }

  /** 两步换流：拿 ticket → POST playback → 播放地址 */
  async resolvePlay(url) {
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) throw new Error("详情页打不开");

    const m = html.match(/"playback":\{"endpoint":"([^"]+)","ticket":"([^"]+)"\}/);
    if (!m) throw new Error("没找到播放票");
    const endpoint = m[1];
    const ticket = m[2];

    let txt = "";
    try {
      const r = await this.net.req(BASE + endpoint, {
        method: "POST",
        postType: "form",
        data: { ticket: ticket },
        headers: Object.assign(hdrs(url), {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Origin": BASE,
        }),
      });
      if (r) txt = r.content || "";
    } catch (e) {
      txt = "";
    }

    if (!txt) throw new Error("播放接口无响应");
    let data = null;
    try { data = JSON.parse(txt); } catch (e) { data = null; }
    if (!data || !data.success || !Array.isArray(data.sources) || !data.sources.length) {
      throw new Error("播放接口未返回地址");
    }
    const src = data.sources[0].src || "";
    return src.indexOf("http") === 0 ? src : BASE + src;
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    const play = await this.resolvePlay(url);
    return {
      parse: 0,          // 是 mp4 直链（/zh/media/video/<id>/720p?...）
      url: play,
      header: { "User-Agent": UA, "Referer": BASE + LANG + "/main" },
    };
  }

  async action(op) {
    if (!op) return [];
    if (op.indexOf("gal|") === 0) return { list: [] };

    // 分类 tab 的二级 chips：21 个分类（异步加载，不占 homeContent 时间）
    if (op === "sub|category") {
      const cats = await this.loadCategories();
      // 不要返回空值项：App 会自动在 chips 行首加「全部」
      return cats.map((c) => ({ name: c.name, value: "cat:" + c.slug }));
    }
    // 频道 / 女优：页内搜索面板（几百个条目，chips 横滑太累）
    if (op.indexOf("facet|channel|") === 0) return await this.facetIndex(op, "channel");
    if (op.indexOf("facet|actress|") === 0) return await this.facetIndex(op, "actress");

    if (op.indexOf("sub|") === 0) return [];

    return [];
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + LANG + "/search?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    return this.reqPage(url, p);
  }
}
