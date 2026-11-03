// hanime1.me —— FongMi / TVBox QuickJS 源
// 站点：Cloudflare 托管挑战。首次使用需在 App 内 WebView 手动过一次人机验证，
//       之后用 WebView 里的 cookie（cookie:true）复用。

import { Spider, openWeb } from "catvod";

const BASE = "https://hanime1.me";

const SORTS = ["最新上市", "最新上傳", "他們在看", "本日排行"];
const GENRES = [
  "裏番", "泡麵番", "Motion Anime", "3DCG", "2.5D",
  "2D動畫", "AI生成", "MMD", "Cosplay", "新番預告",
];

function decode(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(s) {
  return decode((s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// 从列表页解析卡片
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/(?=<div title="[^"]*" class="video-item-container">)/);
  for (const p of parts) {
    if (!/^<div title="[^"]*" class="video-item-container">/.test(p)) continue;
    const block = p.substring(0, 3000);

    const a = block.match(/href="(https:\/\/hanime1\.me\/watch\?v=\d+)" class="video-link"/);
    if (!a) continue;
    const url = a[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const t = block.match(/<div title="([^"]*)" class="video-item-container">/);
    let title = t ? decode(t[1]).trim() : "";
    if (!title) {
      const t2 = block.match(/<div class="title">([\s\S]*?)<\/div>/);
      if (t2) title = stripTags(t2[1]);
    }

    const img = block.match(/<img class="main-thumb" src="([^"]+)"/);
    const pic = img ? decode(img[1]) : "";

    const dur = block.match(/<div class="duration">\s*([^<]*?)\s*<\/div>/);
    const remark = dur ? dur[1].trim() : "";

    out.push({ vod_id: url, vod_name: title, vod_pic: pic, vod_remarks: remark });
  }
  return out;
}

export default class Hanime1 extends Spider {
  init(extend) {
    this.log("hanime1 ready");
  }

  ua() {
    const ua = this.net.getUserAgent();
    return ua || "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
  }

  hdr(ref) {
    return {
      "User-Agent": this.ua(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "Referer": ref || BASE + "/",
    };
  }

  // 统一请求：带 WebView cookie；被 CF 拦下时打开网页让人过验证
  async fetch(url, ref) {
    let r = null;
    try {
      r = await this.net.req(url, { headers: this.hdr(ref), cookie: true });
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
      openWeb(JSON.stringify({ url: BASE + "/" }));
      throw new Error("需要 Cloudflare 验证：请在打开的页面完成人机验证，然后返回重试");
    }
    return r;
  }

  // ---------------- 发现页 ----------------
  async homeContent(filter) {
    const classes = [];
    for (const s of SORTS) classes.push({ type_id: "sort:" + s, type_name: s });
    for (const g of GENRES) classes.push({ type_id: "genre:" + g, type_name: g });
    classes.push({ type_id: "debug", type_name: "🔍 诊断" });

    const filters = {};
    const sortOptions = SORTS.map((s) => ({ n: s, v: s }));
    for (const c of classes) filters[c.type_id] = [{ key: "sort", name: "排序", value: sortOptions }];

    // 顺便探一次：被拦会直接弹出验证页
    try {
      await this.fetch(BASE + "/");
    } catch (e) {
      this.log("home blocked: " + e);
    }

    return { class: classes, filters: filters };
  }

  // ---------------- 诊断 ----------------
  async diagnose() {
    const lines = [];
    lines.push("openWeb: " + typeof openWeb);
    try {
      lines.push("getUserAgent: " + typeof this.net.getUserAgent + " → " + String(this.net.getUserAgent()).substring(0, 40));
    } catch (e) {
      lines.push("getUserAgent 异常: " + e);
    }

    try {
      const r = await this.net.req(BASE + "/", { headers: this.hdr(), cookie: true });
      const body = (r && r.content) || "";
      lines.push("请求: code=" + (r ? r.code : "null") + " 长度=" + body.length);
      lines.push("含 Just a moment: " + (body.indexOf("Just a moment") >= 0));
      lines.push("含 _cf_chl_opt: " + (body.indexOf("_cf_chl_opt") >= 0));
      lines.push("含 video-item: " + (body.indexOf("video-item-container") >= 0));
      lines.push("片段: " + body.substring(0, 60).replace(/\s+/g, " "));
    } catch (e) {
      lines.push("请求异常: " + String(e).substring(0, 120));
    }

    return lines.join("\n");
  }

  // ---------------- 列表 ----------------
  async categoryContent(tid, pg, filter, extend) {
    if (tid === "debug") {
      return this.page([{ vod_id: "debug", vod_name: "点我看诊断", vod_pic: "", vod_remarks: "" }], 1, 30, 30);
    }

    const p = Number(pg) || 1;
    const sort = (extend && extend.sort) || "最新上傳";

    let url;
    if (tid.indexOf("genre:") === 0) {
      url = BASE + "/search?genre=" + encodeURIComponent(tid.substring(6)) + "&sort=" + encodeURIComponent(sort) + "&page=" + p;
    } else if (tid.indexOf("sort:") === 0) {
      url = BASE + "/search?sort=" + encodeURIComponent(tid.substring(5)) + "&page=" + p;
    } else {
      url = BASE + "/search?sort=" + encodeURIComponent(sort) + "&page=" + p;
    }

    const r = await this.fetch(url);
    const cards = parseCards(r.content);

    // 站点每页约 30 个，有内容就允许继续翻
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }

  // ---------------- 详情 ----------------
  async detailContent(ids) {
    if (ids.length && String(ids[0]).indexOf("debug") >= 0) {
      let text = "";
      try {
        text = await this.diagnose();
      } catch (e) {
        text = "诊断异常: " + e;
      }
      return {
        list: [{
          vod_id: "debug",
          vod_name: "诊断结果",
          vod_pic: "",
          vod_content: text,
          vod_play_from: "debug",
          vod_play_url: "无$debug",
        }],
      };
    }

    const list = [];
    for (const id of ids) {
      const pageUrl = id.indexOf("http") === 0 ? id : BASE + "/watch?v=" + id;
      let title = "hanime1";
      let pic = "";
      let content = "";

      try {
        const r = await this.fetch(pageUrl);
        const html = r.content;

        const ogt = html.match(/property="og:title"[^>]*content="([^"]+)"/);
        if (ogt) title = stripTags(ogt[1]).replace(/\s*-\s*Hanime1\.me$/i, "").replace(/\s*-\s*H動漫.*$/, "");

        const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
        if (ogi) pic = decode(ogi[1]);

        const stats = [];

        // 分类（genre）
        const gs = [];
        const reG = /href="https:\/\/hanime1\.me\/search\?genre=([^"&]+)"/g;
        let m;
        while ((m = reG.exec(html)) !== null) {
          const g = decodeURIComponent(m[1]);
          if (gs.indexOf(g) < 0) gs.push(g);
        }
        if (gs.length) stats.push("分类: " + gs.join(" / "));

        // 上架时间
        const date = html.match(/(\d{4}-\d{2}-\d{2})/);
        if (date) stats.push("上架: " + date[1]);

        // 时长：从播放页的 meta 或时长文本
        const dur = html.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (dur) stats.push("时长: " + dur[1]);

        const line1 = stats.join(" | ");
        const desc = html.match(/property="og:description"[^>]*content="([^"]+)"/);
        const line2 = desc ? stripTags(desc[1]).substring(0, 140) : "";
        content = [line1, line2].filter(Boolean).join("\n");
      } catch (e) {
        this.log("detail failed: " + e);
        title = "需要验证后重试";
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title,
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "hanime1",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  // ---------------- 播放 ----------------
  async playerContent(flag, id, vipFlags) {
    const pageUrl = id.indexOf("http") === 0 ? id : BASE + "/watch?v=" + id;
    const r = await this.fetch(pageUrl);

    // <source src="..." type="video/mp4" size="720">
    const found = [];
    const re = /<source[^>]*src="([^"]+)"[^>]*type="video\/mp4"[^>]*size="(\d+)"/g;
    let m;
    while ((m = re.exec(r.content)) !== null) {
      const u = decode(m[1]);
      if (u.indexOf("http") !== 0) continue;
      found.push({ url: u, size: Number(m[2]) });
    }

    if (found.length === 0) throw new Error("没有找到 mp4 源（可能需要先过验证）");

    found.sort((a, b) => b.size - a.size);
    return {
      parse: 0,
      url: found[0].url,
      header: { "User-Agent": this.ua(), "Referer": BASE + "/" },
    };
  }

  // ---------------- 搜索 ----------------
  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search?query=" + encodeURIComponent(key) + "&page=" + p;

    const r = await this.fetch(url);
    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }
}
