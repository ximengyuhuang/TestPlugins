// EPORNER（www.eporner.com）—— BiliTV / catvod QuickJS 插件
//
// 侦查结论（2026-11-24）
//   首页/列表   /  、/2/ 或 ?p=N        每页 ~36 张卡片
//   分类       /cat/<slug>/            /cat/all/ 里共 85 个
//   排序       ?sort=newest|longest|top-rated   默认 = best
//              分页要写 /cat/x/?sort=newest&p=2（/2/?sort= 无效）
//   搜索       /search/?q=<kw>&p=N
//   模特       /pornstar-list/<N>/     每页 76 个，/pornstar/<slug>/ 是单人页
//   详情       /video-<id>/<slug>/     播放器 data-vid="<id>/<id>.mp4"
//              → https://gvideo.eporner.com/<data-vid>
//   卡片       <div class="mb" data-id="…"><img …><div class="mvhdico"><span>1080p</span>
//              <p class="mbtit"><a href="/video-…/">标题</a></p>
//              <p class="mbstats"><span class="mbtim">16:04</span><span class="mbrate">93%</span>…
//   相关       详情页里另外还有 ~19 个 class="mb" 卡片
//   ⚠ 详情页没有「本片演员」链接（只有站点推荐位），所以详情页不做演员 chips

import { Spider, openWeb } from "catvod";

const BASE = "https://www.eporner.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 36;

// 站点自己的 Sort by（路径段 SORT-xxx）
const SORTS = [
  { n: "最近", v: "" },
  { n: "周榜", v: "top-weekly" },
  { n: "月榜", v: "top-monthly" },
  { n: "最多播放", v: "most-viewed" },
  { n: "最高评分", v: "top-rated" },
  { n: "最长", v: "longest" },
];

// PRODUCTION（路径段 PROD-xxx）
const PRODS = [
  { n: "全部", v: "" },
  { n: "专业", v: "pro" },
  { n: "自拍", v: "home" },
];

// QUALITY（query: quality=720|1080|2160）
const QUALS = [
  { n: "全部", v: "" },
  { n: "720p+", v: "720" },
  { n: "1080p+", v: "1080" },
  { n: "4K", v: "2160" },
];

// Duration（query: duration_min_minutes / duration_max_minutes，站点滑杆 0~61，61 表示 1h+）
const DURS = [
  { n: "全部", v: "" },
  { n: "5 分内", v: "0-5" },
  { n: "5~15 分", v: "5-15" },
  { n: "15~30 分", v: "15-30" },
  { n: "30~60 分", v: "30-60" },
  { n: "1 小时以上", v: "60-61" },
];

/**
 * 列表 URL —— 对齐站点：
 *   排序 / 制作 = 路径段：/cat/<cat>/SORT-top-rated/PROD-home/
 *   画质 / 时长 = 查询串：?quality=1080&duration_min_minutes=15&duration_max_minutes=30
 *   分页        = ?p=N（必须带 query，用 /N/ 会把 SORT 丢掉）
 */
function listUrl(cat, p, ext) {
  // 注意：站点的「全部」要用 /cat/all/，根路径 / 会忽略 quality / duration 参数
  let path = cat ? "/cat/" + cat + "/" : "/cat/all/";
  const segs = [];
  if (ext && ext.sort) segs.push("SORT-" + ext.sort);
  if (ext && ext.prod) segs.push("PROD-" + ext.prod);
  if (segs.length) path += segs.join("/") + "/";
  // 分页必须写进路径（/cat/x/2/）：?p=N 在 /cat/all/ 上无效，且会丢掉 SORT/PROD
  if (p > 1) path += p + "/";

  const qs = [];
  if (ext && ext.quality) qs.push("quality=" + ext.quality);
  if (ext && ext.dur) {
    const parts = String(ext.dur).split("-");
    if (parts[0]) qs.push("duration_min_minutes=" + parts[0]);
    if (parts[1]) qs.push("duration_max_minutes=" + parts[1]);
  }
  return BASE + path + (qs.length ? "?" + qs.join("&") : "");
}

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
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

