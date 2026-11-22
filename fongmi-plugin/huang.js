// 黄视频（huang.video）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯视频（国产 AV / 短剧 / PMV / ASMR），无图集
//   全部   /videos?sort=<排序>&creator_id=<博主>&page=N
//   分类   /c/<slug>?sort=<排序>&creator_id=<博主>&page=N     slug: tangxin|influencers|tanhua|pmv|asmr
//   短剧   /c/shorts?page=N        卡片是系列 → /series/<id> → 剧集列表
//   详情   /videos/<id>             JSON-LD 里直接给 m3u8
//   搜索   /search?q=<词>
//
// 站点自带两行筛选（照抄）：
//   分类 chips：全部分类 / 糖心Vlog / 网红福利姬 / 探花大神 / PMV / ASMR
//   博主 chips：当前分类下的博主，带 creator_id（全部分类 97 个 / 糖心 45 / PMV 7 / ASMR 1）
//
// 排序：latest 最新 / popular 最热门 / popular_24h 24h最热 / popular_7d 7天最热

import { Spider, openWeb } from "catvod";

const BASE = "https://huang.video";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

const SORTS = [
  { n: "最新", v: "latest" },
  { n: "最热门", v: "popular" },
  { n: "24h 最热", v: "popular_24h" },
  { n: "7天最热", v: "popular_7d" },
];

// 短剧没有博主筛选（站点本身也没有）
const NO_CREATOR = { shorts: 1 };

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

/** 解析列表卡片：<article id="video_123"> / <article id="series_456"> */
function parseCards(html) {
  const text = String(html || "");
  const marks = [];
  const re = /<article id="(?:video|series)_\d+"/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : text.length;
    const b = text.substring(from, to);

    const idm = b.match(/<article id="(video|series)_(\d+)"/);
    if (!idm) continue;
    const kind = idm[1];
    const num = idm[2];
    // 注意：video → /videos/<id>，series → /series/<id>（不能统一加 s）
    const url = BASE + (kind === "series" ? "/series/" : "/videos/") + num;
    if (seen[url]) continue;
    seen[url] = 1;

    const img = b.match(/<img[^>]*src="([^"]+)"/);
    const title = b.match(/class="card-title[^"]*"[^>]*>\s*<a[^>]*>([\s\S]{0,200}?)<\/a>/) ||
      b.match(/aria-label="([^"]{1,120})"/);
    const dur = b.match(/<span class="badge[^"]*"[^>]*>\s*([\d:]{3,10})\s*<\/span>/);
    const who = b.match(/href="\/creators\/[^"]+"[^>]*>\s*([^<]{1,30})/);

    out.push({
      vod_id: url,
      vod_name: clean(title ? title[1] : "") || url,
      vod_pic: img ? decode(img[1]) : "",
      // 视频角标 = 时长；系列无角标
      vod_remarks: dur ? dur[1] : "",
      _creator: who ? clean(who[1]) : "",
    });
  }
  return out;
}

/** 站点自带的两行筛选：分类 chips + 博主 chips */
function parseCreators(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const re = /<a[^>]*href="([^"]*creator_id=(\d+))"[^>]*?(?:title="([^"]{1,30})")?[^>]*>\s*(?:<span[^>]*>\s*)?([^<]{0,30})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const cid = m[2];
    let name = clean(m[3] || "") || clean(m[4] || "");
    if (!cid || !name || seen[cid]) continue;
    seen[cid] = 1;
    out.push({ name: name, value: cid, count: "" });
  }
  return out;
}

/** 详情页 JSON-LD */
function parseJsonLd(html) {
  const text = String(html || "");
  const re = /<script type="application\/ld\+json">([\s\S]{0,4000}?)<\/script>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && (obj["@type"] === "VideoObject" || obj.contentUrl)) return obj;
    } catch (e) { }
  }
  return null;
}

