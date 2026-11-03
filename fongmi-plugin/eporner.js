// EPorner —— FongMi / TVBox QuickJS 源
//
// 取流：视频地址里的 vid → /embed/<vid>/ 拿 EP.video.player.hash（md5）
//       → 每 8 个十六进制字符转 36 进制拼接
//       → GET /xhr/video/<vid>?hash=<转换后>… (XHR 头) → JSON sources
//       → sources.mp4 里有 480p/720p/1080p… 直链

import { Spider, openWeb } from "catvod";

const BASE = "https://www.eporner.com";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// [tid, 路径, 名称]
const CATS = [
  ["recent", "/", "最新"],
  ["viewed", "/most-viewed/", "最多观看"],
  ["rated", "/top-rated/", "评分最高"],
  ["longest", "/longest/", "最长"],
  ["cowgirl", "/tag/cowgirl/", "Cowgirl"],
  ["riding", "/tag/riding/", "Riding"],
  ["housewives", "/cat/housewives/", "Housewives"],
  ["turkish", "/tag/turkish/", "Turkish"],
];

// PornHub 标准分类（28 个通用的），EPorner 全都有对应标签
const GENRES = [
  ["asian", "Asian"], ["japanese", "Japanese"], ["uncensored", "Uncensored"], ["korean", "Korean"],
  ["amateur", "Amateur"], ["anal", "Anal"], ["big-ass", "Big Ass"],
  ["big-tits", "Big Tits"], ["blonde", "Blonde"], ["blowjob", "Blowjob"],
  ["brunette", "Brunette"], ["cosplay", "Cosplay"], ["creampie", "Creampie"],
  ["cuckold", "Cuckold"], ["ebony", "Ebony"], ["fetish", "Fetish"],
  ["handjob", "Handjob"], ["hardcore", "Hardcore"], ["latina", "Latina"],
  ["lesbian", "Lesbian"], ["massage", "Massage"], ["mature", "Mature"],
  ["milf", "MILF"], ["masturbation", "Masturbation"], ["pov", "POV"],
  ["public", "Public"], ["squirt", "Squirt"], ["threesome", "Threesome"],
  ["toys", "Toys"],
];

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function strip(s) {
  return decode((s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function absolute(u) {
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("/") === 0) return BASE + u;
  return u;
}

// 列表：<div class="mb"> … <p class="mbtit"><a href="…">标题</a>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/<div class="mb"[^>]*>/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].substring(0, 2500);

    const a = block.match(/<p class="mbtit"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = absolute(a[1]);
    if (!url || seen[url]) continue;
    seen[url] = 1;

    const img = block.match(/data-src="([^"]+)"/) || block.match(/<img[^>]*src="([^"]+)"/);
    out.push({
      vod_id: url,
      vod_name: strip(a[2]),
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: "",
    });
  }
  return out;
}

export default class EPorner extends Spider {
  init(extend) {
    this.log("eporner ready");
  }

  async homeContent(filter) {
    const classes = [{ type_id: CATS[0][0], type_name: CATS[0][2] }];
    classes.push({ type_id: "web", type_name: "网页" });
    for (let i = 1; i < CATS.length; i++) classes.push({ type_id: CATS[i][0], type_name: CATS[i][2] });

    // 动态补全标签：/tag/N/ 分页（每页约 50 个）
    if (!this.tags) {
      const list = [];
      const seen = {};
      try {
        for (let p = 1; p <= 6; p++) {
          const url = BASE + "/tag/" + (p > 1 ? p + "/" : "");
          const r = await this.net.req(url, { headers: headers() });
          if (!r || r.code !== 200) break;
          const re = /href="\/tag\/([a-z0-9\-]+)\/"/g;
          let m;
          let added = 0;
          while ((m = re.exec(r.content)) !== null) {
            if (seen[m[1]]) continue;
            seen[m[1]] = 1;
            list.push(m[1]);
            added++;
            if (list.length >= 200) break;
          }
          if (added === 0 || list.length >= 200) break;
        }
        this.tags = list;
      } catch (e) {
        this.log("tags failed: " + e);
      }
    }

    // 标准分类（PornHub 那套，28 个，全部有对应标签）
    for (const [slug, name] of GENRES) {
      classes.push({ type_id: "g:" + slug, type_name: name });
    }

    // 按字母分段（标签 200 个，直接铺太长）
    for (const g of this.buildSegments()) {
      classes.push({ type_id: "seg:" + g.key, type_name: g.key + " (" + g.items.length + ")" });
    }

    return { class: classes };
  }

  buildSegments() {
    if (this.segs) return this.segs;
    const groups = {};
    for (const t of this.tags || []) {
      const ch = String(t).charAt(0).toUpperCase();
      const key = ch >= "A" && ch <= "Z" ? ch : "#";
      groups[key] = groups[key] || [];
      groups[key].push(t);
    }
    this.segs = Object.keys(groups)
      .sort()
      .map((k) => ({ key: k, items: groups[k] }));
    return this.segs;
  }

  async segmentList(seg, p) {
    const list = [];
    const seen = {};
    const groups = this.buildSegments();
    const g = groups.find((x) => x.key === seg);
    if (!g) return this.page([], p, 30, 0);

    const max = 6;
    const items = g.items.slice((Math.max(1, p) - 1) * max, Math.max(1, p) * max);
    for (const t of items) {
      try {
        const r = await this.net.req(BASE + "/tag/" + t + "/", { headers: headers() });
        if (!r || r.code !== 200) continue;
        for (const c of parseCards(r.content)) {
          if (seen[c.vod_id]) continue;
          seen[c.vod_id] = 1;
          list.push(c);
        }
      } catch (e) {
        this.log("seg item failed: " + e);
      }
    }
    const more = Math.max(1, p) * max < g.items.length;
    return this.page(list, p, 30, more ? (p + 1) * 30 : p * 30);
  }

  async categoryContent(tid, pg, filter, extend) {
    if (tid.indexOf("seg:") === 0) return await this.segmentList(tid.substring(4), Number(pg) || 1);

    if (tid === "web") {
      try {
        openWeb({ url: BASE });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 30, 0);
    }

    let path = CATS[0][1];
    if (tid.indexOf("g:") === 0) {
      path = "/tag/" + tid.substring(2) + "/";
    } else if (tid.indexOf("tag:") === 0) {
      path = "/tag/" + tid.substring(4) + "/";
    } else {
      for (const c of CATS) {
        if (c[0] === tid) {
          path = c[1];
          break;
        }
      }
    }

    const p = Number(pg) || 1;
    let url;
    if (p <= 1) {
      url = BASE + path;
    } else {
      const base = path.replace(/\/$/, "");
      url = BASE + (base === "" ? "/" + p + "/" : base + "/" + p + "/");
    }

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 30, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = String(id).indexOf("http") === 0 ? String(id) : absolute(String(id));
      let title = "";
      let pic = "";
      let content = "";
      let duration = "";

      try {
        const r = await this.net.req(pageUrl, { headers: headers() });
        if (r && r.code === 200) {
          const html = r.content;

          const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          const ogt = html.match(/property="og:title"[^>]*content="([^"]+)"/);
          title = h1 ? strip(h1[1]) : ogt ? decode(ogt[1]) : "";

          const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
          if (ogi) pic = decode(ogi[1]);

          const dur = html.match(/<span class="vid-length">\s*([0-9]+)\s*min/i);
          if (dur) duration = dur[1];

          const lines = [];
          if (duration) lines.push("时长: " + duration + " 分钟");

          const tags = [];
          const reT = /<li class="vit-category"[^>]*>\s*<a[^>]*>([^<]*)<\/a>/g;
          let m;
          while ((m = reT.exec(html)) !== null) {
            const t = strip(m[1]);
            if (t && tags.indexOf(t) < 0) tags.push(t);
          }
          if (tags.length) lines.push("分类: " + tags.slice(0, 10).join(" / "));

          const desc = html.match(/property="og:description"[^>]*content="([^"]+)"/);
          if (desc) lines.push(decode(desc[1]).substring(0, 120));

          content = lines.filter(Boolean).join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || String(id),
        vod_pic: pic,
        vod_content: content,
        vod_remarks: duration ? duration + " 分钟" : "",
        vod_play_from: "EPorner",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const pageUrl = String(id).indexOf("http") === 0 ? String(id) : absolute(String(id));

    const mv = pageUrl.match(/\/(?:embed|video)-([A-Za-z0-9]+)/);
    if (!mv) throw new Error("无法识别视频 id");
    const vid = mv[1];

    // 1. embed 页拿 md5
    const embedUrl = BASE + "/embed/" + vid + "/";
    const r1 = await this.net.req(embedUrl, { headers: headers(pageUrl) });
    if (!r1 || r1.code !== 200) throw new Error("无法打开 embed 页");

    const hm = r1.content.match(/EP\.video\.player\.hash\s*=\s*'([^']+)'/);
    if (!hm) throw new Error("找不到 hash");

    // 2. md5 → 每 8 位十六进制转 36 进制后拼接
    const md5 = hm[1];
    const chunks = md5.match(/.{1,8}/g) || [];
    let converted = "";
    for (const c of chunks) converted += parseInt(c, 16).toString(36);

    // 3. 取 sources
    const xhr = BASE + "/xhr/video/" + vid + "?hash=" + converted +
      "&domain=www.eporner.com&pixelRatio=1&playerWidth=0&playerHeight=0" +
      "&fallback=false&embed=true&supportedFormats=hls,dash,h265,vp9,av1,mp4&_=" + Date.now();

    const r2 = await this.net.req(xhr, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": embedUrl,
      },
    });
    if (!r2 || r2.code !== 200) throw new Error("换源失败");

    let data;
    try {
      data = JSON.parse(r2.content);
    } catch (e) {
      throw new Error("换源返回解析失败");
    }

    const sources = data.sources || {};
    const mp4 = sources.mp4 || {};

    let best = "";
    let bestQ = 0;
    for (const key in mp4) {
      const item = mp4[key] || {};
      const src = item.src || "";
      if (!src || src.indexOf("/dload/") >= 0) continue;
      const q = parseInt(String(item.labelShort || key).replace(/[^0-9]/g, ""), 10) || 0;
      if (q >= bestQ) {
        bestQ = q;
        best = src;
      }
    }

    // 没有 mp4 就用 hls
    if (!best) {
      const hls = sources.hls || {};
      for (const key in hls) {
        const src = (hls[key] || {}).src || "";
        if (src) {
          best = src;
          break;
        }
      }
    }

    if (!best) throw new Error("没有可用播放源");

    return {
      parse: 0,
      url: absolute(best),
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const q = String(key).trim().replace(/\s+/g, "-");
    const url = BASE + "/search/" + encodeURIComponent(q) + (p > 1 ? "/" + p + "/" : "/");

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 30, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }
}
