// 91porn —— BiliTV / catvod QuickJS 插件
//
// 列表  /v.php?page=N[&category=rf|hot|top|topf|mf|tf|md|mr|ori|long]
// 搜索  /v.php?search_id=<关键字>&page=N
// 详情  /view_video.php?viewkey=<id>
// 取流  详情页 <source src="https://ccm.91p52.com/xxx.mp4?st=...">（带 Referer 才放行）
//
// 站点是英文界面：Duration / Views / Comments / Favorites / Added

import { Spider, openWeb } from "catvod";

const BASE = "https://91porn.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 40;

// 分类：value 直接拼到 category=
const CATS = [
  ["rf", "最新"],
  ["hot", "当前最热"],
  ["top", "本月最热"],
  ["ori", "91原创"],
  ["mf", "收藏最多"],
  ["tf", "本月收藏"],
  ["md", "本月讨论"],
  ["mr", "本月评价"],
  ["long", "10分钟以上"],
  ["longer", "20分钟以上"],
];

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

// 去掉零宽字符（站点用来干扰抓取）
function clean(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\u200b-\u200f\u2060\ufeff\ufe00-\ufe0f]/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absolute(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

// 列表卡片：<article class="vitem well-sm well"> … 封面 / duration / <bdi>标题</bdi>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<article class="vitem/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].substring(0, 2600);
    const vk = block.match(/view_video\.php\?viewkey=([a-f0-9]+)/);
    if (!vk) continue;
    const id = vk[1];
    if (seen[id]) continue;
    seen[id] = 1;

    const img = block.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"/);
    const dur = block.match(/<span class="duration">\s*([^<]*?)\s*<\/span>/);
    const t1 = block.match(/<bdi>([\s\S]*?)<\/bdi>/);
    const t2 = block.match(/<span class="video-title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const views = block.match(/Views:\s*<\/span>\s*([0-9,]+)/i);

    const title = clean(t1 ? t1[1] : (t2 ? t2[1] : ""));
    const remarks = clean(dur ? dur[1] : "") || (views ? clean(views[1]) + " 次播放" : "");

    out.push({
      vod_id: BASE + "/view_video.php?viewkey=" + id,
      vod_name: title || id,
      vod_pic: img ? absolute(img[1]) : "",
      vod_remarks: remarks,
    });
  }
  return out;
}

function meta(html, label) {
  const re = new RegExp(label + "\\s*:\\s*<[^>]*>\\s*([^<]{1,40})", "i");
  const m = String(html).match(re);
  return m ? clean(m[1]) : "";
}

export default class P91 extends Spider {
  init() {}

  async homeContent() {
    const classes = [];
    for (const [code, name] of CATS) classes.push({ type_id: "c:" + code, type_name: name });
    classes.push({ type_id: "web", type_name: "网页" });

    // order 组 → App 的「排序」按钮
    const sorts = CATS.map(([code, name]) => ({ n: name, v: code }));
    const filters = {};
    for (const c of classes) {
      if (c.type_id === "web") continue;
      filters[c.type_id] = [{ key: "order", name: "排序", value: sorts }];
    }
    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
      }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const code = (extend && extend.order) || (tid.indexOf("c:") === 0 ? tid.substring(2) : "rf");
    const url = BASE + "/v.php?page=" + p + "&category=" + encodeURIComponent(code);

    let html = "";
    try {
      const r = await this.net.req(url, { headers: headers(BASE + "/v.php?page=1") });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    const total = cards.length < PAGE_SIZE ? (p - 1) * PAGE_SIZE + cards.length : p * PAGE_SIZE + PAGE_SIZE;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const pageUrl = absolute(ids[0]);
    let title = "";
    let pic = "";
    let duration = "";
    const lines = [];

    try {
      const r = await this.net.req(pageUrl, { headers: headers(BASE + "/v.php?page=1") });
      if (r && r.code == 200) {
        const html = r.content;

        const t = html.match(/<title>([^<]+)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*[-|]\s*91porn.*$/i, "");

        const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
        if (og) pic = absolute(og[1]);

        const durSpan = html.match(/(\d{2}:\d{2}:\d{2})/);
        duration = durSpan ? durSpan[1] : meta(html, "Duration");
        const added = meta(html, "Added");
        const views = meta(html, "Views");
        const comments = meta(html, "Comments");
        const favs = meta(html, "Favorites");

        if (added) lines.push("添加：" + added);
        if (duration) lines.push("时长：" + duration);
        if (views) lines.push("播放：" + views);
        if (comments) lines.push("评论：" + comments);
        if (favs) lines.push("收藏：" + favs);
      }
    } catch (e) {
    }

    return {
      list: [{
        vod_id: pageUrl,
        vod_name: title || pageUrl,
        vod_pic: pic,
        vod_content: lines.join("\n"),
        vod_remarks: duration,
        gallery: false,
        vod_play_from: "91porn",
        vod_play_url: "正片$" + pageUrl,
      }],
    };
  }

  async playerContent(flag, id) {
    const pageUrl = absolute(id);
    let html = "";
    try {
      const r = await this.net.req(pageUrl, { headers: headers(BASE + "/v.php?page=1") });
      if (r && r.code == 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) throw new Error("详情页打不开");

    let src = "";
    const s1 = html.match(/<source[^>]+src="([^"]+)"/);
    if (s1) src = clean(s1[1]);
    if (!src) {
      const s2 = html.match(/(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/);
      if (s2) src = clean(s2[1]);
    }
    if (!src) throw new Error("没有找到视频地址（可能是 VIP 内容）");

    // 带上站点 Cookie / Origin：91porn 的直链签名会校验会话
    let cookie = "";
    try {
      cookie = await this.net.getCookie(pageUrl);
    } catch (e) {
      cookie = "";
    }
    const h = {
      "User-Agent": UA,
      "Referer": pageUrl,
      "Origin": BASE,
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    };
    if (cookie) h["Cookie"] = cookie;

    // 部分 CDN 对非浏览器 TLS 直接断连，先用 http 试一次
    const plain = src.replace(/^https:/i, "http:");
    return { parse: 0, url: plain, header: h };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/v.php?search_id=" + encodeURIComponent(key) + "&page=" + p;

    let html = "";
    try {
      const r = await this.net.req(url, { headers: headers(BASE + "/v.php?page=1") });
      if (r && r.code == 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const total = cards.length < PAGE_SIZE ? (p - 1) * PAGE_SIZE + cards.length : p * PAGE_SIZE + PAGE_SIZE;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
