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
    // 新版站点封面放在 div 的 style="background-image:url(...)" 里
    const bg = seg.match(/background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/);
    if (bg) pic = unesc(bg[1].trim());
    const pool = [seg.match(/<img[^>]+src="([^"]+)"/)];
    const all = [...seg.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    let siteImg = "";
    for (const u of all) {
      // webp-express 的路径是 wp-content/webp-express/webp-images/uploads/...
      if (u.indexOf("/uploads/") >= 0 || u.indexOf("wp-content/uploads") >= 0) {
        siteImg = u;
        break;
      }
    }
    if (!pic && siteImg) pic = unesc(siteImg);
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

// @bili-helpers BEGIN v2026-11-26（由 tools/inject.mjs 注入，可安全整块替换）
function titlePV(title) {
  const t = String(title || "");
  const both = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]\s*([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const toHalf = (x) => Number(String(x).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))) || 0;
  if (both) return { p: toHalf(both[1]), v: toHalf(both[2]) };
  const onlyV = t.match(/([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const onlyP = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]/);
  return { p: onlyP ? toHalf(onlyP[1]) : 0, v: onlyV ? toHalf(onlyV[1]) : 0 };
}

/** 标题里的时长（12:34 / 01:47:35），取不到给空串 */

function titleDuration(title) {
  const m = String(title || "").match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return m ? m[1] : "";
}

/**
 * 角标：站点结构化字段 > 标题里的 P/V/时长 > 留空。
 * 用法：vod_remarks: badgeOf(title, { photos: 12, videos: 1, duration: "12:34" })
 * 返回形态只有三种合法：NP、NP·MV、时长；无效值（0P/1P 占位）自动忽略。
 */

function badgeOf(title, info) {
  const i = info || {};
  const pv = titlePV(title);
  let p = Number(i.photos) > 0 ? Number(i.photos) : pv.p;
  let v = Number(i.videos) > 0 ? Number(i.videos) : pv.v;
  if (p === 1 && v > 0) p = 0;              // 「1P·1V」里的 1P 多半是封面占位
  if (p > 0 && v > 0) return p + "P·" + v + "V";
  if (v > 0) return v + "V";
  if (p > 0) return p + "P";
  const dur = i.duration || titleDuration(title);
  return dur || "";
}

// @bili-helpers END

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

    // 标签 2700+，REST 要翻 28 页；先试 3 个 video_tag sitemap（串行，失败不影响）
    const all = [];
    const seen = {};
    for (let i = 1; i <= 3; i++) {
      let r = null;
      try {
        r = await this.net.req(BASE + "/video_tag-sitemap" + i + ".xml", {
          headers: headers(),
        });
      } catch (e) {
        r = null;
      }
      this.log(
        "sitemap" + i + ": " + (r ? r.code + "/" + (r.content ? r.content.length : -1) : "null")
      );
      if (!r || !r.content) continue;
      const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
      let m;
      let hit = 0;
      while ((m = re.exec(r.content))) {
        const mm = m[1].match(/\/video_tag\/([^\/]+)\/?$/);
        if (!mm) continue;
        let slug = mm[1];
        try {
          slug = decodeURIComponent(slug);
        } catch (e) {}
        hit++;
        if (seen[slug]) continue;
        seen[slug] = 1;
        all.push({ name: slug.replace(/-/g, " "), slug: slug, count: 0 });
      }
      this.log("sitemap" + i + " parsed " + hit);
    }
    all.sort((a, b) => a.name.localeCompare(b.name));
    this.log("tags total: " + all.length);
    this.tagCache = all;
    return all;
  }

  /** 标签按字母：索引已在 tagCache 里，直接过滤，不再发请求 */
  async tagsForLetter(key) {
    const tags = await this.loadTags();
    const out = [];
    const k = String(key || "").trim().toUpperCase();
    for (const t of tags) {
      const n = String(t.name == null ? "" : t.name).trim();
      if (!n) continue;
      const ch = n.charAt(0).toUpperCase();
      const g = ch >= "A" && ch <= "Z" ? ch : "#";
      if (g === k) out.push(t);
    }
    return out;
  }

  letterKey(name) {
    const ch = String(name || "").trim().charAt(0).toUpperCase();
    return ch >= "A" && ch <= "Z" ? ch : "#";
  }

  async fetchTagsPage(page) {
    const url =
      BASE +
      "/wp-json/wp/v2/video_tag?per_page=100&page=" +
      page +
      "&orderby=name&order=asc&_fields=name,slug,count";
    try {
      const r = await this.net.req(url, { headers: headers() });
      if (!r || r.code !== 200 || !r.content) return [];
      const arr = JSON.parse(r.content);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  /** 只按字母需要拉对应页：A~D 通常第 1 页就够，后面的字母再往后翻 */
  async tagsForLetter(key) {
    this.tagPages = this.tagPages || {};
    const per = 100;
    const items = [];
    for (let p = 1; p <= 10; p++) {
      const arr = this.tagPages[p] || (this.tagPages[p] = await this.fetchTagsPage(p));
      if (!arr.length) break;
      for (const t of arr) {
        const name = strip(t.name);
        if (!name) continue;
        items.push({ name: name, slug: t.slug, count: t.count || 0 });
      }
      const lastKey = this.letterKey(strip(arr[arr.length - 1].name || ""));
      if (arr.length < per) break;
      if (key !== "#" && lastKey > key) break;
    }
    return items.filter((t) => this.letterKey(t.name) === key);
  }

  async homeContent(filter) {
    void filter;
    const classes = [{ type_id: "latest", type_name: "推荐", type_flag: "0" }];
    for (const [tid, , name] of CATS) classes.push({ type_id: tid, type_name: name, type_flag: "0" });

    // 标签：字母菜单先写死（#、A-Z），点了字母才去拉标签，避免进首页就拉全量
    const letters = ["#"].concat("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
    classes.push({
      type_id: "",
      type_name: "标签",
      sub: letters.map((l) => ({ id: "seg:" + l, name: l })),
    });

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
    // 媒体筛选已并入顶部 tab（2D/3D/4K/竖屏），这里不再重复

    const filters = { latest: sortF };
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
      const tags = await this.tagsForLetter(key);
      if (!tags.length) {
        const allTags = await this.loadTags();
        return this.page(
          [
            {
              vod_id: "diag",
              vod_name: "「" + key + "」没有标签（key=" + key + "#" + (key ? key.charCodeAt(0) : -1) + "，共 " + allTags.length + "，M=" + allTags.filter(function(x){return String(x.name).charAt(0).toUpperCase()==="M";}).length + "）",
              vod_pic: "",
              vod_remarks: "",
              vod_tag: "folder",
            },
          ],
          1,
          1,
          1
        );
      }
      const list = tags.map((t) => ({
        vod_id: "t:" + t.slug,
        vod_name: t.name,
        vod_pic: "",
        vod_remarks: t.count ? t.count + " 帖" : "标签",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url = "";
    if (tid.indexOf("a:") === 0) {
      url = BASE + "/author/" + tid.substring(2) + "/" + (p > 1 ? "page/" + p + "/" : "");
    } else if (tid.indexOf("t:") === 0) {
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
      let authorName = "";
      let authorSlug = "";
      let cats = [];
      let tags = [];
      let recs = [];
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

      if (html) {
        const h1Pos = html.indexOf("<h1");
        // 作者：标题附近的第一个 /author/ 链接
        const near = h1Pos >= 0 ? html.substring(Math.max(0, h1Pos - 1000), h1Pos + 9000) : "";
        const am = near.match(/href="https:\/\/nsfwr34\.com\/author\/([a-z0-9_\-]+)\/"[^>]*>([^<]{1,40})</i);
        if (am) {
          authorSlug = am[1];
          authorName = strip(am[2]);
        }
        // 分类（标题附近）
        const cmap = {
          "2d-rule-34": "c2d",
          "3d-porn": "c3d",
          "4k": "c4k",
          "vertical-videos": "cvert",
        };
        const seenCat = {};
        for (const cm of near.matchAll(/href="https:\/\/nsfwr34\.com\/categories\/([a-z0-9\-]+)\/"[^>]*>([^<]{1,30})</g)) {
          const slug = cm[1];
          const tid = cmap[slug];
          if (!tid || seenCat[tid]) continue;
          seenCat[tid] = 1;
          cats.push({ name: strip(cm[2]), id: tid });
        }
        // 标签：h1 之后的 video_tag 链接（排除侧边栏）
        if (h1Pos >= 0) {
          const after = html.substring(h1Pos);
          const seenTag = {};
          let count = 0;
          for (const tm of after.matchAll(/href="https:\/\/nsfwr34\.com\/video_tag\/([a-z0-9\-]+)\/"[^>]*>([^<]{1,40})</g)) {
            const slug = tm[1];
            if (seenTag[slug]) continue;
            seenTag[slug] = 1;
            tags.push({ name: strip(tm[2]), id: "t:" + slug });
            if (++count >= 14) break;
          }
        }
        // 相关推荐
        const relPos = html.indexOf("Related Videos");
        if (relPos > 0) {
          recs = parseCards(html.substring(relPos)).slice(0, 10);
        }
      }

      const link = (name, id) => '[a=cr:{"id":"' + id + '"}]{' + name.replace(/[\[\]]/g, "") + '}[/a]';
      const contentLines = [];
      if (cats.length) contentLines.push(cats.map((c) => '[a=cr:{"id":"' + c.id + '"}/]' + c.name + '[/a]').join(" · "));
      if (tags.length) contentLines.push(tags.map((t) => '[a=cr:{"id":"' + t.id + '"}/]' + t.name + '[/a]').join(" · "));

      list.push({
        vod_id: pageUrl,
        vod_name: title || "NSFWR34",
        vod_pic: pic,
        vod_content: contentLines.join("\n") || (stream ? "m3u8 直链" : "未找到直链"),
        vod_remarks: authorSlug ? '[a=cr:{"id":"a:' + authorSlug + '"}/]' + authorName + '[/a]' : "",
        vod_play_from: "NSFWR34",
        vod_play_url: "正片$" + pageUrl,
        gallery: false,
      });

      for (const rec of recs) {
        if (!rec.url || rec.url === pageUrl) continue;
        list.push({
          vod_id: rec.url,
          vod_name: rec.title,
          vod_pic: rec.pic,
          vod_remarks: rec.dur || "",
        });
      }
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
      parse: /\.m3u8(\?|$)/i.test(stream) ? 1 : 0,
      url: stream,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  // 原站 Related Videos 的 AJAX 分页：POST admin-ajax.php
  async relPage(url, page) {
    this.relCache = this.relCache || {};
    let st = this.relCache[url];
    if (!st) {
      const html = await this.fetchPage(url);
      if (!html) return { list: [], page: 1, hasMore: false };
      const wp = html.match(/"_wpnonce":"([a-z0-9]+)"/);
      const nz = html.match(/"nonce":"([a-z0-9]+)"/);
      const m = html.match(/class="[^"]*widget-load-more-posts[^"]*"[^>]*data-params="([^"]+)"/);
      if (!m) return { list: [], page: 1, hasMore: false };
      st = {
        params: unesc(m[1]),
        nonce: wp ? wp[1] : nz ? nz[1] : "",
        paged: 1,
        maxPages: 1,
      };
      this.relCache[url] = st;
    }
    let cards = [];
    let guard = 0;
    while (st.paged < page && st.params && guard++ < 30) {
      const step = await this.relPost(st);
      if (!step) break;
      cards = step.cards;
    }
    return {
      list: cards.map((c) => ({ id: c.url, name: c.title, pic: c.pic, remarks: c.dur || "" })),
      page: st.paged,
      maxPages: st.maxPages,
      hasMore: !!st.params && st.paged < st.maxPages,
    };
  }

  async relPost(st) {
    let res;
    try {
      res = await this.net.req(BASE + "/wp-admin/admin-ajax.php", {
        method: "POST",
        postType: "form",
        data: {
          action: "widget_load_more_posts",
          _wpnonce: st.nonce,
          data: st.params,
        },
        headers: {
          "User-Agent": UA,
          "Referer": BASE + "/",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
    } catch (e) {
      this.log("rel post failed: " + e);
      return null;
    }
    if (!res || res.code !== 200) return null;
    let body;
    try {
      body = JSON.parse(res.content);
    } catch (e) {
      return null;
    }
    if (!body || !body.success || !body.data) return null;
    const html = body.data.output || "";
    const params = body.data.data || "";
    if (!params) {
      st.params = "";
      return { cards: [] };
    }
    let paged = st.paged + 1;
    let maxPages = st.maxPages;
    try {
      const p = JSON.parse(params);
      if (p && p.paged) paged = Number(p.paged) || paged;
      if (p && p.max_pages) maxPages = Number(p.max_pages) || maxPages;
    } catch (e) {
    }
    const mm = html.match(/data-max-pages="(\d+)"/);
    if (mm) maxPages = Number(mm[1]) || maxPages;
    st.params = params;
    st.paged = paged;
    st.maxPages = maxPages;
    return { cards: parseCards(html) };
  }

  async action(op, value) {
    void value;
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("tags|") === 0) {
      // tags|：全部标签按首字母分组（一次返回，客户端直接铺开）
      let all = [];
      try {
        all = (await this.loadTags()) || [];
      } catch (e) {
        this.log("loadTags failed: " + e);
      }
      const groups = {};
      for (const t of all) {
        const name = strip(t.name || t.slug || "");
        if (!name) continue;
        const ch = name.charAt(0).toUpperCase();
        const key = ch >= "A" && ch <= "Z" ? ch : "#";
        groups[key] = groups[key] || [];
        groups[key].push({ name: name, id: "t:" + t.slug, count: t.count || 0 });
      }
      const list = Object.keys(groups)
        .sort()
        .map((k) => ({ letter: k, items: groups[k] }));
      return { groups: list };
    }

    if (s.indexOf("side|") === 0) {
      // 站点左侧边栏（原站 #sidebar-secondary 里的内容类条目）
      // id 用插件已有的 type_id，客户端直接当分类打开
      return {
        groups: [
          {
            name: "浏览",
            items: [{ name: "4K Videos", id: "c4k" }],
          },
          {
            name: "游戏标签",
            items: [
              { name: "FUTA", id: "t:futa" },
              { name: "Overwatch", id: "t:overwatch-porn" },
              { name: "Marvel Rivals", id: "t:marvel-rivals-rule-34" },
              { name: "Fortnite Rule 34", id: "t:fortnite-rule-34" },
              { name: "Final Fantasy", id: "t:final-fantasy" },
              { name: "Cyberpunk 2077", id: "t:cyberpunk2077-porn" },
              { name: "Tomb Raider", id: "t:tomb-raider-porn" },
              { name: "Dead or Alive", id: "t:dead-or-alive-porn" },
              { name: "League of legends", id: "t:league-of-legends-porn" },
              { name: "Genshin impact", id: "t:genshin-impact-porn" },
              { name: "The Witcher", id: "t:the-witcher-porn" },
              { name: "Resident Evil", id: "t:resident-evil-porn" },
              { name: "Nier Automata", id: "t:nier-automata-porn" },
              { name: "Elden Ring", id: "t:elden-ring-porn" },
            ],
          },
        ],
      };
    }

    if (s.indexOf("au|") === 0) {
      // au|<slug>：作者页的名字 + 头像（作者页没有 h1，头像多为 gravatar）
      const slug = s.substring(3);
      let name = slug;
      let avatar = "";
      try {
        const html = await this.fetchPage(BASE + "/author/" + slug + "/");
        if (html) {
          const t = html.match(/<title>([^<]*)<\/title>/);
          if (t) {
            let n = strip(t[1]).replace(/\s*[-–—|]\s*NSFW Rule 34.*$/i, "").replace(/\s*Archives?\s*$/i, "").trim();
            if (n.length > 0 && n.length < 40) name = n;
          }
          const g = html.match(/https:\/\/secure\.gravatar\.com\/avatar\/[a-z0-9]+\?s=\d+/i);
          if (g) {
            avatar = g[0].replace(/&#0?38;/g, "&");
          } else {
            const av = html.match(/<img[^>]+(?:class="[^"]*avatar[^"]*"[^>]+src="([^"]+)"|src="([^"]+)"[^>]+class="[^"]*avatar[^"]*")/i);
            if (av) avatar = unesc(av[1] || av[2] || "");
          }
        }
      } catch (e) {
        this.log("author info failed: " + e);
      }
      return { name: name, avatar: avatar };
    }

    if (s.indexOf("relv|") === 0) {
      // relv|<页面地址>|<页码>：原站 Related Videos 的 AJAX 分页（每页 6 条）
      const rest = s.substring(5);
      const cut = rest.lastIndexOf("|");
      const url = cut > 0 ? rest.substring(0, cut) : rest;
      const page = Math.max(2, Number(cut > 0 ? rest.substring(cut + 1) : 2) || 2);
      const res = await this.relPage(url, page);
      return res;
    }

    if (s.indexOf("rel|") === 0) {
      const parts = s.substring(4).split("|");
      const pageUrl = parts[0];
      const page = Math.max(2, Number(parts[1]) || 2);
      const res = await this.relPage(pageUrl, page);
      return res;
    }

    if (s.indexOf("au|") === 0) {
      // au|<slug>：作者页的名字 + 头像（作者页没有 h1，头像多为 gravatar）
      const slug = s.substring(3);
      let name = slug;
      let avatar = "";
      try {
        const html = await this.fetchPage(BASE + "/author/" + slug + "/");
        if (html) {
          const t = html.match(/<title>([^<]*)<\/title>/);
          if (t) {
            let n = strip(t[1]).replace(/\s*[-–—|]\s*NSFW Rule 34.*$/i, "").replace(/\s*Archives?\s*$/i, "").trim();
            if (n.length > 0 && n.length < 40) name = n;
          }
          const g = html.match(/https:\/\/secure\.gravatar\.com\/avatar\/[a-z0-9]+\?s=\d+/i);
          if (g) {
            avatar = g[0].replace(/&#0?38;/g, "&");
          } else {
            const av = html.match(/<img[^>]+(?:class="[^"]*avatar[^"]*"[^>]+src="([^"]+)"|src="([^"]+)"[^>]+class="[^"]*avatar[^"]*")/i);
            if (av) avatar = unesc(av[1] || av[2] || "");
          }
        }
      } catch (e) {
        this.log("author info failed: " + e);
      }
      return { name: name, avatar: avatar };
    }

    if (s.indexOf("rel|") === 0) {
      // rel|<页面地址>|<页码>：按该视频的分类继续翻页，供详情页"推荐视频"无限加载
      const parts = s.substring(4).split("|");
      const pageUrl = parts[0];
      const page = Math.max(1, Number(parts[1]) || 1);
      let cat = "";
      try {
        const html = await this.fetchPage(pageUrl);
        if (html) {
          const h1 = html.indexOf("<h1");
          const near = h1 >= 0 ? html.substring(Math.max(0, h1 - 1000), h1 + 9000) : html;
          const cm = near.match(/href="https:\/\/nsfwr34\.com\/categories\/([a-z0-9\-]+)\//i);
          if (cm) cat = cm[1];
        }
      } catch (e) {
        this.log("rel category failed: " + e);
      }
      const path = cat ? "/categories/" + cat + "/" : "/video/";
      const url = BASE + path + (page > 1 ? "page/" + page + "/" : "");
      let cards = [];
      try {
        const html2 = await this.fetchPage(url);
        if (html2) cards = parseCards(html2);
      } catch (e) {
        this.log("rel list failed: " + e);
      }
      return {
        list: cards.map((c) => ({
          id: c.url,
          name: c.title,
          pic: c.pic,
          remarks: c.dur || "",
        })),
      };
    }

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
