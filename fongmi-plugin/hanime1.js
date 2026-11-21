// Hanime1（hanime1.me）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯视频（H 動漫）
//   ⚠️ 站点对桌面 UA / curl 指纹做 Cloudflare 挑战（Cf-Mitigated: challenge），
//      但**安卓 Chrome UA 直接放行**（实测 200），所以 UA 必须是手机 Chrome。
//
//   列表  /search?query=&page=N                61 张卡片/页
//   分类  /search?genre=<分类>&page=N          10 个分类（見 GENRES）
//   搜索  /search?query=<关键字>&page=N
//   详情  /watch?v=<id>                        og:title / og:image / og:video:duration
//   播放  https://vdownload.hembed.com/<id>-720p.mp4?secure=...   （1080p/720p/480p）
//   标签  详情页里的 ?query= 链接

import { Spider, openWeb } from "catvod";

const BASE = "https://hanime1.me";
// 手机 Chrome 指纹：过 Cloudflare 的关键
const UA = "Mozilla/5.0 (Linux; Android 14; ELI-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PAGE_SIZE = 60;

const GENRES = [
  ["裏番", "裏番"],
  ["泡麵番", "泡麵番"],
  ["Motion Anime", "Motion Anime"],
  ["3DCG", "3DCG"],
  ["2.5D", "2.5D"],
  ["2D動畫", "2D動畫"],
  ["AI生成", "AI生成"],
  ["MMD", "MMD"],
  ["Cosplay", "Cosplay"],
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?1",
    "Sec-Ch-Ua-Platform": '"Android"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": ref ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\\u0026/g, "&");
}

function clean(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|mix)\|/, "");
  if (/^(t|a|c):/.test(u)) u = u.substring(2);
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

// 卡片：<div class="video-item-container" title="..."> ... <a href="/watch?v=ID" class="video-link"> ... <img class="main-thumb" src="..."> <div class="duration"> 01:07 </div> ... <div class="title"> 标题 </div>
function parseCards(html) {
  // 站点有两套卡片结构：
  //   首页      class="video-item-container"（含 duration / title）
  //   分类/搜索 class="home-rows-videos-div search-videos"（含 home-rows-videos-title）
  // 统一做法：按 watch?v= 链接切块，两种结构都能吃。
  const text = String(html || "");
  const marks = [];
  const re = /href="https:\/\/hanime1\.me\/watch\?v=\d+"/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : Math.min(text.length, from + 4000);
    const b = text.substring(from, to);

    const link = b.match(/href="(https:\/\/hanime1\.me\/watch\?v=\d+)"/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    // 封面：优先 cover 图，其次 thumbnail
    const img = b.match(/<img[^>]*src="([^"]*\/image\/cover\/[^"]*)"/) ||
      b.match(/<img[^>]*src="([^"]*hembed[^"]*(?:thumbnail|cover)[^"]*)"/) ||
      b.match(/<img[^>]*class="[^"]*main-thumb[^"]*"[^>]*src="([^"]+)"/);

    // 标题：两种结构都试
    const titleM = b.match(/<div class="home-rows-videos-title">\s*([\s\S]{0,400}?)<\/div>/) ||
      b.match(/<div class="title">\s*([\s\S]{0,400}?)<\/div>/);
    const dur = b.match(/<div class="duration">\s*([\d:]{2,10})\s*<\/div>/);

    out.push({
      vod_id: url,
      vod_name: clean(titleM ? titleM[1] : "") || url,
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: dur ? dur[1] : "",
    });
  }
  return out;
}

export default class Hanime1 extends Spider {
  init() {}

  async homeContent() {
    const classes = [];
    for (const [g, name] of GENRES) {
      classes.push({ type_id: "g:" + g, type_name: name });
    }
    classes.push({ type_id: "latest", type_name: "最新" });
    classes.push({ type_id: "web", type_name: "网页" });

    return {
      class: classes,
      filters: {},
    };
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

    let url;
    if (String(tid).indexOf("g:") === 0) {
      url = BASE + "/search?genre=" + encodeURIComponent(String(tid).substring(2)) + "&page=" + p;
    } else if (String(tid).indexOf("q:") === 0) {
      url = BASE + "/search?query=" + encodeURIComponent(String(tid).substring(2)) + "&page=" + p;
    } else {
      url = BASE + "/search?query=&page=" + p;
    }

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    // 满页 → 还有下一页
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }

    let title = "";
    let pic = "";
    let duration = "";

