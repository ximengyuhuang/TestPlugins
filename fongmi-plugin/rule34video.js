// Rule34Video（rule34video.com）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯视频（单画质 360p mp4 直链，带 acctoken）
//   列表  /                                    ?page=N  ?sort_by=post_date|video_viewed|rating|duration|pseudo_rand   24 条/页
//   分类  /categories/<slug>/                  ?page=N
//   标签  /tags/<slug>/                        ?page=N
//   模型  /models/<slug>/                      ?page=N
//   详情  /video/<id>/<slug>/                  播放地址 video_url: '.../get_file/.../<id>_360.mp4/?v-acctoken=...'
//   搜索  /?q=<关键字>&page=N

import { Spider, openWeb } from "catvod";

const BASE = "https://rule34video.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

const SORTS = [
  ["post_date", "最近发布"],
  ["video_viewed", "最多观看"],
  ["rating", "最高评分"],
  ["duration", "时长最长"],
  ["pseudo_rand", "随机"],
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
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
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

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|mix)\|/, "");
  if (u.indexOf("t:") === 0 || u.indexOf("a:") === 0) u = u.substring(2);
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  return absolute(u);
}

/** slug 转可读名：3d → 3D、asa-mitaka-chainsaw-man → Asa Mitaka Chainsaw Man */
function slugName(slug) {
  const s = String(slug || "").replace(/\/$/, "");
  if (!s) return "";
  if (/^[0-9]+$/.test(s)) return s;
  return s.split("-").map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

/** 页面里是否还有下一页（站点每页 24 条里常混广告，不能只按条数判断） */
function hasNextPage(html, p) {
  const next = p + 1;
  return String(html).indexOf("page=" + next + "\"") >= 0 ||
    String(html).indexOf("page=" + next + "&") >= 0 ||
    String(html).indexOf("page=" + next + "'") >= 0;
}

// 卡片：<div class="item thumb video_N" data-video-card-id="ID"> … <a class="th …" href="/video/…" title="…"> <img class="thumb" src="…336x189/1.jpg">
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/class="item thumb video_\d+/);
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i].substring(0, 2500);
    const link = b.match(/href="(https:\/\/rule34video\.com\/video\/[^"]+)"/);
    if (!link) continue;                       // 广告位没有 /video/ 链接
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const img = b.match(/<img[^>]*class="thumb"[^>]*src="([^"]+)"/) || b.match(/<img[^>]*src="([^"]+videos_screenshots[^"]*)"/);
    const title = b.match(/<a[^>]*class="th[^"]*"[^>]*title="([^"]*)"/) || b.match(/<img[^>]*alt="([^"]*)"/);
    const dur = b.match(/class="duration"[^>]*>\s*([\d:]{4,10})\s*</);

    out.push({
      vod_id: url,
      vod_name: clean(title ? title[1] : "") || url,
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: dur ? dur[1] : "",
    });
  }
  return out;
}

export default class Rule34Video extends Spider {
  init() {
    this.subCache = null;
  }

  async homeContent() {
    // 分类 46 个 / 模型 68 个，站点一页给全 → 用「文件夹列表」承载（App 会渲染成文字行，点一下下钻）
    const classes = [
      { type_id: "p:/", type_name: "视频" },
      { type_id: "cats", type_name: "分类" },
      { type_id: "models", type_name: "模型" },
      { type_id: "web", type_name: "网页" },
    ];
    return {
      class: classes,
      filters: {
        "p:/": [{ key: "order", name: "排序", value: SORTS.map(([v, n]) => ({ n: n, v: v })) }],
      },
    };
  }

  /** 网页侧解析：文件夹条目（分类 / 模型）
   *  站点条目 class 写法不统一，改为「按 href 位置切块」：每块的结束位置 = 下一个同类 href。
   */
  parseFolders(html, kind) {
    const text = String(html || "");
    const re = new RegExp('href="https:\\/\\/rule34video\\.com\\/' + kind + '\\/([^"/]+)\\/"', "g");
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      marks.push({ slug: m[1], start: m.index, end: m.index + m[0].length });
    }

