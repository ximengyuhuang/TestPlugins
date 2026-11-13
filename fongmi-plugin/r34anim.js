// R34Anim —— FongMi / TVBox QuickJS 源
// 站点：r34anim.com（Rule 34 Animated，WordPress + hu 主题，3D 动画视频）
//
// 侦察结论（2026-11-13）：
//   列表    /page/N/                        每页 12 条，共 871 页 / 2,613 个视频
//   分类    /rule34/<slug>/                 34 个（REST: /wp-json/wp/v2/categories）
//   标签    /rule34-tag/<slug>/             389 个（REST: /wp-json/wp/v2/tags，4 页）
//   搜索    /?s=关键词
//   取流    帖子页直接是 <video><source src="…mp4">，站内 wp-content 托管（明文，最省事）
//
// 分类（用户拍板）：最新 | 34 个分类全平铺 | 标签（首字母分组）| 搜索 | 网页
// 说明：本机代理能访问，但手机代理连不上这个域名（TLS 卡住），真机验证需先解决线路。

import { Spider, openWeb } from "catvod";

const BASE = "https://www.r34anim.com";
const UA =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PAGE_SIZE = 12;

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": ref || BASE + "/",
  };
}

function clean(s) {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// 列表卡片：<article id="post-N" class="... category-x tag-y ...">
//   <a href="https://www.r34anim.com/<slug>/" title="标题"> <img src="封面.webp">
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split('<article id="post-');
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].slice(0, 3000);

    let url = "";
    let title = "";
    const a1 = seg.match(/<a href="(https:\/\/www\.r34anim\.com\/[^"]+)"[^>]*title="([^"]*)"/);
    const a2 = seg.match(/<a href="(https:\/\/www\.r34anim\.com\/[^"]+)"[^>]*>/);
    if (a1) {
      url = a1[1];
      title = a1[2];
    } else if (a2) {
      url = a2[1];
    }
    if (!url) continue;
    // 排除分类/标签/分页链接
    if (/\/rule34\/|\/rule34-tag\/|\/page\/|\/all-tags\/|\?s=/.test(url)) continue;
    if (seen[url]) continue;
    seen[url] = 1;

    let pic = "";
    const im = seg.match(/<img[^>]+src="([^"]+)"/);
    if (im) pic = im[1];

    if (!title) {
      const alt = seg.match(/<img[^>]+alt="([^"]{3,120})"/);
      if (alt) title = alt[1];
    }
    title = clean(title);
    if (!title) title = decodeURIComponent(url.replace(BASE, "").split("/").filter(Boolean).pop() || "视频");

    out.push({ url: url, title: title, pic: pic });
  }
  return out;
}

