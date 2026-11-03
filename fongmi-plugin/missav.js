// missav.live —— FongMi / TVBox QuickJS 源
//
// 说明：missav.ws / missav.ai 有 Cloudflare，但 **missav.live 没有**（直连 200），所以用 .live。
// 取流：视频页 HTML 里就有 surrit 的 uuid（缩略图路径 surrit.com/<uuid>/seek/…）
//       → https://surrit.com/<uuid>/playlist.m3u8（必须带 Referer: https://missav.live/）

import { Spider, openWeb } from "catvod";

const BASE = "https://missav.live";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// [tid, 路径, 显示名]
const CATS = [
  ["new", "/en/new?sort=published_at", "最新"],
  ["weekly", "/dm169/en/weekly-hot?sort=weekly_views", "每周热门"],
  ["monthly", "/dm263/en/monthly-hot?sort=views", "每月热门"],
  ["subtitle", "/en/english-subtitle", "英文字幕"],
  ["uncensored", "/dm628/en/uncensored-leak", "无码流出"],
  ["fc2", "/dm150/en/fc2", "FC2"],
  ["madou", "/dm35/en/madou", "麻豆"],
  ["tokyohot", "/dm29/en/tokyohot", "东京热"],
  ["1pondo", "/dm2469695/en/1pondo", "一本道"],
  ["caribbean", "/dm3959622/en/caribbeancom", "加勒比"],
];

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
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

// 卡片：class="thumbnail group"
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/class="thumbnail group"/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].substring(0, 3500);

    const a = block.match(/<a href="(https:\/\/missav\.live\/[^"]+)"[^>]*alt="([^"]*)"/);
    if (!a) continue;
    const url = a[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const img = block.match(/<img[^>]*data-src="([^"]+)"/) || block.match(/<img[^>]*src="(https:[^"]+)"/);
    const alt = block.match(/<img[^>]*alt="([^"]*)"/);
    const dur = block.match(/<span[^>]*>\s*(\d{1,2}:\d{2}:\d{2})\s*<\/span>/);

    const title = alt ? decode(alt[1]) : strip(a[2]);
    out.push({
      vod_id: url,
      vod_name: title || a[2],
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: dur ? dur[1] : "",
    });
  }
  return out;
}

export default class MissAv extends Spider {
  init(extend) {
    this.log("missav ready");
  }

  // 统一请求：带上 WebView 里的 cookie（missav.live 有 CF 保护）
  async fetch(url, ref) {
    const h = headers(ref);
    let cookie = "";
    try {
      cookie = this.net.getCookie(BASE + "/") || "";
    } catch (e) {
      cookie = "";
    }
    if (cookie) h["Cookie"] = cookie;

    let r = null;
    try {
      r = await this.net.req(url, { headers: h });
    } catch (e) {
      r = null;
    }

    const body = (r && r.content) || "";
    const blocked =
      !r ||
      r.code !== 200 ||
      body.indexOf("Just a moment") >= 0 ||
      body.indexOf("_cf_chl_opt") >= 0 ||
      body.length < 2000;

    if (blocked) {
      throw new Error("被 Cloudflare 拦截：请先点「网页」完成验证，再回来刷新");
    }
    return r;
  }

  async homeContent(filter) {
    const classes = [];
    if (CATS.length) classes.push({ type_id: CATS[0][0], type_name: CATS[0][2] });
    // 网页放第二位（也是过 CF 验证的入口）
    classes.push({ type_id: "web", type_name: "网页" });
    for (let i = 1; i < CATS.length; i++) classes.push({ type_id: CATS[i][0], type_name: CATS[i][2] });
    classes.push({ type_id: "diag", type_name: "诊断" });
    return { class: classes };
  }

  async diagnose() {
    const lines = [];
    let cookie = "";
    try {
      cookie = this.net.getCookie(BASE + "/") || "";
      lines.push("cookie: " + cookie.length + " 字节, cf_clearance=" + (cookie.indexOf("cf_clearance") >= 0));
    } catch (e) {
      lines.push("getCookie 异常");
    }
    const ua = String(this.net.getUserAgent() || "");
    lines.push("UA: " + ua);

    const url = BASE + "/en/new";
    const browser = {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    };

    // A: 当前策略（UA + Referer + cookie）
    try {
      const h = headers();
      if (cookie) h["Cookie"] = cookie;
      const r = await this.net.req(url, { headers: h });
      const b = (r && r.content) || "";
      lines.push("A 默认: " + (r ? r.code : "null") + " len=" + b.length + " thumb=" + (b.indexOf("thumbnail group") >= 0));
    } catch (e) {
      lines.push("A 默认: 异常");
    }

    // B: 浏览器全套头 + cookie
    try {
      const h = Object.assign({}, browser);
      if (cookie) h["Cookie"] = cookie;
      const r = await this.net.req(url, { headers: h });
      const b = (r && r.content) || "";
      lines.push("B 浏览器头: " + (r ? r.code : "null") + " len=" + b.length + " thumb=" + (b.indexOf("thumbnail group") >= 0));
    } catch (e) {
      lines.push("B 浏览器头: 异常");
    }

    // C: cookie:true（交给宿主用 WebView cookie）
    try {
      const r = await this.net.req(url, { headers: browser, cookie: true });
      const b = (r && r.content) || "";
      lines.push("C cookie:true: " + (r ? r.code : "null") + " len=" + b.length + " thumb=" + (b.indexOf("thumbnail group") >= 0));
    } catch (e) {
      lines.push("C cookie:true: 异常");
    }

    // D: 不加 cookie
    try {
      const r = await this.net.req(url, { headers: browser });
      const b = (r && r.content) || "";
      lines.push("D 无cookie: " + (r ? r.code : "null") + " len=" + b.length);
    } catch (e) {
      lines.push("D 无cookie: 异常");
    }

    return lines.join("\n");
  }

