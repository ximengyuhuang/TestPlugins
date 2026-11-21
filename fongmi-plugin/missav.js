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

// 站点真实导航：direct = 直接列表页；sub = ▾ 二级菜单（App 会弹纯文字菜单）
// 子项 id 用 "p:<路径>"，categoryContent 里还原成路径
const NAV = [
  { id: "latest", name: "最新", path: "/en/new" },
  {
    id: "hot", name: "热门", sub: [
      ["本周最热", "/en/weekly-hot"],
      ["本月最热", "/en/monthly-hot"],
      ["今日最热", "/en/today-hot"],
    ],
  },
  { id: "csub", name: "中文字幕", path: "/en/chinese-subtitle" },
  {
    id: "jp", name: "日本AV", sub: [
      ["PRESTIGE", "/en/maan"],
      ["S-CUTE", "/en/scute"],
      ["SIRO", "/en/siro"],
      ["LUXU", "/en/luxu"],
      ["GANA", "/en/gana"],
      ["ARA", "/en/ara"],
      ["XXX-AV", "/en/xxxav"],
      ["Naughty 4610", "/en/naughty4610"],
      ["Naughty 0930", "/en/naughty0930"],
      ["Married Slash", "/en/marriedslash"],
    ],
  },
  {
    id: "amateur", name: "素人", sub: [
      ["FC2", "/en/fc2"],
      ["HEYZO", "/en/heyzo"],
      ["Tokyo Hot", "/en/tokyohot"],
      ["1pondo", "/en/1pondo"],
      ["Caribbeancom", "/en/caribbeancom"],
      ["Caribbeancompr", "/en/caribbeancompr"],
      ["10musume", "/en/10musume"],
      ["pacopacomama", "/en/pacopacomama"],
      ["Gachinco", "/en/gachinco"],
    ],
  },
  {
    id: "uncen", name: "无码", sub: [
      ["无码流出", "/en/uncensored-leak"],
      ["新发行", "/en/release"],
    ],
  },
  {
    id: "asia", name: "亚洲AV", sub: [
      ["麻豆传媒", "/en/madou"],
      ["TWAV", "/en/twav"],
      ["Furuke", "/en/furuke"],
      ["韩国直播", "/en/klive"],
      ["中国直播", "/en/clive"],
    ],
  },
];

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
    const classes = [];
    for (const item of NAV) {
      if (item.sub && item.sub.length) {
        classes.push({
          type_id: item.id,          // 父级不直接加载列表，点开是二级菜单
          type_name: item.name,
          sub: item.sub.map(([n, p]) => ({ id: "p:" + p, name: n })),
        });
      } else {
        classes.push({ type_id: "p:" + item.path, type_name: item.name });
      }
    }
    classes.push({ type_id: "web", type_name: "网页" });

    // 排序：给所有直接列表 tab（下拉父级不给，避免误导）
    const filters = {};
    for (const c of classes) {
      if (c.sub) continue;
      if (c.type_id === "web") continue;
      filters[c.type_id] = [{ key: "order", name: "排序", value: SORTS.map(([v, n]) => ({ n: n, v: v })) }];
    }
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

    // 路径解析：p:<路径> 直接列表；t:/a: 标签/女优页；兼容旧的 latest 等 id
    let path = "";
    const sid = String(tid);
    if (sid.indexOf("p:") === 0) {
      path = sid.substring(2);
    } else if (sid.indexOf("t:") === 0 || sid.indexOf("a:") === 0) {
      path = pageUrlOf(sid).replace(/^https?:\/\/[^/]+/, "");
    } else {
      const legacy = { latest: "/en/new", weekly: "/en/weekly-hot", monthly: "/en/monthly-hot", csub: "/en/chinese-subtitle", uncen: "/en/uncensored-leak" };
      path = legacy[sid] || "/en/new";
    }

    const sort = (extend && extend.order) || "";
    if (sort && path.indexOf("/new") >= 0) {
      path += "?sort=" + encodeURIComponent(sort);
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
    // 不依赖页面里的末页链接（手机端 HTML 可能没有）：满页就认为后面还有
    const total = cards.length < PAGE_SIZE
      ? (p - 1) * PAGE_SIZE + cards.length
      : p * PAGE_SIZE + PAGE_SIZE;
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
      // 时长由前端 JS 从 item.duration 渲染，服务端 HTML 里只有占位/日期，这里不取
    }

    // 类型 → 标签 chip（t:<类型页URL>）
    // 注意：真实类型链接带 dm 前缀，如 /dm157/en/genres/Big%20Breasts；导航项是 /en/genres、/en/genres/VR
    const lines = [];
    const genres = [];
    const seenG = {};
    const reG = /href="(https:\/\/missav\.live\/(?:dm\d+\/)?en\/genres\/([^"]+))"/g;
    let m;
    while ((m = reG.exec(html)) !== null) {
      const u = m[1];
      const raw = m[2];
      if (!raw || raw === "VR" || raw === "ranking") continue;
      if (seenG[u]) continue;
      seenG[u] = 1;
      let name = raw;
      try {
        name = decodeURIComponent(raw.replace(/\/$/, ""));
      } catch (e) {
        name = raw;
      }
      if (name) genres.push('[a=cr:{"id":"t:' + u + '"}/]' + name + "[/a]");
      if (genres.length >= 12) break;
    }
    if (genres.length) lines.push(genres.join(" · "));

    // 女优 → 作者行（a:<女优页URL>），同样只认真实女优页（带 dm 前缀）
    let authorLink = "";
    const reA = /href="(https:\/\/missav\.live\/dm\d+\/en\/actresses\/([^"]+))"/;
    const ma = html.match(reA);
    if (ma) {
      let aname = ma[2];
      try {
        aname = decodeURIComponent(ma[2].replace(/\/$/, ""));
      } catch (e) {
        aname = ma[2];
      }
      if (aname && aname !== "ranking") {
        authorLink = '[a=cr:{"id":"a:' + ma[1] + '"}/]' + aname + "[/a]";
      }
    }

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: pic || "",
        vod_content: lines.join("\n"),
        vod_remarks: authorLink || duration,
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
    // 不依赖页面里的末页链接（手机端 HTML 可能没有）：满页就认为后面还有
    const total = cards.length < PAGE_SIZE
      ? (p - 1) * PAGE_SIZE + cards.length
      : p * PAGE_SIZE + PAGE_SIZE;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
