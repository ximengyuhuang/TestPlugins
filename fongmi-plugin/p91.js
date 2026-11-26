// 91porn —— BiliTV / catvod QuickJS 插件
//
// 站点结构（2026-11-24 侦查）
//   最新   /v.php?next=watch                       24/页，&page=N
//   分类   /v.php?category=<code>&page=N           ori/hot/top/long/longer/tf/rf/hd/md/mf
//   搜索   /search_result.php?search_id=<kw>&page=N
//   详情   /view_video.php?viewkey=<key>&c=<c>&viewtype=basic&category=<code>
//   播放   详情页里是编码过的源：strencode2("%3c%73%6f%75%72%63%65…")
//          URL 解码一次 → <source src='https://…/mp43/1262056.mp4?st=…&e=…'>
//          直链带过期时间 e=，必须点播时现取；裸拉 206 video/mp4，不需要 Referer
//   相关   详情页自带 4 条（同样的卡片结构）
//
// 卡片：
//   <div class="well well-sm videos-text-align">
//     <a href="https://91porn.com/view_video.php?viewkey=XXX&c=…">
//       <img class="img-responsive" src="https://xxx.rsc.cdn77.org/thumb/1261811.jpg">
//       <div class="hd-text-icon">HD</div>
//       <div class="original-text-icon">91</div>
//       <span class="duration">00:05:38</span>
//     </a>
//     <span class="video-title title-truncate m-t-5">标题</span>
//   </div>

import { Spider, openWeb } from "catvod";

const BASE = "https://91porn.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

// 11 个 chips：最新 + 站点 10 个分类（分类本质是排序维度）
const CATS = [
  { n: "最新", v: "" },
  { n: "91原创", v: "ori" },
  { n: "当前最热", v: "hot" },
  { n: "本月最热", v: "top" },
  { n: "本月收藏", v: "tf" },
  { n: "最近加精", v: "rf" },
  { n: "本月讨论", v: "md" },
  { n: "收藏最多", v: "mf" },
  { n: "高清", v: "hd" },
  { n: "10分钟以上", v: "long" },
  { n: "20分钟以上", v: "longer" },
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/v.php?next=watch",
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
function listUrl(catCode, p) {
  if (!catCode) return BASE + "/v.php?next=watch" + (p > 1 ? "&page=" + p : "");
  return BASE + "/v.php?category=" + catCode + (p > 1 ? "&page=" + p : "");
}

/** 有没有下一页：优先看分页链接，其次看是否满页 */
function hasNext(html, p) {
  const t = String(html || "");
  return t.indexOf("page=" + (p + 1)) >= 0 || t.indexOf("page-" + (p + 1)) >= 0;
}

/**
 * 从一段 HTML 里解析卡片。站点有两套标记，都要认：
 *   A) 列表页/搜索页： <article class="vitem well-sm well">
 *        <a href="…viewkey=…"><div class="thumb-overlay"><img class="img-responsive" src="…">
 *        <span class="duration">00:06:07</span></div>
 *        <div class="tXXXX"><bdi>标题</bdi></div></a></article>
 *   B) 首页排行：     <div class="well well-sm videos-text-align"> … <span class="video-title">标题</span>
 * 里面那个 tXXXX 是随机 hash，不能写死 —— 统一用 <bdi> / video-title 兜底。
 */
function parseCards(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const re = /view_video[a-z_]*\.php\?[^"\s]{0,80}?viewkey=([A-Za-z0-9]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const from = Math.max(0, m.index - 400);
    const b = text.substring(from, m.index + 1600);

    const link = b.match(/href="((?:https?:\/\/91porn\.com\/)?view_video[a-z_]*\.php\?[^"]*viewkey=[A-Za-z0-9]+[^"]*)"/);
    if (!link) continue;
    const rawUrl = decode(link[1]);
    const url = rawUrl.indexOf("http") === 0 ? rawUrl : BASE + "/" + rawUrl.replace(/^\/+/, "");

    // 同一个卡片会被扫到多次（link / thumb id / js），用「viewkey + 标题」去重
    const img = b.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"/) ||
      b.match(/<img[^>]*src="([^"]+\.(?:jpg|jpeg|png|webp))"/);
    const title =
      (b.match(/<bdi>([\s\S]{0,200}?)<\/bdi>/) ||
        b.match(/class="video-title[^"]*"[^>]*>([\s\S]{0,200}?)<\/span>/) ||
        b.match(/<h6[^>]*>([\s\S]{0,200}?)<\/h6>/));
    const dur = b.match(/class="duration"[^>]*>\s*([0-9:]{4,10})\s*</);
    const hd = /hd-text-icon|>\s*HD\s*</.test(b);

    const name = strip(title ? title[1] : "");
    const key = m[1];                 // 只按 viewkey 去重：页面里同一卡片会出现多次
    if (seen[key]) continue;
    seen[key] = 1;
    if (!name && !img) continue;

    // 角标：「HD|时长」→ App 拆成左上 HD + 右下时长
    const durText = dur ? dur[1] : "";
    const remarks = hd && durText ? "HD|" + durText : (durText || (hd ? "HD" : ""));

    out.push({
      vod_id: url,
      vod_name: name || url,
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: remarks,
    });
  }
  return out;
}

