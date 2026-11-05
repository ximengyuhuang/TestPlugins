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

// ---- 分集相关 ----
// 去掉 [中文字幕] 这类方括号、第N話、前編/後編等，得到系列名
function seriesBase(t) {
  return stripTags(t)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/第\s*\d+\s*[話话集]/g, "")
    .replace(/(前編|後編|前篇|後篇|上巻|下巻|上卷|下卷)\s*$/g, "")
    .replace(/[\s\-–—|:：]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 集号：第N話/N集；前編=1 後編=2；上=1 下=3
function epNum(t) {
  const m = String(t).match(/第\s*(\d+)\s*[話话集]/);
  if (m) return Number(m[1]);
  if (/前編|前篇|上巻|上卷/.test(t)) return 1;
  if (/後編|後篇/.test(t)) return 2;
  if (/下巻|下卷/.test(t)) return 3;
  return 999;
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

  // 统一请求：手动带上 WebView 里的 cookie；被 CF 拦下时打开网页让人过验证
  async fetch(url, ref) {
    const h = this.hdr(ref);

    // 手动读取 WebView Cookie（cookie:true 在这版未必生效）
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
      // 不自动弹窗，交给「网页」分类手动触发
      throw new Error("被 Cloudflare 拦截：请先点左侧「网页」完成验证，再回来刷新");
    }
    return r;
  }

  // ---------------- 发现页 ----------------
  async homeContent(filter) {
    const classes = [];
    for (const s of SORTS) classes.push({ type_id: "sort:" + s, type_name: s });
    // 手动过验证入口，放第二位
    classes.splice(1, 0, { type_id: "web", type_name: "网页" });
    for (const g of GENRES) classes.push({ type_id: "genre:" + g, type_name: g });

    const filters = {};
    const sortOptions = SORTS.map((s) => ({ n: s, v: s }));
    for (const c of classes) filters[c.type_id] = [{ key: "sort", name: "排序", value: sortOptions }];

    // 进站不做任何探测，避免自动弹网页
    return { class: classes, filters: filters };
  }

  // ---------------- 诊断（保留，供排查用，不在界面露出） ----------------
  async diagnose() {
    const lines = [];
    lines.push("openWeb: " + typeof openWeb);

    let cookie = "";
    try {
      cookie = this.net.getCookie(BASE + "/") || "";
      lines.push("cookie 长度: " + cookie.length);
      lines.push("含 cf_clearance: " + (cookie.indexOf("cf_clearance") >= 0));
    } catch (e) {
      lines.push("getCookie 异常: " + String(e).substring(0, 60));
    }

    try {
      const h = this.hdr();
      if (cookie) h["Cookie"] = cookie;
      const r = await this.net.req(BASE + "/", { headers: h });
      const body = (r && r.content) || "";
      lines.push("请求: code=" + (r ? r.code : "null") + " 长度=" + body.length);
      lines.push("含 Just a moment: " + (body.indexOf("Just a moment") >= 0));
    } catch (e) {
      lines.push("请求异常: " + String(e).substring(0, 100));
    }

    return lines.join("\n");
  }

  // ---------------- CF 验证（自动闭合） ----------------
  // 卡片带 action 时，点击会调用这里；回传 web 指令打开网页，
  // 指定 cookie 出现变化后页面自动关闭并回到 App。
  async action(op, value) {
    const o = String(op === undefined || op === null ? "" : op);
    const target = BASE + "/";

    if (o.indexOf("cf") >= 0) {
      return { web: { url: target, cookie: [{ keys: ["cf_clearance"] }] } };
    }
    if (o.indexOf("web") >= 0) {
      return { web: { url: target } };
    }
    return { web: { url: target } };
  }

  // CF 被拦时返回一张可点击的卡片
  cfCard() {
    return this.page(
      [{
        vod_id: "cf-verify",
        vod_name: "⚠️ 被 Cloudflare 拦截，点我验证（通过后自动返回）",
        vod_pic: "",
        vod_remarks: "点我",
        action: "cf",
      }],
      1, 1, 1
    );
  }

  // ---------------- 列表 ----------------
  async categoryContent(tid, pg, filter, extend) {
    // 手动过验证：点「网页」才打开浏览器（保留，作为兜底入口）
    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 30, 0);
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

    let r;
    try {
      r = await this.fetch(url);
    } catch (e) {
      // 被 CF 拦截 → 给一张验证卡片（点击后打开网页，验证完自动关闭）
      return this.cfCard();
    }
    const cards = parseCards(r.content);

    // 站点每页约 30 个，有内容就允许继续翻
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }

  // ---------------- 详情 ----------------
  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = id.indexOf("http") === 0 ? id : BASE + "/watch?v=" + id;
      let title = "hanime1";
      let pic = "";
      let content = "";
      let playUrl = "正片$" + pageUrl;
      let quality = "";

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

        // 清晰度：<source ... size="1080">
        const sizes = [];
        const reS = /<source[^>]*size="(\d+)"/g;
        let ms;
        while ((ms = reS.exec(html)) !== null) sizes.push(Number(ms[1]));
        if (sizes.length) {
          quality = Math.max.apply(null, sizes) + "P";
          stats.push("清晰度: " + quality);
        }

        const line1 = stats.join(" | ");
        const desc = html.match(/property="og:description"[^>]*content="([^"]+)"/);
        const line2 = desc ? stripTags(desc[1]).substring(0, 140) : "";
        content = [line1, line2].filter(Boolean).join("\n");

        // 找同系列的其它集
        const base = seriesBase(title);
        if (base.length >= 4) {
          const eps = await this.findEpisodes(base);
          if (eps.length > 1) {
            const parts = [];
            for (let k = 0; k < eps.length; k++) {
              const n = epNum(eps[k].title);
              const label = n < 900 ? "第" + n + "集" : "第" + (k + 1) + "集";
              parts.push(label + "$" + BASE + "/watch?v=" + eps[k].id);
            }
            playUrl = parts.join("#");
            content = ["共 " + eps.length + " 集", content].filter(Boolean).join("\n");
          }
        }
      } catch (e) {
        this.log("detail failed: " + e);
        title = "需要验证后重试";
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title,
        vod_pic: pic,
        vod_content: content,
        vod_remarks: quality,
        vod_play_from: "hanime1",
        vod_play_url: playUrl,
      });
    }
    return { list: list };
  }

  // ---------------- 分集发现 ----------------
  // 用系列名去站点搜索，把同系列的几集找出来
  async findEpisodes(base) {
    if (!base || base.length < 4) return [];
    if (this.epCache && this.epCache[base]) return this.epCache[base];

    const rows = [];
    try {
      const r = await this.fetch(BASE + "/search?query=" + encodeURIComponent(base));
      const chunks = r.content.split('<div title="');
      for (let i = 1; i < chunks.length; i++) {
        const c = chunks[i];
        const tm = c.match(/^([^"]*)"/);
        const head = c.substring(0, 1800);
        const vm = head.match(/watch\?v=(\d+)/);
        if (!vm) continue; // 广告块没有 vid
        const t = decode(tm ? tm[1] : "");
        if (!t) continue;
        const dm = head.match(/class="duration">\s*([^<]*)</);
        const b = seriesBase(t);
        if (!b) continue;
        rows.push({ title: t, id: vm[1], dur: dm ? dm[1].trim() : "", base: b });
      }
    } catch (e) {
      this.log("episode search failed: " + e);
      return [];
    }

    // 按系列名分组，挑出与当前系列最匹配、且至少 2 集的一组
    const groups = {};
    for (const r of rows) {
      if (!groups[r.base]) groups[r.base] = [];
      groups[r.base].push(r);
    }

    let best = null;
    let bestScore = -1;
    for (const k in groups) {
      const g = groups[k];
      if (g.length < 2) continue;
      let score = g.length;
      if (k === base || base.indexOf(k) >= 0 || k.indexOf(base) >= 0) score += 100;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }

    this.epCache = this.epCache || {};
    if (!best) {
      this.epCache[base] = [];
      return [];
    }

    const seen = {};
    const uniq = [];
    for (const e of best) {
      if (seen[e.id]) continue;
      seen[e.id] = 1;
      uniq.push(e);
    }
    uniq.sort((a, b) => epNum(a.title) - epNum(b.title));

    this.epCache[base] = uniq;
    return uniq;
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

    if (found.length === 0) throw new Error("没有找到 mp4 源（可能是 Cloudflare 验证过期，点「网页」重新验证）");

    found.sort((a, b) => b.size - a.size);

    const values = [];
    const seenUrl = {};
    for (const f of found) {
      if (seenUrl[f.url]) continue;
      seenUrl[f.url] = 1;
      values.push({ n: f.size + "P", v: f.url });
    }

    return {
      parse: 0,
      url: values.length > 1 ? { values: values, position: 0 } : values[0].v,
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