/** 名字首字母（A-Z；非字母归到 #） */
function headLetter(name) {
  const s = String(name || "").trim();
  if (!s) return "#";
  const c = s.charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

/** 解析列表卡片 */
function parseCards(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const marks = [];
  const re = /<div class="mb[\s"]/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  for (let i = 0; i < marks.length; i++) {
    const seg = text.substring(marks[i], i + 1 < marks.length ? marks[i + 1] : marks[i] + 4000);
    const link = seg.match(/<p class="mbtit"><a href="(\/video-[^"]+)">([\s\S]{0,200}?)<\/a>/);
    if (!link) continue;
    const url = BASE + decode(link[1]);
    if (seen[url]) continue;
    seen[url] = 1;

    const pic = seg.match(/<img[^>]*\ssrc="(https?:\/\/[^"]+)"[^>]*alt="([^"]*)"/) ||
      seg.match(/<img[^>]*\ssrc="(https?:\/\/[^"]+)"/);
    const hd = seg.match(/class="mvhdico"[^>]*>\s*<span>([^<]+)<\/span>/);
    const dur = seg.match(/class="mbtim"[^>]*>([^<]{1,12})</);

    out.push({
      vod_id: url,
      vod_name: strip(link[2]) || url,
      vod_pic: pic ? decode(pic[1]) : "",
      // 角标：画质|时长（画质来自 mvhdico，时长来自 mbtim）
      vod_remarks: (hd ? strip(hd[1]) + "|" : "") + (dur ? strip(dur[1]) : ""),
    });
  }
  return out;
}

/**
 * 详情页画质列表。
 * ⚠ gvideo.eporner.com/<id>/<id>.mp4 对第三方请求一律 403，
 *    真正能用的是 /dload/<vid>/<height>/<id>-<height>p.mp4 → 302 到签名 CDN。
 */
function parseQualities(html) {
  const t = String(html || "");
  const out = [];
  const seen = {};
  const re = /href="(\/dload\/[^"]+?\/(\d+)\/[^"]+?-(\d+)p\.mp4)"/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const path = m[1];
    const h = Number(m[3]) || 0;
    // av1 / hevc 变体剔除：兼容性差，优先 h264
    if (!h || /-av1|-hevc/i.test(path) || seen[h]) continue;
    seen[h] = 1;
    out.push({ h: h, url: BASE + decode(path) });
  }
  out.sort((a, b) => a.h - b.h);
  return out;
}

/** 兜底：播放器 data-vid（多数情况下 403，只在拿不到 /dload/ 时用） */
function parsePlay(html) {
  const t = String(html || "");
  let m = t.match(/data-vid="([^"]+\.mp4)"/);
  if (m) return "https://gvideo.eporner.com/" + decode(m[1]);
  m = t.match(/"contentUrl"\s*:\s*"([^"]+\.mp4)"/);
  return m ? decode(m[1]) : "";
}