    if (html) {
      const t = html.match(/property="og:title"[^>]*content="([^"]*)"/);
      if (t) title = clean(t[1]).replace(/\s*-\s*Hanime1\.me.*$/i, "").trim();
      if (!title) {
        const t2 = html.match(/<title>([^<]*)<\/title>/);
        if (t2) title = clean(t2[1]).split(" - H動漫")[0].trim();
      }
      const img = html.match(/property="og:image"[^>]*content="([^"]*)"/);
      if (img) pic = decode(img[1]);
      const d = html.match(/property="og:video:duration"[^>]*content="(\d+)"/);
      if (d) {
        const sec = Number(d[1]);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        duration = m + ":" + ("0" + s).slice(-2);
      }
    }

    // 站点结构：
    //   作者   <a id="video-artist-name" href="?query=xxx">
    //   分类   <a href="?genre=xxx">（在作者旁边）
    //   标签   <div class="video-tags-wrapper"> 里的 ?tags[]=xxx
    const lines = [];
    if (duration) lines.push("时长：" + duration);

    // 作者
    let artistName = "";
    let artistId = "";
    const am = html.match(/id="video-artist-name"[^>]*href="([^"]+)"[^>]*>\s*([^<]{1,40})/);
    if (am) {
      artistName = clean(am[2]);
      const qm = am[1].match(/query=([^&"]+)/);
      if (qm) {
        let kw = decode(qm[1]).replace(/\+/g, " ");
        try { kw = decodeURIComponent(kw); } catch (e) { }
        const ai = kw.indexOf("&");
        if (ai > 0) kw = kw.substring(0, ai);
        artistId = "q:" + kw.trim();
      }
    }

    // 分类：作者旁边的 genre 链接
    const genres = [];
    const gm = html.match(/id="video-artist-name"[\s\S]{0,600}?search\?genre=([^"]+)"[^>]*>\s*([^<]{1,30})/);
    if (gm) {
      let g = decode(gm[1]);
      try { g = decodeURIComponent(g); } catch (e) { }
      genres.push('[a=cr={"id":"g:' + g.trim() + '"}/]' + clean(gm[2]) + "[/a]");
    }

    // 标签：video-tags-wrapper 区块
    const tags = [];
    const seenT = {};
    const tw = html.match(/class="video-details-wrapper video-tags-wrapper"[\s\S]{0,8000}/);
    if (tw) {
      const re = /href="[^"]*[?&]tags(?:%5B%5D|\[\])=([^"]+)"[^>]*>([\s\S]{0,80}?)<\/a>/g;
      let m;
      while ((m = re.exec(tw[0])) !== null) {
        let kw = decode(m[1]).replace(/\+/g, " ");
        try { kw = decodeURIComponent(kw); } catch (e) { }
        // 链接里可能带 &amp;genre=xxx，截掉
        const ampIdx = kw.indexOf("&");
        if (ampIdx > 0) kw = kw.substring(0, ampIdx);
        kw = kw.trim();
        if (!kw || seenT[kw]) continue;
        seenT[kw] = 1;
        const name = clean(m[2]).replace(/\(\d+\)$/, "").trim() || kw;
        tags.push('[a=cr={"id":"q:' + kw + '"}/]' + name + "[/a]");
        if (tags.length >= 12) break;
      }
    }

    if (genres.length) lines.push(genres.join(" · "));
    if (tags.length) lines.push(tags.join(" · "));

    // 作者放进 remarks（App 里显示成作者行、可点）
    let authorRemarks = "";
    if (artistName) {
      authorRemarks = artistId
        ? '[a=cr={"id":"' + artistId + '"}/]' + artistName + "[/a]"
        : artistName;
    }

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: pic,
        vod_content: lines.join("\n"),
        vod_remarks: authorRemarks || duration,
        gallery: false,
        vod_play_from: "Hanime1",
        vod_play_url: "正片$" + url,
      }],
    };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) throw new Error("详情页打不开");

    // 优先 1080p → 720p → 480p
    const all = [];
    const re = /(https:\/\/vdownload\.hembed\.com\/\d+-(1080p|720p|480p)\.mp4[^"'\s]*)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (all.indexOf(m[1]) < 0) all.push(m[1]);
    }
    if (!all.length) throw new Error("没找到播放地址");

    const pick = (q) => all.find((u) => u.indexOf("-" + q + ".mp4") > 0);
    const target = pick("1080p") || pick("720p") || pick("480p") || all[0];

    return {
      parse: 0,
      url: target,
      header: {
        "User-Agent": UA,
        "Referer": BASE + "/",
      },
    };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/search?query=" + encodeURIComponent(key) + "&page=" + p;

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
