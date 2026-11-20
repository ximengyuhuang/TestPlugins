// 绅士俱乐部（ssimg.xyz）—— BiliTV / catvod QuickJS 插件
//
// Typecho 1.2 + photograph 主题，纯图集站：
//   列表  /                        /?page=N
//         /category/<slug>/        /category/<slug>/?page=N   （slug: cos / r15 / r18）
//   详情  /<分类>/<id>.html        图集原图在 <div class="post-item" data-src="原图">
//   搜索  /search/<关键字>/
// 图集走 App 的 action("gal|<url>")，返回 {list:[{url}]}

import { Spider, openWeb } from "catvod";

const BASE = "https://ssimg.xyz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 18;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function clean(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// 列表卡片：<div class="item ..."> …data-original 封面 + item-link + item-link-text 标题 + [NP]
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<div class="item\s/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 2000);
    const link = block.match(/class="item-link"\s+href="(https:\/\/ssimg\.xyz\/[a-z0-9\-]+\/\d+\.html)"/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const title = block.match(/item-link-text">([\s\S]{0,200}?)<\/div>/);
    const cover = block.match(/data-original="([^"]+)"/);
    const num = block.match(/\[(\d+)P\]/);

    out.push({
      url: url,
      title: clean(title ? title[1] : "") || "未命名",
      pic: cover ? cover[1] : "",
      count: num ? Number(num[1]) : 0,
    });
  }
  return out;
}

// 详情页原图：data-src 优先，data-original 兜底
function parseImages(html) {
  const out = [];
  const seen = {};
  const re = /class="post-item[^"]*"[^>]*data-(?:src|original)="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const u = m[1];
    if (!u || seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

function pageTitle(html) {
  const m = String(html).match(/<title>([^<]*)<\/title>/);
  return m ? clean(m[1]).replace(/\s*-\s*绅士俱乐部\s*$/, "") : "";
}

function toCard(c) {
  return {
    vod_id: c.url,
    vod_name: c.title,
    vod_pic: c.pic,
    vod_remarks: c.count ? c.count + "P" : "图集",
  };
}

export default class Ssimg extends Spider {
  init() {}

  async homeContent() {
    return {
      class: [
        { type_id: "latest", type_name: "最新" },
        { type_id: "cos", type_name: "cos" },
        { type_id: "r15", type_name: "r15" },
        { type_id: "r18", type_name: "r18" },
        { type_id: "web", type_name: "网页" },
      ],
    };
  }

  async categoryContent(tid, pg) {
    const p = Number(pg) || 1;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
      }
      return this.page([], p, PAGE_SIZE, 0);
    }

    let url;
    if (!tid || tid === "latest") {
      url = BASE + "/" + (p > 1 ? "?page=" + p : "");
    } else {
      url = BASE + "/category/" + tid + "/" + (p > 1 ? "?page=" + p : "");
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
    const list = cards.map(toCard);
    // 站点没有总页数：满页就认为后面还有
    const total = cards.length < PAGE_SIZE ? (p - 1) * PAGE_SIZE + cards.length : p * PAGE_SIZE + PAGE_SIZE;
    return this.page(list, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = String(ids[0] || "");
    let title = "图集";
    let pic = "";
    let content = "";
    let count = 0;

    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) {
        const html = r.content;
        title = pageTitle(html) || title;
        const imgs = parseImages(html);
        count = imgs.length;
        pic = imgs.length ? imgs[0] : "";
        const date = html.match(/日期：<\/span>\s*<span[^>]*>([^<]*)</);
        const lines = [];
        if (date) lines.push("日期：" + clean(date[1]));
        lines.push("图片：" + count + " 张");
        content = lines.join("\n");
      }
    } catch (e) {
    }

    return {
      list: [{
        vod_id: url,
        vod_name: title,
        vod_pic: pic,
        vod_content: content,
        vod_remarks: count ? count + "P" : "图集",
        gallery: true,
        vod_play_from: "绅士俱乐部",
        vod_play_url: "网页查看$web://" + url,
      }],
    };
  }

  // 图集：App 用 action("gal|<url>") 拉全部原图
  async action(op) {
    const s = String(op || "");
    if (s.indexOf("gal|") !== 0) return [];
    const url = s.substring(4);

    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) {
        const imgs = parseImages(r.content);
        if (imgs.length) return { list: imgs.map((u) => ({ url: u })) };
      }
    } catch (e) {
    }
    return { list: [] };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/search/" + encodeURIComponent(key) + "/" + (p > 1 ? "?page=" + p : "");
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    return this.page(cards.map(toCard), p, PAGE_SIZE, cards.length);
  }

  async playerContent(flag, id) {
    const raw = String(id || "");
    if (raw.indexOf("web://") === 0) return { parse: 0, url: raw, header: "{}" };
    return { parse: 0, url: "web://" + raw, header: "{}" };
  }
}