    const out = [];
    const seen = {};
    for (let i = 0; i < marks.length; i++) {
      const cur = marks[i];
      if (seen[cur.slug]) continue;
      seen[cur.slug] = 1;

      const stop = i + 1 < marks.length ? marks[i + 1].start : Math.min(text.length, cur.end + 3000);
      const block = text.substring(cur.end, Math.min(stop, cur.end + 3000));

      const nameM = block.match(/<div class="name">\s*([\s\S]{0,120}?)\s*<div class="count">/);
      const name = clean(nameM ? nameM[1] : "") || slugName(cur.slug);
      const cntM = block.match(/<div class="count">([\s\S]{0,200}?)<\/div>/);
      const cnt = cntM ? (clean(cntM[1]).match(/\d+/) || [""])[0] : "";

      out.push({
        vod_id: "p:/" + kind + "/" + cur.slug + "/",
        vod_name: name,
        vod_pic: "",
        vod_remarks: cnt ? cnt + " 视频" : "",
        vod_tag: "folder",
      });
    }
    return out;
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

    // 分类 / 模型：返回文件夹列表（App 渲染成文字行，点一下下钻）
    if (tid === "cats" || tid === "models") {
      const path = tid === "cats" ? "/categories/" : "/models/";
      const url = BASE + path + (p > 1 ? "?page=" + p : "");
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs(url) });
        if (r && r.code === 200) html = r.content;
      } catch (e) {
        html = "";
      }
      const folders = html ? this.parseFolders(html, tid === "cats" ? "categories" : "models") : [];
      return this.page(folders, p, folders.length || 1, folders.length);
    }

    // p:<路径> → 路径；t:/a: → 对应页
    let path = "/";
    const sid = String(tid);
    if (sid.indexOf("p:") === 0) path = sid.substring(2);
    else if (sid.indexOf("t:") === 0 || sid.indexOf("a:") === 0) {
      path = pageUrlOf(sid).replace(/^https?:\/\/[^/]+/, "");
    }

    const sort = (extend && extend.order) || "post_date";
    let url = BASE + path + (path.indexOf("?") >= 0 ? "&" : "?") + "page=" + p;
    if (path === "/") url += "&sort_by=" + encodeURIComponent(sort);

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    const more = hasNextPage(html, p) || cards.length >= PAGE_SIZE - 1;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let title = "";
    let pic = "";
    let html = "";

    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }

    if (html) {
      const t = html.match(/<title>([^<]+)<\/title>/);
      if (t) title = clean(t[1]).replace(/\s*[-|]\s*Rule34Video.*$/i, "").trim();
      const shot = html.match(/content="(https:\/\/rule34video\.com\/contents\/videos_screenshots\/[^"]+)"/) ||
        html.match(/src="(https:\/\/rule34video\.com\/contents\/videos_screenshots\/[^"]+)"/);
      if (shot) pic = decode(shot[1]);
    }

    // 标签 chips（t:）与模型 chips（a:）
    const lines = [];
    const tags = [];
    const seenT = {};
    const reT = /href="(https:\/\/rule34video\.com\/tags\/([^"\/]+)\/)"/g;
    let m;
    while ((m = reT.exec(html)) !== null) {
      const u = m[1];
      if (seenT[u]) continue;
      seenT[u] = 1;
      tags.push('[a=cr:{"id":"t:' + u + '"}/]' + slugName(m[2]) + "[/a]");
      if (tags.length >= 10) break;
    }
    if (tags.length) lines.push(tags.join(" · "));

    const models = [];
    const seenM = {};
    const reM = /href="(https:\/\/rule34video\.com\/models\/([^"\/]+)\/)"/g;
    while ((m = reM.exec(html)) !== null) {
      const u = m[1];
      if (seenM[u]) continue;
      seenM[u] = 1;
      models.push('[a=cr:{"id":"a:' + u + '"}/]' + slugName(m[2]) + "[/a]");
      if (models.length >= 6) break;
    }
    if (models.length) lines.push(models.join(" · "));

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: pic,
        vod_content: lines.join("\n"),
        vod_remarks: "",
        gallery: false,
        vod_play_from: "Rule34Video",
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

    // video_url: 'https://…/<id>_360.mp4/?v-acctoken=…'
    const m = html.match(/video_url:\s*['"]([^'"]+\.mp4[^'"]*)['"]/) ||
      html.match(/(https:\/\/rule34video\.com\/get_file\/[^'"\s]+\.mp4[^'"\s]*)/);
    if (!m) throw new Error("没找到播放地址");

    return {
      parse: 0,
      url: decode(m[1]),
      header: { "User-Agent": UA, "Referer": url },
    };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/?q=" + encodeURIComponent(key) + "&page=" + p;

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const more = hasNextPage(html, p) || cards.length >= PAGE_SIZE - 1;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
