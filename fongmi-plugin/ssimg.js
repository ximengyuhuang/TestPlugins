// 绅士俱乐部（ssimg.xyz）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯图集（Typecho + photograph 主题，无视频）
//   列表  /                        /?page=N                    18 条/页
//         /category/<slug>/        /category/<slug>/?page=N    （slug: cos / r15 / r18）
//   详情  /<分类>/<id>.html        原图在 <div class="post-item" data-src="…">
//   标签  /tag/<名字>/             详情页里有链接
//   搜索  /search/<关键字>/
//
// App 约定：
//   卡片角标 9P      → 纯图集，点卡片直接进图集
//   action("gal|")   → 返回 { list: [{url}] } 给原生瀑布流
//   vod_play_url     → web:// 兜底（详情页「查看图集」不会真的播放）

import { Spider, openWeb } from "catvod";

const BASE = "https://ssimg.xyz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 18;

const CATS = [
  ["latest", "最新", "/"],
  ["random", "随机", "/"],          // 站点只有「随机挑一篇」，见 categoryContent 里的特殊处理
  ["cos", "cos", "/category/cos/"],
  ["r15", "r15", "/category/r15/"],
  ["r18", "r18", "/category/r18/"],
];

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

function absolute(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 详情 id 可能是 v|<url>|0 / mix|<url> / t:<url>，统一还原成页面地址 */
function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|mix)\|/, "");
  if (u.indexOf("t:") === 0) u = u.substring(2);
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u && u.indexOf("http") !== 0) u = absolute(u);
  return u;
}

// 列表卡片：<div class="item col-…"> …data-original 封面 + item-link + item-link-text + [9P]
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split('<div class="item ');
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i].substring(0, 2000);
    const link = b.match(/class="item-link"\s+href="(https:\/\/ssimg\.xyz\/[a-z0-9\-]+\/\d+\.html)"/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const title = b.match(/item-link-text">([\s\S]{0,200}?)<\/div>/);
    const cover = b.match(/data-original="([^"]+)"/);
    const num = b.match(/\[(\d+)P\]/);

    out.push({
      vod_id: url,
      vod_name: clean(title ? title[1] : "") || "未命名",
      vod_pic: cover ? decode(cover[1]) : "",
      vod_remarks: num ? num[1] + "P" : "图集",
    });
  }
  return out;
}

// 详情原图：data-src 优先，data-original 兜底
function parseImages(html) {
  const out = [];
  const seen = {};
  const re = /class="post-item[^"]*"[^>]*data-(?:src|original)="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const u = decode(m[1]);
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

export default class Ssimg extends Spider {
  init() {}

  async homeContent() {
    return {
      // 纯图集站没有排序参数，所以不放 filters（App 的 ⇅ 会置灰）
      class: CATS.map(([id, name]) => ({ type_id: id, type_name: name }))
        .concat([{ type_id: "web", type_name: "网页" }]),
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

    // 随机：站点没有随机列表，只有「随机挑一篇」（首页导航里的 javascript 跳转）
    // 每次请求首页拿一个新的随机帖子 → 下拉刷新就换一个
    if (tid === "random") {
      let html = "";
      try {
        const r = await this.net.req(BASE + "/", { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) {
        html = "";
      }
      const m = html && html.match(/onclick="location\.href='([^']+)';"\s+title="随机文章"/);
      if (!m) return this.page([], 1, PAGE_SIZE, 0);

      const url = absolute(m[1]);
      // 随机帖不在首页列表里，抓一次详情拿标题/封面/张数
      let remarks = "随机";
      let pic = "";
      let title = "";
      try {
        const d = await this.net.req(url, { headers: hdrs(url) });
        if (d && d.code === 200) {
          title = pageTitle(d.content) || "";
          const imgs = parseImages(d.content);
          if (imgs.length) {
            remarks = imgs.length + "P";
            pic = imgs[0];
          }
        }
      } catch (e) {
      }

      const list = parseCards(html).filter((c) => c.vod_id === url);
      if (list.length) {
        list[0].vod_remarks = remarks;
        if (pic) list[0].vod_pic = pic;
        if (title) list[0].vod_name = title;
        return this.page(list, 1, PAGE_SIZE, 1);
      }
      return this.page([{
        vod_id: url,
        vod_name: title || "随机图集",
        vod_pic: pic,
        vod_remarks: remarks,
      }], 1, PAGE_SIZE, 1);
    }

    // 标签跳转：详情里的 t:<url>
    let path;
    if (String(tid).indexOf("t:") === 0) {
      path = String(tid).substring(2);
      if (path.indexOf("http") !== 0) path = absolute(path);
    } else {
      const hit = CATS.find((c) => c[0] === tid);
      path = hit ? BASE + hit[2] : BASE + "/";
    }

    const url = path + (p > 1 ? (path.indexOf("?") >= 0 ? "&" : "?") + "page=" + p : "");

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(path) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) {
      this.log("category failed: " + url);
      return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));
    }

    const cards = parseCards(html);
    // 站点不暴露总页数：满页就认为后面还有
    const total = cards.length < PAGE_SIZE
      ? (p - 1) * PAGE_SIZE + cards.length
      : p * PAGE_SIZE + PAGE_SIZE;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let title = "图集";
    let imgs = [];
    let date = "";
    let html = "";

    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }

    if (html) {
      title = pageTitle(html) || title;
      imgs = parseImages(html);
      const d = html.match(/日期[：:]\s*<\/span>\s*<span[^>]*>([^<]*)</);
      if (d) date = clean(d[1]);
    }

    // 标签：从详情页的 /tag/<名字>/ 链接转成可点 chip（id 用 t:<完整URL>）
    const tagLinks = [];
    if (html) {
      const re = /href="(https:\/\/ssimg\.xyz\/tag\/[^"]+)"/g;
      let m;
      const seen = {};
      while ((m = re.exec(html)) !== null) {
        const t = m[1];
        if (seen[t]) continue;
        seen[t] = 1;
        let name = "";
        try {
          name = clean(decodeURIComponent(t.replace(/^.*\/tag\//, "").replace(/\/$/, "")));
        } catch (e) {
          name = clean(t.replace(/^.*\/tag\//, ""));
        }
        if (name) tagLinks.push('[a=cr:{"id":"t:' + t + '"}/]' + name + "[/a]");
      }
    }

    const lines = [];
    if (date) lines.push("日期：" + date);
    lines.push("图片：" + imgs.length + " 张");
    if (tagLinks.length) lines.push(tagLinks.join(" · "));

    return {
      list: [{
        vod_id: url,
        vod_name: title,
        vod_pic: imgs.length ? imgs[0] : "",
        vod_content: lines.join("\n"),
        vod_remarks: imgs.length ? imgs.length + "P" : "图集",
        gallery: true,
        // 不真的播放：App 只据此显示「查看图集」
        vod_play_from: "绅士俱乐部",
        vod_play_url: "网页查看$web://" + url,
      }],
    };
  }

  /** 原生图集：App 调 action("gal|<页面URL>") */
  async action(op) {
    const s = String(op || "");

    if (s.indexOf("gal|") === 0) {
      const url = pageUrlOf(s.substring(4));
      if (!url) return { list: [] };
      try {
        const r = await this.net.req(url, { headers: hdrs(url) });
        if (r && r.code === 200) {
          const imgs = parseImages(r.content);
          if (imgs.length) return { list: imgs.map((u) => ({ url: u })) };
        }
      } catch (e) {
      }
      return { list: [] };
    }

    return [];
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/search/" + encodeURIComponent(key) + "/" + (p > 1 ? "?page=" + p : "");

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(BASE + "/search/") });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    return this.page(cards, p, PAGE_SIZE, cards.length);
  }

  async playerContent(flag, id) {
    // 图集站：统一转内置浏览器（真正看图走 gal|）
    const raw = String(id || "");
    if (raw.indexOf("web://") === 0) return { parse: 0, url: raw, header: {} };
    return { parse: 0, url: "web://" + pageUrlOf(raw), header: {} };
  }
}
