import { Spider, openWeb } from "catvod";

// Rule34-Videos（rule34-videos.com）—— 自研站，带 HLS 播放源
// ⚠ 注意：和已有的 Rule34Video（rule34video.com）不是同一个站
// 分类（用户拍板）：最新 | 最多查看 | 最受喜爱 | 标签 | 画师 | 搜索 | 网页
//   列表   /zh/?order_by=-date&page=N         32 条/页，共 2744 页（87792 个视频）
//   标签   /zh/tags/?page=N                    120 个/页，63 页
//   画师   /zh/artists/?page=N                 32 个/页，455 页
//   详情   /zh/video/<slug>-<id>/              播放地址 /media/videos/<id>/master.m3u8（HLS）
//   搜索   /zh/search/?q=
// ✅ 直连可用（无 Cloudflare）
// ⚠ 页面 HTML 是压缩过的，属性**没有引号**（href=/zh/video/xxx），正则不能写死引号

const BASE = "https://rule34-videos.com";
const LANG = "/zh";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PAGE_SIZE = 32;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + LANG + "/",
  };
}

function clean(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function abs(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

// 视频卡片：<div class="post-item card"><a href=/zh/video/<slug>/>
//   <img ... src=/media/videos/<id>/thumbs/thumb_1.webp>
//   <h2 class=card-title>标题</h2>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<div class="post-item card"/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 3000);
    const link = block.match(/href=(\/zh\/video\/[^ >]+)/);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;

    const tm = block.match(/class=card-title[^>]*>([\s\S]{0,200}?)<\/h2>/);
    let title = clean(tm ? tm[1] : "");
    if (!title) {
      const am = block.match(/<img[^>]+alt=("([^"]*)"|([^ >]+))/);
      if (am) title = clean(am[2] || am[3] || "");
    }
    if (!title) continue;
    seen[url] = 1;

    const thumb = block.match(/src=(\/media\/[^ >]+?\.(?:webp|jpe?g|png))/);
    const dur = block.match(/class=duration-badge[^>]*>([\d:]+)</);

    out.push({
      url: url,
      title: title,
      pic: thumb ? abs(thumb[1]) : "",
      dur: dur ? dur[1] : "",
    });
  }
  return out;
}

// 标签索引：<div class=tag-item><a class=tag-button href=/zh/tag/1boy/> 1boy <span class=post-count>(4775 帖子)</span>
function parseTags(html) {
  const out = [];
  const seen = {};
  const re = /<a class=tag-button href=(\/zh\/tag\/[^ >\/]+)\/>([\s\S]{0,80}?)<span class=post-count>\(([\d]+)/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const url = abs(m[1]);
    if (seen[url]) continue;
    seen[url] = 1;
    out.push({ url: url, name: clean(m[2]), count: Number(m[3]) });
  }
  return out;
}

// 画师索引：<a href=/zh/artist/x/> <img src=…> <h3 class=card-title>名字</h3><p class=post-count>12753 帖子
function parseArtists(html) {
  const out = [];
  const seen = {};
  const re = /<div class="artist-item card[^"]*"><a href=(\/zh\/artist\/[^ >\/]+)\/>([\s\S]{0,1200}?)<\/a>/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const url = abs(m[1]);
    if (seen[url]) continue;
    const block = m[2];
    const nm = block.match(/class=card-title[^>]*>([\s\S]{0,120}?)<\/h3>/);
    const img = block.match(/<img[^>]+src=("([^"]*)"|([^ >]+))/);
    const cnt = block.match(/class=post-count[^>]*>([\d]+)/);
    const name = clean(nm ? nm[1] : "");
    if (!name) continue;
    seen[url] = 1;
    out.push({
      url: url,
      name: name,
      pic: img ? abs(img[2] || img[3] || "") : "",
      count: cnt ? Number(cnt[1]) : 0,
    });
  }
  return out;
}