/** 系列页的剧集 */
function parseEpisodes(html) {
  const text = String(html || "");
  const out = [];
  const seen = {};
  const re = /<a[^>]*href="(\/videos\/(\d+))"[^>]*>([\s\S]{0,220}?)<\/a>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[2];
    if (seen[id]) continue;
    seen[id] = 1;
    const inner = m[3];
    const label = inner.match(/<span class="font-semibold[^"]*"[^>]*>\s*([^<]{1,20})/) ||
      inner.match(/>\s*(第[\s\S]{0,8}?集)\s*</);
    const dur = inner.match(/<span class="text-sm[^"]*"[^>]*>\s*([\d:]{3,10})\s*</);
    const name = clean(label ? label[1] : "") || ("第" + (out.length + 1) + "集");
    out.push({ id: id, name: dur ? name + " " + dur[1] : name });
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

export default class HuangVideo extends Spider {
  init() { }

  async homeContent() {
    // 一级 tab：全部 / 短剧 / 5 个分类 / 网页
    const classes = [
      { type_id: "videos", type_name: "全部" },
      { type_id: "shorts", type_name: "短剧" },
      { type_id: "tangxin", type_name: "糖心" },
      { type_id: "influencers", type_name: "网红" },
      { type_id: "tanhua", type_name: "探花" },
      { type_id: "pmv", type_name: "PMV" },
      { type_id: "asmr", type_name: "ASMR" },
      { type_id: "web", type_name: "网页" },
    ];

    const filters = {
      "*": [{ key: "order", name: "排序", value: SORTS }],
    };

    return { class: classes, filters: filters, subFromTab: true };
  }

  /** 分类页 URL（不含 page） */
  listUrl(tid, extend) {
    const ex = extend || {};
    const parts = [];
    const sort = ex.order || ex.sort || "";
    if (sort && sort !== "latest") parts.push("sort=" + encodeURIComponent(sort));
    const up = ex.sub || ex.up || "";
    if (up && !NO_CREATOR[tid]) parts.push("creator_id=" + encodeURIComponent(up));

    const q = parts.length ? "?" + parts.join("&") : "";
    if (tid === "videos" || !tid) return BASE + "/videos" + q;
    if (tid === "shorts") return BASE + "/c/shorts" + q;   // 短剧无博主
    return BASE + "/c/" + tid + q;
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "videos");

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const base = this.listUrl(t, extend);
    const url = base + (base.indexOf("?") >= 0 ? "&" : "?") + "page=" + p;

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

    // ---------- 系列（短剧）----------
    if (url.indexOf("/series/") > 0) {
      const eps = parseEpisodes(html);
      const t = html.match(/<title>([^<]*)<\/title>/);
      const title = clean(t ? t[1] : "").replace(/\s*\|\s*黄视频\s*$/, "").trim();
      const img = html.match(/property="og:image"\s+content="([^"]+)"/);

      if (!eps.length) {
        return {
          list: [{
            vod_id: url, vod_name: title || url, vod_pic: img ? decode(img[1]) : "",
            vod_content: "这个短剧还没有剧集", vod_remarks: "",
            gallery: false,
        vod_play_from: "黄视频", vod_play_url: "正片$" + url,
          }],
        };
      }

      return {
        list: [{
          vod_id: url,
          vod_name: title || url,
          vod_pic: img ? decode(img[1]) : "",
          vod_content: "共 " + eps.length + " 集",
          vod_remarks: eps.length + " 集",
          gallery: false,
        vod_play_from: "黄视频",
          vod_play_url: eps.map((e) => e.name + "$" + BASE + "/videos/" + e.id).join("#"),
        }],
      };
    }

    // ---------- 单个视频 ----------
    const ld = parseJsonLd(html);
    let title = ld && ld.name ? ld.name : "";
    if (!title) {
      const t = html.match(/<title>([^<]*)<\/title>/);
      title = clean(t ? t[1] : "").replace(/\s*\|\s*黄视频\s*$/, "").trim();
    }
    let pic = ld && ld.thumbnailUrl
      ? (Array.isArray(ld.thumbnailUrl) ? ld.thumbnailUrl[0] : ld.thumbnailUrl)
      : "";
    if (!pic) {
      const img = html.match(/property="og:image"\s+content="([^"]+)"/);
      pic = img ? decode(img[1]) : "";
    }
    let dur = "";
    if (ld && ld.duration) {
      const m = String(ld.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (m) {
        // 注意：PT131S 这种「秒数超过 60」很常见，必须先合成总秒再拆
        const total = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
        const h = Math.floor(total / 3600);
        const mi = Math.floor((total % 3600) / 60);
        const se = total % 60;
        dur = h > 0
          ? h + ":" + ("0" + mi).slice(-2) + ":" + ("0" + se).slice(-2)
          : mi + ":" + ("0" + se).slice(-2);
      }
    }

    // 描述里常带「视频时长：28:21」和博主名
    const descM = html.match(/property="og:description"\s+content="([^"]*)"/);
    const desc = descM ? decode(descM[1]) : "";
    const whoM = html.match(/href="\/creators\/([a-z0-9\-]+)"[^>]*>\s*([^<]{1,30})/);

    const lines = [];
    if (whoM) lines.push('[a=cr:{"id":"cr:' + whoM[1] + '"}/]' + clean(whoM[2]) + "[/a]");
    if (dur) lines.push("时长：" + dur);
    if (desc) lines.push(desc);

    const playUrl = ld && ld.contentUrl ? ld.contentUrl : "";

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: pic,
        vod_content: lines.join("\n"),
        vod_remarks: dur,
        gallery: false,
        vod_play_from: "黄视频",
        vod_play_url: "正片$" + (playUrl || url),
      }],
    };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    // 详情页已经把 m3u8 直接塞进 play_url；这里兜底再抓一次
    if (/\.m3u8(\?|$)/.test(url) || /\.mp4(\?|$)/.test(url)) {
      return {
        parse: /\.m3u8/.test(url) ? 1 : 0,
        url: url,
        header: { "User-Agent": UA, "Referer": BASE + "/" },
      };
    }

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }

    const ld = parseJsonLd(html);
    const real = ld && ld.contentUrl ? ld.contentUrl : "";
    if (!real) throw new Error("没找到播放地址");

    return {
      parse: /\.m3u8/.test(real) ? 1 : 0,
      url: real,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  /** 二级 chips：当前分类的博主（站点点自带，带 creator_id） */
  async action(op) {
    if (!op) return [];
    if (op.indexOf("sub|") === 0) {
      const tid = op.substring(4).trim();
      if (NO_CREATOR[tid]) return [];
      if (this.creatorCache && this.creatorCache[tid]) return this.creatorCache[tid];

      const url = tid === "videos" || !tid ? BASE + "/videos" : BASE + "/c/" + tid;
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }

      const list = html ? parseCreators(html) : [];
      if (!this.creatorCache) this.creatorCache = {};
      this.creatorCache[tid] = list;
      return list;
    }
    return [];
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
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
