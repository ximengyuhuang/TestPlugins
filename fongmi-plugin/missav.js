// MissAV（missav.live）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯视频（无图集）
//   列表  /en/new | /en/weekly-hot | /en/monthly-hot | /en/chinese-subtitle | /en/uncensored-leak
//         ?sort=released_at|published_at|saved|today_views|weekly_views|monthly_views|views
//         ?page=N                                   12 条/页（页面里有 page=2000 的末页链接）
//   搜索  /en/search/<关键字>?page=N
//   详情  /en/<番号>    （301 到 /dmNNN/en/<番号>，跟随重定向即可）
//   类型  /en/genres/<名字>        → 标签 chip（t:）
//   女优  /en/actresses/<名字>     → 作者行（a:）
//   取流  详情页里有 c.surrit.com/<uuid>/seek/… → https://c.surrit.com/<uuid>/playlist.m3u8
//         （必须带 Referer: https://missav.live/；旧域名 surrit.com 已 403 BucketPunish）

import { Spider, openWeb } from "catvod";

const BASE = "https://missav.live";
const CDN = "https://c.surrit.com";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PAGE_SIZE = 12;

const CATS = [
  ["latest", "最新", "/en/new"],
  ["weekly", "每周热门", "/en/weekly-hot"],
  ["monthly", "每月热门", "/en/monthly-hot"],
  ["csub", "中文字幕", "/en/chinese-subtitle"],
  ["uncen", "无码流出", "/en/uncensored-leak"],
];

// 排序：站点 ?sort= 的 7 个取值
const SORTS = [
  ["published_at", "最近更新"],
  ["released_at", "发行日期"],
  ["today_views", "今日观看"],
  ["weekly_views", "本周观看"],
  ["monthly_views", "本月观看"],
  ["views", "总观看"],
  ["saved", "收藏最多"],
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function clean(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function absolute(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 详情 id 可能带 v| / mix| 前缀或 |数字 尾巴 */
function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|mix)\|/, "");
  if (u.indexOf("t:") === 0 || u.indexOf("a:") === 0) u = u.substring(2);
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  return absolute(u);
}

// 卡片：<div ... class="thumbnail group"> … 标题行 <div class="my-2 … truncate"><a href="…">番号 标题</a>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split('class="thumbnail group"');
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i].substring(0, 8000);

    // 以「标题行」的链接为准（卡片里还可能有广告位 <a>，例如 /en/love-142）
    const tt = b.match(/<div class="my-2[^"]*truncate">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,2000}?)<\/a>/);
    if (!tt) continue;
    const url = absolute(tt[1]);
    if (seen[url]) continue;
    seen[url] = 1;

    const cover = b.match(/data-src="([^"]*\/cover[^"]*)"/) || b.match(/data-src="([^"]+)"/);
    const alt = b.match(/<img[^>]*alt="([^"]*)"/);
    const dur = b.match(/<span class="absolute bottom-1 right-1[^"]*">\s*([\d:]{4,10})\s*<\/span>/);

    const name = clean(tt[2]) || (alt ? decode(alt[1]) : url);
    out.push({
      vod_id: url,
      vod_name: name.length > 120 ? name.substring(0, 120) + "…" : name,
      vod_pic: cover ? decode(cover[1]) : "",
      vod_remarks: dur ? dur[1] : "",
    });
  }
  return out;
}

/** 从列表页里读末页页码（页面有 page=2000 这类链接） */
function lastPage(html) {
  let max = 1;
  const re = /[?&]page=(\d+)/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const n = Number(m[1]);
    if (n > max && n < 100000) max = n;
  }
  return max;
}

export default class MissAv extends Spider {
  init() {}

  async homeContent() {
    const classes = CATS.map(([id, name]) => ({ type_id: id, type_name: name }))
      .concat([{ type_id: "web", type_name: "网页" }]);

    // 排序只给「最新」tab（其它 tab 站点用固定排序，给了也不生效，避免误导）
    const filters = {
      latest: [{ key: "order", name: "排序", value: SORTS.map(([v, n]) => ({ n: n, v: v })) }],
    };
    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/en/new" });
      } catch (e) {
      }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 标签 / 女优 页：t:<url> / a:<url>
    let path;
    if (String(tid).indexOf("t:") === 0 || String(tid).indexOf("a:") === 0) {
      path = pageUrlOf(tid);
      path = path.replace(/^https?:\/\/[^/]+/, "");
    } else {
      const hit = CATS.find((c) => c[0] === tid);
      path = hit ? hit[2] : CATS[0][2];
      const sort = (extend && extend.order) || "";
      if (sort && tid === "latest") path += "?sort=" + encodeURIComponent(sort);
    }

    const sep = path.indexOf("?") >= 0 ? "&" : "?";
    const url = BASE + path + (p > 1 ? sep + "page=" + p : "");

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    const total = lastPage(html) * PAGE_SIZE;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let title = "";
    let pic = "";
    let duration = "";
    let html = "";

    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }

    if (html) {
      const ogt = html.match(/property="og:title"[^>]*content="([^"]+)"/);
      title = ogt ? decode(ogt[1]) : "";
      const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
      pic = ogi ? decode(ogi[1]) : "";
      const d = html.match(/(\d{1,2}:\d{2}:\d{2})/);
      if (d) duration = d[1];
    }

    // 类型 → 标签 chip（t:<类型页URL>）；女优 → 作者行（a:<女优页URL>）
    const lines = [];
    if (duration) lines.push("时长：" + duration);

    const genres = [];
    const seenG = {};
    const reG = /href="(https:\/\/missav\.live\/en\/genres\/[^"]+)"/g;
    let m;
    while ((m = reG.exec(html)) !== null) {
      const u = m[1];
      if (seenG[u]) continue;
      seenG[u] = 1;
      let name = "";
      try {
        name = decodeURIComponent(u.replace(/^.*\/genres\//, "").replace(/\/$/, ""));
      } catch (e) {
        name = u;
      }
      if (name && name !== "VR") genres.push('[a=cr:{"id":"t:' + u + '"}/]' + name + "[/a]");
      if (genres.length >= 12) break;
    }
    if (genres.length) lines.push(genres.join(" · "));

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: pic || "",
        vod_content: lines.join("\n"),
        vod_remarks: duration,
        gallery: false,
        vod_play_from: "missav",
        vod_play_url: "正片$" + url,
      }],
    };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) throw new Error("详情页打不开");

    // 只认 c.surrit.com/<uuid>/seek 那个 uuid（页面里还混着广告追踪 uuid）
    let uuid = "";
    const m1 = html.match(/c\.surrit\.com\\?\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\?\/seek/);
    if (m1) {
      uuid = m1[1];
    } else {
      // 兜底：uuid 后面 60 字符内出现 seek
      const re = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const tail = html.substring(m.index, m.index + 120);
        if (tail.indexOf("seek") >= 0) {
          uuid = m[1];
          break;
        }
      }
    }
    if (!uuid) throw new Error("没找到播放 id（可能需要先在网页里过验证）");

    return {
      parse: 1,                                   // HLS
      url: CDN + "/" + uuid + "/playlist.m3u8",
      header: {
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Origin": BASE,
      },
    };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/en/search/" + encodeURIComponent(key) + (p > 1 ? "?page=" + p : "");

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const total = lastPage(html) * PAGE_SIZE;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
