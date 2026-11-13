// NSFWR34 —— FongMi / TVBox QuickJS 源
// 站点：nsfwr34.com（WordPress + StreamTube，社区上传的 rule34 视频站）
//
// 侦察结论（2026-11-13，用手机 curl 实测）：
//   列表    /video/ → /video/page/N/          20 条/页，共 5094 帖
//   分类    /categories/<slug>/               只有 4 个（2d-rule-34 / 3d-porn / 4k / vertical-videos）
//   标签    /video_tag/<slug>/                2654 个（REST 可一次拿全）
//   搜索    /page/N/?s=关键词                   实测有效
//   取流    <video-js data-settings="{...}"> 里是明文 m3u8（Bunny CDN）
//           形如 https://vz-xxx.b-cdn.net/<uuid>/playlist.m3u8
//
// 分类（用户拍板）：最新 | 2D | 3D | 4K | 竖屏 | 标签（首字母分组）| 搜索 | 网页
// 筛选：分类 + 排序（最新 / 最早 / 随机，用 WordPress 的 ?order= / ?orderby=）

import { Spider, openWeb } from "catvod";

const BASE = "https://nsfwr34.com";
const UA =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PAGE_SIZE = 20;

// [type_id, 路径, 名称]
const CATS = [
  ["c2d", "/categories/2d-rule-34/", "2D"],
  ["c3d", "/categories/3d-porn/", "3D"],
  ["c4k", "/categories/4k/", "4K"],
  ["cvert", "/categories/vertical-videos/", "竖屏"],
];

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": ref || BASE + "/",
  };
}

// HTML 实体 + JSON 转义还原
function unesc(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function strip(s) {
  return unesc(String(s).replace(/<[^>]+>/g, " "));
}

// 列表卡片：<article class="post-xxx video ...">
//   class="post-permalink" title="..." href="..."
//   data-thumbnail-image-2="封面"
//   class="video-length badge">01:36
function parseCards(html) {
  const out = [];
  const seen = {};
  const src = String(html);
  const parts = src.split("<article ");
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].slice(0, 4000);

    let title = "";
    let url = "";
    const a1 = seg.match(/class="post-permalink"[^>]*title="([^"]*)"[^>]*href="([^"]+)"/);
    const a2 = seg.match(/class="post-permalink"[^>]*href="([^"]+)"[^>]*title="([^"]*)"/);
    if (a1) {
      title = a1[1];
      url = a1[2];
    } else if (a2) {
      url = a2[1];
      title = a2[2];
    } else {
      const h = seg.match(/class="post-permalink"[^>]*href="([^"]+)"/);
      if (h) url = h[1];
    }
    if (!url || seen[url]) continue;
    seen[url] = 1;

    if (!title) {
      const t = seg.match(/<img[^>]+alt="([^"]{3,120})"/);
      if (t) title = t[1];
    }
    title = strip(title);
    if (!title) title = decodeURIComponent(url.split("/").filter(Boolean).pop() || "视频");

    // 封面：优先用站内 wp-content 的 jpg（约 28KB）
    // ⚠ data-thumbnail-image-2 指向 Bunny CDN 的 preview.webp，单张 1.3MB，
    //   App 里加载不出来会显示字母占位（实测踩过）
    let pic = "";
    const pool = [seg.match(/<img[^>]+src="([^"]+)"/)];
    const all = [...seg.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    let siteImg = "";
    for (const u of all) {
      if (u.indexOf("wp-content/uploads") >= 0) {
        siteImg = u;
        break;
      }
    }
    if (siteImg) pic = unesc(siteImg);
    if (!pic) {
      const alt = seg.match(/data-thumbnail-image-2="([^"]+)"/) || seg.match(/data-thumbnail-image="([^"]+)"/);
      if (alt) pic = unesc(alt[1]);
    }
    if (!pic && pool[0]) pic = unesc(pool[0][1]);

    let dur = "";
    const dm = seg.match(/class="video-length[^"]*"[^>]*>([^<]*)</);
    if (dm) dur = strip(dm[1]);

    out.push({ url: url, title: title, pic: pic, dur: dur });
  }
  return out;
}