export default class Rule34Videos extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.log("rule34-videos ready");
  }

  cacheGet(url) {
    const c = this.htmlCache && this.htmlCache[url];
    return c && Date.now() - c.ts < 180000 ? c.html : "";
  }

  cacheSet(url, html) {
    this.htmlCache = this.htmlCache || {};
    this.htmlCache[url] = { html: html, ts: Date.now() };
  }

  async fetchPage(url) {
    const hit = this.cacheGet(url);
    if (hit) return hit;
    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return "";
    this.cacheSet(url, r.content);
    return r.content;
  }

  async homeContent(filter) {
    return {
      class: [
        { type_id: "date", type_name: "最新", type_flag: "0" },
        { type_id: "view", type_name: "最多查看", type_flag: "0" },
        { type_id: "likes", type_name: "最受喜爱", type_flag: "0" },
        { type_id: "tagf", type_name: "标签", type_flag: "1" },
        { type_id: "artf", type_name: "画师", type_flag: "1" },
        { type_id: "search", type_name: "搜索", type_flag: "1" },
        { type_id: "web", type_name: "网页", type_flag: "1" },
      ],
    };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.dur ? c.dur : "视频",
    }));
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    void filter;
    void extend;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + LANG + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }
    if (tid === "search") {
      try {
        openWeb({ url: BASE + LANG + "/search/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 标签索引（分页列表）
    if (tid === "tagf") {
      const html = await this.fetchPage(BASE + LANG + "/tags/?page=" + p);
      const tags = parseTags(html);
      const list = tags.map((t) => ({
        vod_id: "t:" + t.url,
        vod_name: t.name,
        vod_pic: "",
        vod_remarks: t.count ? t.count + " 帖" : "标签",
        vod_tag: "folder",
      }));
      return this.page(list, p, PAGE_SIZE, list.length >= 20 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + list.length);
    }

    // 画师索引（分页列表）
    if (tid === "artf") {
      const html = await this.fetchPage(BASE + LANG + "/artists/?page=" + p);
      const arts = parseArtists(html);
      const list = arts.map((a) => ({
        vod_id: "a:" + a.url,
        vod_name: a.name,
        vod_pic: a.pic,
        vod_remarks: a.count ? a.count + " 帖" : "画师",
        vod_tag: "folder",
      }));
      return this.page(list, p, PAGE_SIZE, list.length >= PAGE_SIZE ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + list.length);
    }

    // 标签 / 画师 的条目列表
    let url;
    if (tid.indexOf("t:") === 0) {
      url = tid.substring(2) + "?page=" + p;
    } else if (tid.indexOf("a:") === 0) {
      url = tid.substring(2) + "?page=" + p;
    } else {
      const ob = tid === "view" ? "-view" : tid === "likes" ? "-annotated_likes_count" : "-date";
      url = BASE + LANG + "/?order_by=" + ob + "&page=" + p;
    }

    const html = await this.fetchPage(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseCards(html);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const id = String(raw);
      const pageUrl = id.indexOf("http") === 0 ? id : BASE + id;
      let title = "";
      let pic = "";
      let content = "";
      let m3u8 = "";
      const html = await this.fetchPage(pageUrl);
      if (html) {
        const t = html.match(/<title>([^<]*)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*-\s*Rule34-Videos\.com\s*$/, "");
        const og = html.match(/property=og:image[^>]*content=("([^"]*)"|([^ >]+))/);
        if (og) pic = abs(og[2] || og[3] || "");
        // 播放地址在 <link rel=preload href=/media/videos/<id>/master.m3u8>
        const mm = html.match(/href=(\/media\/videos\/\d+\/master\.m3u8)/);
        if (mm) m3u8 = abs(mm[1]);
        const tags = [...new Set([...html.matchAll(/href=(\/zh\/tag\/[^ >\/]+)\//g)].map((m) => m[0]))].length;
        content = (m3u8 ? "HLS 播放源 ✓" : "无播放源") + (tags ? " · 标签 " + tags : "");
      }
      list.push({
        vod_id: pageUrl,
        vod_name: title || "Rule34-Videos",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "Rule34-Videos",
        vod_play_url: "正片$" + (m3u8 || pageUrl),
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const s = String(id);
    if (/\.m3u8(\?|$)/i.test(s)) {
      return { parse: 0, url: abs(s), header: { "User-Agent": UA, "Referer": BASE + LANG + "/" } };
    }
    const pageUrl = s.indexOf("http") === 0 ? s : BASE + s;
    const html = await this.fetchPage(pageUrl);
    const mm = html && html.match(/href=(\/media\/videos\/\d+\/master\.m3u8)/);
    if (!mm) throw new Error("没找到播放地址");
    return { parse: 0, url: abs(mm[1]), header: { "User-Agent": UA, "Referer": BASE + LANG + "/" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + LANG + "/search/?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);
    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