/** 从详情页里解出播放直链 */
function parsePlayUrl(html) {
  const m = String(html || "").match(/strencode2\("([^"]+)"\)/);
  if (!m) return "";
  let dec = m[1];
  try { dec = decodeURIComponent(dec); } catch (e) { }
  const src = dec.match(/src='([^']+)'/) || dec.match(/src="([^"]+)"/);
  return src ? decode(src[1]) : "";
}

// @bili-helpers BEGIN v2026-11-26（由 tools/inject.mjs 注入，可安全整块替换）
function titlePV(title) {
  const t = String(title || "");
  const both = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]\s*([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const toHalf = (x) => Number(String(x).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))) || 0;
  if (both) return { p: toHalf(both[1]), v: toHalf(both[2]) };
  const onlyV = t.match(/([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const onlyP = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]/);
  return { p: onlyP ? toHalf(onlyP[1]) : 0, v: onlyV ? toHalf(onlyV[1]) : 0 };
}

/** 标题里的时长（12:34 / 01:47:35），取不到给空串 */

function titleDuration(title) {
  const m = String(title || "").match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return m ? m[1] : "";
}

/**
 * 角标：站点结构化字段 > 标题里的 P/V/时长 > 留空。
 * 用法：vod_remarks: badgeOf(title, { photos: 12, videos: 1, duration: "12:34" })
 * 返回形态只有三种合法：NP、NP·MV、时长；无效值（0P/1P 占位）自动忽略。
 */

function badgeOf(title, info) {
  const i = info || {};
  const pv = titlePV(title);
  let p = Number(i.photos) > 0 ? Number(i.photos) : pv.p;
  let v = Number(i.videos) > 0 ? Number(i.videos) : pv.v;
  if (p === 1 && v > 0) p = 0;              // 「1P·1V」里的 1P 多半是封面占位
  if (p > 0 && v > 0) return p + "P·" + v + "V";
  if (v > 0) return v + "V";
  if (p > 0) return p + "P";
  const dur = i.duration || titleDuration(title);
  return dur || "";
}

// @bili-helpers END

export default class P91 extends Spider {
  init() { }

  async homeContent() {
    const classes = [
      { type_id: "video", type_name: "视频" },
      { type_id: "web", type_name: "网页" },
    ];
    const filters = {
      video: [
        { key: "media", name: "分类", value: CATS },
      ],
    };
    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "video");
    if (t === "web") {
      try { openWeb({ url: BASE + "/index.php" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }
    const ext = extend || {};
    const cat = String(ext.media || "");
    return this.listFromUrl(listUrl(cat, p), p);
  }

  async listFromUrl(url, p) {
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    const total = hasNext(html, p)
      ? (p + 1) * PAGE_SIZE
      : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = String(ids[0] || "");
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return { list: [] };

    let title = "";
    const t = html.match(/class="video-title[^"]*"[^>]*>([\s\S]{0,200}?)<\/h1>/) ||
      html.match(/class="video-title[^"]*"[^>]*>([\s\S]{0,200}?)<\/span>/) ||
      html.match(/<title>([^<]*)<\/title>/);
    if (t) title = strip(t[1]).replace(/\s*-\s*91porn\s*$/, "").trim();

    const cover = html.match(/poster="([^"]+)"/) || html.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"/);

    // 文本区：时长 / 热度 / 留言 / 作者
    const lines = [];
    const dur = html.match(/时长:[\s\S]{0,80}?video-info-span">([^<]+)</);
    const hot = html.match(/热度:[\s\S]{0,80}?video-info-span">([^<]+)</);
    const cmt = html.match(/留言:[\s\S]{0,80}?video-info-span">([^<]+)</);
    const author = html.match(/<a[^>]*href="[^"]*?[?&]user=([^"&]+)[^"]*"[^>]*>([^<]{1,30})</);
    if (author) lines.push("作者：" + strip(author[2]));
    const meta = [];
    if (dur) meta.push("时长 " + strip(dur[1]));
    if (hot) meta.push("热度 " + strip(hot[1]));
    if (cmt) meta.push("留言 " + strip(cmt[1]));
    if (meta.length) lines.push(meta.join(" · "));

    // 相关推荐：站点详情页自带（同样的卡片结构），排除自己
    const rel = parseCards(html)
      .filter((x) => x.vod_id !== url)
      .slice(0, 8);

    const durText = dur ? strip(dur[1]) : "";
    const hd = /hd-text-icon/.test(html);
    const remarks = hd && durText ? "HD|" + durText : durText;

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: cover ? decode(cover[1]) : "",
        vod_content: lines.join("\n"),
        vod_remarks: remarks,
        gallery: false,
        vod_play_from: "91porn",
        vod_play_url: "正片$" + url,
      }].concat(rel),
    };
  }

  /** 播放：解码 strencode2 拿 mp4 直链（带过期时间，必须现取） */
  async playerContent(flag, id) {
    const url = String(id);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) throw new Error("详情页打不开");

    const play = parsePlayUrl(html);
    if (!play) throw new Error("没找到播放地址");

    return {
      parse: 0,
      url: play,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async action(op) {
    if (!op) return [];
    if (op.indexOf("gal|") === 0) return { list: [] };
    return [];
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/search_result.php?search_id=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    return this.listFromUrl(url, p);
  }
}