// 播放页：data-settings 里的 m3u8
function parseStream(html) {
  const src = String(html);
  const m = src.match(/data-settings="([\s\S]*?)"/);
  if (m) {
    const s = unesc(m[1]);
    const sm = s.match(/"src"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
    if (sm) return sm[1];
    const sm2 = s.match(/"src"\s*:\s*"([^"]+\.mp4[^"]*)"/);
    if (sm2) return sm2[1];
  }
  const g = src.match(/https:\\?\/\\?\/[^"'\s<>]+?\.m3u8/);
  if (g) return unesc(g[0]);
  return "";
}

export default class Nsfwr34 extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.tagCache = null;
    this.log("nsfwr34 ready");
  }

  cacheGet(u) {
    const c = this.htmlCache && this.htmlCache[u];
    return c && Date.now() - c.ts < 120000 ? c.html : "";
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

  // 标签：REST 一次拿全（2654 个，27 页 × 100）
  async loadTags() {
    if (this.tagCache) return this.tagCache;
    const all = [];
    for (let p = 1; p <= 30; p++) {
      const url =
        BASE +
        "/wp-json/wp/v2/video_tag?per_page=100&page=" +
        p +
        "&orderby=name&order=asc&_fields=name,slug,count";
      let r = null;
      try {
        r = await this.net.req(url, { headers: headers() });
      } catch (e) {
        break;
      }
      if (!r || r.code !== 200 || !r.content) break;
      let arr = null;
      try {
        arr = JSON.parse(r.content);
      } catch (e) {
        break;
      }
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const t of arr) {
        const name = strip(t.name);
        if (!name) continue;
        all.push({ name: name, slug: t.slug, count: t.count || 0 });
      }
      if (arr.length < 100) break;
    }
    all.sort((a, b) => a.name.localeCompare(b.name));
    this.tagCache = all;
    this.log("tags loaded: " + all.length);
    return all;
  }

  groupLetters(tags) {
    const map = {};
    for (const t of tags) {
      const ch = String(t.name)
        .replace(/^[\s\u00a0]+/, "")
        .charAt(0)
        .toUpperCase();
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
    for (const [tid, , name] of CATS) classes.push({ type_id: tid, type_name: name, type_flag: "0" });
    classes.push({ type_id: "tagf", type_name: "标签", type_flag: "1" });
    classes.push({ type_id: "search", type_name: "搜索", type_flag: "1" });
    classes.push({ type_id: "web", type_name: "网页", type_flag: "1" });

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
    const mediaF = [
      {
        key: "media",
        name: "分类",
        value: [
          { n: "全部", v: "all" },
          { n: "2D", v: "2d" },
          { n: "3D", v: "3d" },
          { n: "4K", v: "4k" },
          { n: "竖屏", v: "vert" },
        ],
      },
    ];
    const filters = { latest: mediaF.concat(sortF) };
    for (const [tid] of CATS) filters[tid] = sortF;

    return { class: classes, filters: filters };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.dur || "视频",
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

    // 标签：字母层
    if (tid === "tagf") {
      const tags = await this.loadTags();
      const list = this.groupLetters(tags).map((g) => ({
        vod_id: "seg:" + g.key,
        vod_name: g.key,
        vod_pic: "",
        vod_remarks: g.items.length + " 个",
        vod_tag: "folder",
      }));
      if (list.length === 0) {
        list.push({
          vod_id: "seg:其他",
          vod_name: "标签没加载出来",
          vod_pic: "",
          vod_remarks: "点开重试",
          vod_tag: "folder",
          action: "retry|tags",
        });
      }
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
        vod_remarks: t.count ? t.count + " 帖" : "标签",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url = "";
    if (tid.indexOf("t:") === 0) {
      url = BASE + "/video_tag/" + tid.substring(2) + "/" + (p > 1 ? "page/" + p + "/" : "");
    } else {
      let path = "/video/";
      if (tid === "latest") {
        const media = (extend && extend.media) || "all";
        if (media === "2d") path = "/categories/2d-rule-34/";
        else if (media === "3d") path = "/categories/3d-porn/";
        else if (media === "4k") path = "/categories/4k/";
        else if (media === "vert") path = "/categories/vertical-videos/";
      } else {
        const hit = CATS.find((c) => c[0] === tid);
        if (hit) path = hit[1];
      }
      const sel = (extend && extend.sort) || "date";
      let q = "";
      if (sel === "asc") q = "?order=asc";
      else if (sel === "rand") q = "?orderby=rand";
      url = BASE + path + (p > 1 ? "page/" + p + "/" : "") + q;
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
      let stream = "";
      if (html) {
        const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
        if (h1) title = strip(h1[1]);
        if (!title) {
          const t = html.match(/<title>([^<]*)<\/title>/);
          if (t) title = strip(t[1]);
        }
        const og =
          html.match(/property="og:image"\s+content="([^"]+)"/) ||
          html.match(/content="([^"]+)"\s+property="og:image"/);
        if (og) pic = unesc(og[1]);
        // ⚠ 详情页里有 17 个 video-length（都是「相关视频」的），
        // 取第一个会和列表上的时长对不上，所以详情页不显示时长，以列表为准
        stream = parseStream(html);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || "NSFWR34",
        vod_pic: pic,
        vod_content: stream ? "m3u8 直链" : "未找到直链",
        vod_play_from: "NSFWR34",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    void flag;
    void vipFlags;
    const pageUrl = String(id);
    const html = await this.fetchPage(pageUrl);
    let stream = html ? parseStream(html) : "";
    if (!stream && pageUrl.indexOf(".m3u8") > 0) stream = pageUrl;
    if (!stream) return { parse: 0, url: "", msg: "没找到视频地址" };
    return {
      parse: 0,
      url: stream,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async action(op, value) {
    void value;
    const s = String(op === undefined || op === null ? "" : op);
    if (s === "retry|tags") {
      this.tagCache = null;
      return { msg: "已清空标签缓存，返回再点一次" };
    }
    return { msg: "未知操作" };
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