  async categoryContent(tid, pg, filter, extend) {
    if (tid === "diag") {
      return this.page([{ vod_id: "diag", vod_name: "点我看诊断", vod_pic: "", vod_remarks: "" }], 1, 30, 30);
    }

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/en/new" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 30, 0);
    }

    let path = "";
    for (const c of CATS) {
      if (c[0] === tid) {
        path = c[1];
        break;
      }
    }
    if (!path) path = CATS[0][1];

    const p = Number(pg) || 1;
    const sep = path.indexOf("?") >= 0 ? "&" : "?";
    const url = BASE + path + sep + "page=" + p;

    const r = await this.fetch(url);
    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }

  async detailContent(ids) {
    if (ids.length && String(ids[0]).indexOf("diag") >= 0) {
      let text = "";
      try {
        text = await this.diagnose();
      } catch (e) {
        text = "诊断异常: " + e;
      }
      return {
        list: [{
          vod_id: "diag",
          vod_name: "诊断结果",
          vod_pic: "",
          vod_content: text,
          vod_play_from: "diag",
          vod_play_url: "无$diag",
        }],
      };
    }

    const list = [];
    for (const id of ids) {
      const pageUrl = String(id).indexOf("http") === 0 ? String(id) : BASE + "/en/" + id;
      let title = "";
      let pic = "";
      let content = "";
      let duration = "";

      try {
        const r = await this.fetch(pageUrl);
        if (r && r.code === 200) {
          const html = r.content;

          const ogt = html.match(/property="og:title"[^>]*content="([^"]+)"/);
          const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          title = ogt ? decode(ogt[1]) : h1 ? strip(h1[1]) : "";
          title = title.replace(/\s*[-|]\s*(MissAV|Watch.*)$/i, "").trim();

          const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
          pic = ogi ? decode(ogi[1]) : "";

          const d = html.match(/(\d{1,2}:\d{2}:\d{2})/);
          if (d) duration = d[1];

          const lines = [];
          if (duration) lines.push("时长: " + duration);

          const SKIP = { ranking: 1, all: 1, new: 1, popular: 1, genres: 1, actress: 1, actresses: 1 };

          const genres = [];
          const reG = /href="https:\/\/missav\.live\/en\/genres\/([^"\/]+)"/g;
          let m;
          while ((m = reG.exec(html)) !== null) {
            try {
              const g = decodeURIComponent(m[1]);
              if (!SKIP[g] && genres.indexOf(g) < 0) genres.push(g);
            } catch (e) {}
          }
          if (genres.length) lines.push("分类: " + genres.slice(0, 12).join(" / "));

          const acts = [];
          const reA = /href="https:\/\/missav\.live\/en\/actresses\/([^"\/]+)"/g;
          while ((m = reA.exec(html)) !== null) {
            try {
              const g = decodeURIComponent(m[1]);
              if (!SKIP[g] && acts.indexOf(g) < 0) acts.push(g);
            } catch (e) {}
          }
          if (acts.length) lines.push("演员: " + acts.slice(0, 8).join(" / "));

          content = lines.join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || String(id),
        vod_pic: pic,
        vod_content: content,
        vod_remarks: duration,
        vod_play_from: "missav",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const pageUrl = String(id).indexOf("http") === 0 ? String(id) : BASE + "/en/" + id;
    const r = await this.fetch(pageUrl);

    // uuid 出现在 surrit.com/<uuid>/seek/… 或 packed 脚本里
    const m = r.content.match(/surrit\.com\\?\/?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    if (!m) throw new Error("找不到播放 id");

    const uuid = m[1];
    return {
      parse: 0,
      url: "https://surrit.com/" + uuid + "/playlist.m3u8",
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/en/search/" + encodeURIComponent(key) + (p > 1 ? "?page=" + p : "");

    const r = await this.fetch(url);
    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }
}