export default class Eporner extends Spider {
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
        { type_id: "categorysearch", type_name: "分类" },
        { type_id: "pornstarssearch", type_name: "模特" },
        { type_id: "web", type_name: "网页" },
      ],
      filters: {
        // 分类不放在这里：站点有 85 个分类，走 facet 面板（可搜、可按 A-Z）；
        // 这里只留站点那个 Sort & Filters 面板的四维
        latest: [
          { key: "sort", name: "排序", value: SORTS },
          // panel:true → 不占界面，和排序一起收进「⇅」面板（等于站点那个 Sort & Filters）
          { key: "prod", name: "制作", value: PRODS, panel: true },
          { key: "quality", name: "画质", value: QUALS, panel: true },
          { key: "dur", name: "时长", value: DURS, panel: true },
        ],
      },
    };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    let t = String(tid || "latest");
    const ext = extend || {};

    // 详情页 chips 点进来：tid 就是 id
    if (t.indexOf("tag:") === 0) {
      ext.sub = t;
      t = "tagsearch";
    } else if (t.indexOf("cat:") === 0) {
      ext.sub = t;
      t = "categorysearch";
    } else if (t.indexOf("star:") === 0) {
      ext.sub = t;
      t = "pornstarssearch";
    }

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const sub = String(ext.sub || "");

    // 分类面板
    if (t === "categorysearch") {
      if (sub.indexOf("cat:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个分类（可搜索）", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      const url = listUrl(sub.substring(4), p, ext);
      return this.fromHtml(await this.getHtml(url), p);
    }

    // 模特面板：选中模特 → 单人页
    if (t === "pornstarssearch" || t === "tagsearch") {
      if (sub.indexOf("star:") !== 0) {
        return this.page([{ vod_id: "", vod_name: "在上方选一个模特（可搜索）", vod_pic: "", vod_remarks: "提示" }], 1, PAGE_SIZE, 1);
      }
      const slug = sub.substring(5);
      const url = BASE + "/pornstar/" + slug + "/" + (p > 1 ? "?p=" + p : "");
      return this.fromHtml(await this.getHtml(url), p);
    }

    // 最新 / 分类 chips
    const media = String(ext.media || "");
    const url = listUrl(media, p, ext);
    return this.fromHtml(await this.getHtml(url), p);
  }

  fromHtml(html, p) {
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));
    const cards = parseCards(html);
    const n = p + 1;
    const more = html.indexOf("p=" + n) >= 0 || html.indexOf("/" + n + "/") >= 0;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = String(ids[0] || "");
    const html = await this.getHtml(url);
    if (!html) return { list: [] };

    let title = "";
    const og = html.match(/property="og:title"\s+content="([^"]+)"/);
    if (og) title = strip(og[1]).replace(/\s*-\s*EPORNER\s*$/i, "").trim();
    if (!title) {
      const t = html.match(/<title>([^<]*)<\/title>/);
      if (t) title = strip(t[1]).replace(/\s*-\s*EPORNER.*$/i, "").trim();
    }
    const poster = html.match(/property="og:image"\s*content="([^"]+)"/);

    // 分类 + 标签：只从 #video-info-tags 里取（页面别处全是导航菜单）
    let info = "";
    const ii = html.indexOf("video-info-tags");
    if (ii > 0) info = html.substring(ii, ii + 12000);

    const cats = [];
    const seenCat = {};
    const reCat = /class="vit-category"><a href="\/cat\/([a-z0-9\-]+)\/"[^>]*>([^<]{1,30})</g;
    let cm;
    while ((cm = reCat.exec(info)) !== null) {
      if (seenCat[cm[1]]) continue;
      seenCat[cm[1]] = 1;
      const nm = strip(cm[2]);
      if (nm) cats.push({ slug: cm[1], name: nm });
      if (cats.length >= 8) break;
    }
    const tags = [];
    const seenTag = {};
    const reTag = /class="vit-tag"><a href="\/tag\/([^"\/]+)\/"[^>]*>([^<]{1,30})</g;
    let tm;
    while ((tm = reTag.exec(info)) !== null) {
      if (seenTag[tm[1]]) continue;
      seenTag[tm[1]] = 1;
      const nm = strip(tm[2]);
      if (nm) tags.push({ slug: tm[1], name: nm });
      if (tags.length >= 12) break;
    }
    const upl = info.match(/class="vit-uploader"><a[^>]*>([^<]{1,30})</);

    const lines = [];
    if (upl) lines.push("上传者：" + strip(upl[1]));
    if (cats.length) {
      lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.slug + '"}/]' + x.name + "[/a]").join(" · "));
    }
    if (tags.length) {
      lines.push(tags.map((x) => '[a=cr:{"id":"tag:' + x.slug + '"}/]#' + x.name + "[/a]").join(" "));
    }

    const quals = parseQualities(html);
    const play = quals.length ? quals[quals.length - 1].url : parsePlay(html);
    const playUrl = quals.length
      ? quals.map((q) => q.h + "p$" + q.url).join("#")
      : (play ? "正片$" + play : "网页查看$web://" + url);
    const item = {
      vod_id: url,
      vod_name: title || url,
      vod_pic: poster ? decode(poster[1]) : "",
      vod_content: lines.join("\n"),
      vod_remarks: (cats.length ? cats[0].name + "|" : "")
        + (() => {
          const len = html.match(/class="vid-length">([^<]{1,10})</);
          return len ? strip(len[1]) : "";
        })(),
      gallery: false,
      vod_play_from: "EPORNER",
      vod_play_url: playUrl,
    };

    // 相关推荐：详情页里的其它 mb 卡片
    const rel = [];
    const seen = {};
    seen[url] = 1;
    for (const c of parseCards(html)) {
      if (rel.length >= 8) break;
      if (seen[c.vod_id]) continue;
      seen[c.vod_id] = 1;
      rel.push({
        vod_id: c.vod_id,
        vod_name: c.vod_name,
        vod_pic: c.vod_pic,
        vod_remarks: (c.vod_remarks || "").split("|").pop(),
      });
    }

    return { list: [item].concat(rel) };
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];
    if (s.indexOf("gal|") === 0) return { list: [] };

    // 侧边栏
    if (s === "side|") {
      const groups = [];
      try {
        const cats = await this.loadCats();
        const hot = cats.slice(0, 24);
        if (hot.length) {
          groups.push({
            name: "热门分类",
            facet: "categorysearch",
            items: hot.map((c) => ({ name: c.name, count: "", id: "cat:" + c.slug })),
          });
        }
      } catch (e) { }
      try {
        const stars = await this.loadStars(1);
        const top = stars.slice(0, 24);
        if (top.length) {
          groups.push({
            name: "热门模特",
            facet: "pornstarssearch",
            items: top.map((x) => ({ name: x.name, count: x.count || "", id: "star:" + x.slug })),
          });
        }
      } catch (e) { }
      return { groups: groups };
    }

    // 分类面板
    if (s.indexOf("facet|category|") === 0 || s.indexOf("facet|categories|") === 0) {
      const prefix = s.indexOf("facet|categories|") === 0 ? "facet|categories|" : "facet|category|";
      const rest = s.substring(prefix.length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

      const all = await this.loadCats();
      const letter = kw.indexOf("^") === 0 ? kw.substring(1).toUpperCase() : "";
      const hit = letter
        ? all.filter((x) => headLetter(x.name) === letter)
        : (kw ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0 || x.slug.indexOf(kw) >= 0) : all);
      const PAGE = 100;
      const from = (page - 1) * PAGE;
      return {
        items: hit.slice(from, from + PAGE).map((x) => ({
          id: "cat:" + x.slug, name: x.name, count: "",
        })),
      };
    }

    // 模特面板（分页从站点的 pornstar-list 拉）
    if (s.indexOf("facet|pornstar") === 0) {
      const rest = s.substring(s.indexOf("|", 6) + 1);   // 跳过 "facet|<kind>|"
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const page = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

      // 无关键词 → 直接取站点的第 page 页；有关键词/字母 → 扫前若干页过滤
      if (!kw) {
        const stars = await this.loadStars(page);
        return {
          items: stars.slice(0, 100).map((x) => ({
            id: "star:" + x.slug, name: x.name, count: x.count || "",
          })),
        };
      }
      const letter = kw.indexOf("^") === 0 ? kw.substring(1).toUpperCase() : "";
      const hit = [];
      for (let pg = 1; pg <= 4; pg++) {
        const stars = await this.loadStars(pg);
        if (!stars.length) break;
        for (const x of stars) {
          if (letter ? headLetter(x.name) === letter : x.name.toLowerCase().indexOf(kw) >= 0) hit.push(x);
        }
        if (hit.length >= 100) break;
      }
      return {
        items: hit.slice(0, 100).map((x) => ({ id: "star:" + x.slug, name: x.name, count: x.count || "" })),
      };
    }

    return [];
  }

  /** 分类清单（/cat/all/，85 个） */
  async loadCats() {
    if (this.cats && this.cats.length) return this.cats;
    const html = await this.getHtml(BASE + "/cat/all/");
    const out = [];
    const seen = {};
    const re = /href="\/cat\/([a-z0-9\-]+)\/"[^>]*>([^<]{1,30})</g;
    let m;
    while ((m = re.exec(html || "")) !== null) {
      const slug = m[1];
      if (slug === "all" || seen[slug]) continue;
      seen[slug] = 1;
      const nm = strip(m[2]);
      if (nm) out.push({ slug: slug, name: nm });
    }
    if (out.length) this.cats = out;
    return out;
  }

  /** 模特清单（/pornstar-list/<page>/，每页 ~76） */
  async loadStars(page) {
    this.starPages = this.starPages || {};
    const pg = Math.max(1, Number(page) || 1);
    if (this.starPages[pg]) return this.starPages[pg];
    const url = BASE + "/pornstar-list/" + (pg > 1 ? pg + "/" : "");
    const html = await this.getHtml(url);
    const out = [];
    const seen = {};
    // 站点结构：<div class="mbprofile"><a href="/pornstar/<slug>/" title="名字"><p class="mbtit">名字</p>
    //          计数在同一块的 <div class="mbtim"><span>Videos: </span>691</div>
    const re = /class="mbprofile"><a href="\/pornstar\/([^"\/]+)\/" title="([^"]{1,48})"([\s\S]{0,600}?)(?=<div class="mbprofile"|$)/g;
    let m;
    while ((m = re.exec(html || "")) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      const nm = strip(m[2]);
      const vids = m[3].match(/Videos:\s*<\/span>\s*([\d,]+)/);
      const cnt = vids ? vids[1].replace(/,/g, "") : "";
      if (nm) out.push({ slug: slug, name: nm, count: cnt });
    }
    if (out.length) this.starPages[pg] = out;
    return out;
  }

  async playerContent(flag, id) {
    const raw = String(id);
    const header = { "User-Agent": UA, "Referer": BASE + "/" };

    // /dload/ 会 302 到签名 CDN：自己解一次，避免播放器不跟跳转
    if (raw.indexOf("/dload/") > 0) {
      try {
        const r = await this.net.req(raw, { headers: hdrs(raw), redirect: 0 });
        const h = (r && r.headers) || {};
        for (const k of Object.keys(h)) {
          if (String(k).toLowerCase() === "location") {
            // 签名地址里的 ?dload=… 带空格和方括号，不编码播放器会报 bad range
            const loc = String(h[k] || "")
              .replace(/ /g, "%20").replace(/\[/g, "%5B").replace(/\]/g, "%5D");
            if (loc) return { parse: 0, url: loc, header: header };
          }
        }
      } catch (e) { }
      return { parse: 0, url: raw, header: header };   // 解不出就让播放器自己跟
    }

    if (/\.(?:mp4|m3u8)(?:$|\?)/i.test(raw)) return { parse: 0, url: raw, header: header };

    const html = await this.getHtml(raw);
    const play = html ? parsePlay(html) : "";
    if (!play) throw new Error("没找到播放地址");
    return { parse: 0, url: play, header: header };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const kw = encodeURIComponent(key);
    const url = BASE + "/search/?q=" + kw + (p > 1 ? "&p=" + p : "");
    return this.fromHtml(await this.getHtml(url), p);
  }
}