// 详情页取 mp4（<source src> 或 <video src> 或全页正则）
function parseMp4(html) {
  const t = String(html);
  const m =
    t.match(/<source[^>]+src="([^"]+\.mp4[^"]*)"/) ||
    t.match(/<video[^>]+src="([^"]+\.mp4[^"]*)"/) ||
    t.match(/(https:\/\/[^"'\s<>]+\.mp4)(?:\?[^"'\s<>]*)?/);
  if (!m) return "";
  return String(m[1]).replace(/\?_=\d+$/, "");
}

export default class R34Anim extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.catCache = null;
    this.tagCache = null;
    this.log("r34anim ready");
  }

  cacheGet(u) {
    const c = this.htmlCache && this.htmlCache[u];
    return c && Date.now() - c.ts < 180000 ? c.html : "";
  }

  cacheSet(u, h) {
    this.htmlCache = this.htmlCache || {};
    this.htmlCache[u] = { html: h, ts: Date.now() };
  }

  async fetchPage(url) {
    const hit = this.cacheGet(url);
    if (hit) return hit;
    try {
      const r = await this.net.req(url, { headers: headers() });
      if (!r || r.code !== 200) return "";
      this.cacheSet(url, r.content);
      return r.content;
    } catch (e) {
      this.log("fetch failed: " + e);
      return "";
    }
  }

  async restJSON(path) {
    try {
      const r = await this.net.req(BASE + path, { headers: headers() });
      if (!r || r.code !== 200 || !r.content) return null;
      return JSON.parse(r.content);
    } catch (e) {
      return null;
    }
  }

  // 分类：REST 一次拿全（34 个）
  async loadCats() {
    if (this.catCache) return this.catCache;
    const arr = await this.restJSON("/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=name,slug,count");
    const list = [];
    if (Array.isArray(arr)) {
      for (const c of arr) {
        const name = clean(c.name);
        if (!name || !c.slug) continue;
        list.push({ name: name, slug: c.slug, count: c.count || 0 });
      }
    }
    // 兜底：REST 挂了用硬编码
    if (list.length === 0) {
      const hard = "batman bioshock borderlands cyberpunk-2077 dead-or-alive dragon-age elden-ring farcry final-fantasy fortnite-rule-34 league-of-legends left-4-dead legend-of-zelda life-is-strange lollipop-chainsaw mass-effect metal-gear metroid mortal-kombat nier-automata overwatch resident-evil soulcalibur street-fighter tekken the-witcher tomb-raider unsorted-videos world-of-warcraft";
      for (const s of hard.split(" ")) {
        list.push({ name: s.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()), slug: s, count: 0 });
      }
    }
    this.catCache = list;
    this.log("cats: " + list.length);
    return list;
  }

  // 标签：REST 4 页拿全（389 个）
  async loadTags() {
    if (this.tagCache) return this.tagCache;
    const all = [];
    for (let p = 1; p <= 6; p++) {
      const arr = await this.restJSON(
        "/wp-json/wp/v2/tags?per_page=100&page=" + p + "&orderby=name&order=asc&_fields=name,slug,count"
      );
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const t of arr) {
        const name = clean(t.name);
        if (!name || !t.slug) continue;
        all.push({ name: name, slug: t.slug, count: t.count || 0 });
      }
      if (arr.length < 100) break;
    }
    this.tagCache = all;
    this.log("tags: " + all.length);
    return all;
  }

  groupLetters(tags) {
    const map = {};
    for (const t of tags) {
      const ch = String(t.name).replace(/^[\s\u00a0]+/, "").charAt(0).toUpperCase();
      const key = /[A-Z]/.test(ch) ? ch : /[0-9]/.test(ch) ? "#" : "其他";
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    const order = Object.keys(map).sort((a, b) => {
      if (a === "其他") return 1;
      if (b === "其他") return -1;
      if (a === "#") return 1;
      if (b === "#") return -1;
      return a.localeCompare(b);
    });
    return order.map((k) => ({ key: k, items: map[k] }));
  }

  async homeContent(filter) {
    const classes = [{ type_id: "latest", type_name: "最新", type_flag: "0" }];
    const cats = await this.loadCats();
    for (const c of cats) {
      classes.push({ type_id: "c:" + c.slug, type_name: c.name, type_flag: "0" });
    }
    classes.push({ type_id: "tagf", type_name: "标签", type_flag: "1" });
    classes.push({ type_id: "search", type_name: "搜索", type_flag: "1" });
    classes.push({ type_id: "web", type_name: "网页", type_flag: "1" });

    // 排序收进「筛选」（WordPress 的 ?order= / ?orderby=，实测有效）
    const sortF = [
      {
        key: "sort",
        name: "排序",
        value: [
          { n: "最新", v: "date" },
          { n: "最早", v: "asc" },
          { n: "随机", v: "rand" },
        ],
      },
    ];
    const filters = {};
    for (const c of classes) {
      if (c.type_id === "web" || c.type_id === "search") continue;
      filters[c.type_id] = sortF;
    }
    return { class: classes, filters: filters };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: "动画",
    }));
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    void filter;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }
    if (tid === "search") {
      try {
        openWeb({ url: BASE + "/?s=" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 标签：字母层 → 标签 → 视频
    if (tid === "tagf") {
      const tags = await this.loadTags();
      const list = this.groupLetters(tags).map((g) => ({
        vod_id: "seg:" + g.key,
        vod_name: g.key,
        vod_pic: "",
        vod_remarks: g.items.length + " 个",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }
    if (tid.indexOf("seg:") === 0) {
      const key = tid.substring(4);
      const tags = await this.loadTags();
      const g = this.groupLetters(tags).find((x) => x.key === key);
      const list = (g ? g.items : []).map((t) => ({
        vod_id: "t:" + t.slug,
        vod_name: t.name,
        vod_pic: "",
        vod_remarks: t.count ? t.count + " 个" : "标签",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    const sel = (extend && extend.sort) || "date";
    let q = "";
    if (sel === "asc") q = "?order=asc";
    else if (sel === "rand") q = "?orderby=rand";

    let url = "";
    if (tid.indexOf("t:") === 0) {
      url = BASE + "/rule34-tag/" + tid.substring(2) + "/" + (p > 1 ? "page/" + p + "/" : "") + q;
    } else if (tid.indexOf("c:") === 0) {
      url = BASE + "/rule34/" + tid.substring(2) + "/" + (p > 1 ? "page/" + p + "/" : "") + q;
    } else {
      url = BASE + "/" + (p > 1 ? "page/" + p + "/" : "") + q;
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
      const html = await this.fetchPage(pageUrl);

      let title = "";
      let pic = "";
      let mp4 = "";
      if (html) {
        const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
        if (h1) title = clean(h1[1]);
        if (!title) {
          const t = html.match(/<title>([^<]*)<\/title>/);
          if (t) title = clean(t[1]);
        }
        const og =
          html.match(/property="og:image"\s+content="([^"]+)"/) ||
          html.match(/content="([^"]+)"\s+property="og:image"/);
        if (og) pic = og[1];
        mp4 = parseMp4(html);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || "R34Anim",
        vod_pic: pic,
        vod_content: mp4 ? "mp4 直链" : "未找到视频地址",
        vod_play_from: "R34Anim",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    void flag;
    void vipFlags;
    const pageUrl = String(id);
    let mp4 = pageUrl.indexOf(".mp4") > 0 ? pageUrl : "";
    if (!mp4) {
      const html = await this.fetchPage(pageUrl);
      mp4 = html ? parseMp4(html) : "";
    }
    if (!mp4) return { parse: 0, url: "", msg: "没找到视频地址" };
    return {
      parse: 0,
      url: mp4,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async searchContent(key, quick, pg = "1") {
    void quick;
    const p = Number(pg) || 1;
    const url = BASE + "/" + (p > 1 ? "page/" + p + "/" : "") + "?s=" + encodeURIComponent(key);
    const html = await this.fetchPage(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseCards(html);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
