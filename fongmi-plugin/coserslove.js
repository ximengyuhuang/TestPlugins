import { Spider, openWeb } from "catvod";

// Cosers爱（coserslove.com）—— Astro 站，纯图集
// 分类（用户拍板）：最新 | 有视频 | 分类 | 标签 | 画师 | 搜索 | 网页
//   列表     /page/<N>           24 条/页，294 页（7034 个图集）
//   有视频   /albums/with-video
//   分类     /categories → /category/<slug>
//   标签     /tags → /tag/<slug>
//   画师     /cosers → /coser/<uuid>
//   相册     /album/<uuid>       JSON-LD Article.image 里就是图（lg.avif）
//   搜索     /search?q=
// ⚠ CF 管理挑战（我这边 403）；图片 img.coserslove.com（avif）
// ⚠ 相册页每页只给 15 张，标题里的 42P 要靠 JS/API 再加载（robots 禁了 /api/）

const BASE = "https://coserslove.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 24;

// 请求头：必须用 WebView 的真实 UA + cookie，否则动态页会被 CF 403
// （静态页 / /categories / /tags 有边缘缓存，所以之前侥幸能通）
function baseHeaders(ua, cookie, ref) {
  const h = {
    "User-Agent": ua || UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/",
  };
  if (cookie) h["Cookie"] = cookie;
  return h;
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

function esc(s) {
  return String(s)
    .replace(/%/g, "%25")
    .replace(/&/g, "%26")
    .replace(/#/g, "%23")
    .replace(/\+/g, "%2B")
    .replace(/ /g, "%20");
}

function abs(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

// 从 JSON-LD 的 ItemList 里取图集（首页/分类页/标签页都用这个，最稳）
function parseList(html) {
  const out = [];
  const seen = {};
  const blocks = [...String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const b of blocks) {
    if (b.indexOf("ItemList") < 0) continue;
    let j = null;
    try {
      j = JSON.parse(b);
    } catch (e) {
      continue;
    }
    const items = (j.mainEntity && j.mainEntity.itemListElement) || [];
    for (const it of items) {
      const o = it && it.item;
      if (!o || !o.url || !o.name) continue;
      if (seen[o.url]) continue;
      seen[o.url] = 1;
      out.push({
        url: o.url,
        title: clean(o.name),
        pic: o.image || "",
      });
    }
  }
  // 兜底：没有 JSON-LD 就扫链接
  if (out.length === 0) {
    const re = /href="([^"]*\/album\/[0-9a-f\-]{36})"[^>]*>([\s\S]{0,120}?)<\/a>/g;
    let m;
    while ((m = re.exec(String(html))) !== null) {
      const url = abs(m[1]);
      if (seen[url]) continue;
      const t = clean(m[2]);
      if (!t) continue;
      seen[url] = 1;
      out.push({ url: url, title: t, pic: "" });
    }
  }
  return out;
}

// 通用：抽某种前缀的链接（分类/标签/画师索引页用）
// 容错：链接文字可能套了很多层标签，甚至没有文字（画师头像链接）
function parseLinks(html, prefix) {
  const out = [];
  const seen = {};
  const re = new RegExp('href="([^"]*' + prefix + '[^"\/]+)"[^>]*>([\\s\\S]{0,300}?)<\\/a>', "g");
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const url = abs(m[1]);
    if (seen[url]) continue;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(url.split("/").filter(Boolean).pop() || "");
    let name = clean(m[2]);
    if (!name || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name)) {
      // 画师卡片：图在 a 里，名字在 a 外面 → 往后找标题 / alt
      const after = String(html).substring(m.index, m.index + 900);
      const nm =
        after.match(/<h[1-4][^>]*>([\s\S]{1,60}?)<\/h[1-4]>/) ||
        after.match(/class="[^"]*(?:name|title)[^"]*"[^>]*>([\s\S]{1,60}?)</) ||
        after.match(/alt="([^"]{1,60})"/);
      if (nm) name = clean(nm[1]);
    }
    if (!name) name = decodeURIComponent(url.split("/").filter(Boolean).pop() || "");
    if (!name) continue;
    void isUuid;
    seen[url] = 1;
    out.push({ url: url, name: name });
  }
  return out;
}

// 相册详情：JSON-LD Article.image 数组
function parseAlbum(html) {
  const out = [];
  const seen = {};
  const blocks = [...String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const b of blocks) {
    if (b.indexOf("ImageObject") < 0) continue;
    let j = null;
    try {
      j = JSON.parse(b);
    } catch (e) {
      continue;
    }
    const arr = Array.isArray(j.image) ? j.image : j.image ? [j.image] : [];
    for (const it of arr) {
      const u = typeof it === "string" ? it : it && it.url;
      if (!u || seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
  }
  if (out.length === 0) {
    // 兜底：页面里所有 avif（优先大图）
    const rank = { xl: 3, lg: 2, md: 1 };
    const found = {};
    const re = /https:\/\/img\.coserslove\.com\/pic\/[^"'\s]+?\/(xl|lg|md)\.avif/g;
    let m;
    while ((m = re.exec(String(html))) !== null) {
      const u = m[0];
      const size = m[1];
      const key = u.replace(/\/(xl|lg|md)\.avif$/, "");
      if (!found[key] || rank[size] > rank[found[key].size]) found[key] = { u: u, size: size };
    }
    for (const k of Object.keys(found)) {
      if (seen[found[k].u]) continue;
      seen[found[k].u] = 1;
      out.push(found[k].u);
    }
  }
  return out;
}

// 一个相册可能有多页：/album/<uuid>、/album/<uuid>/2、/3 …（collectAlbum 是类方法，见下）


export default class CosersLove extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.log("coserslove ready");
  }

  // 统一请求头：WebView 真实 UA + WebView 里的 cookie（cf_clearance 靠它过关）
  h(ref) {
    let ua = "";
    let ck = "";
    try {
      ua = this.net.getUserAgent() || "";
    } catch (e) {}
    try {
      ck = this.net.getCookie(BASE + "/") || "";
    } catch (e) {}
    return baseHeaders(ua, ck, ref);
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
    const r = await this.net.req(url, { headers: this.h() });
    if (!r || r.code !== 200) return "";
    this.cacheSet(url, r.content);
    return r.content;
  }

  // 依次试多个地址，返回第一个有内容的
  async fetchFirst(urls) {
    for (const u of urls) {
      try {
        const h = await this.fetchPage(u);
        if (h && h.length > 1000) return { url: u, html: h };
      } catch (e) {
        /* 试下一个 */
      }
    }
    return { url: "", html: "" };
  }

  // 一个相册可能有多页：/album/<uuid>、/album/<uuid>/2、/3 …
  async collectAlbum(albumUrl) {
    const base = String(albumUrl).replace(/\/+$/, "");
    const out = [];
    const seen = {};
    for (let p = 1; p <= 40; p++) {
      const u = p <= 1 ? base : base + "/" + p;
      let html = "";
      try {
        html = await this.fetchPage(u);
      } catch (e) {
        html = "";
      }
      if (!html && p === 1) {
        const rel = base.replace(BASE, "");
        const r2 = await this.fetchFirst([base + "/", BASE + "/en" + rel]);
        html = r2.html;
      }
      if (!html) break;
      const imgs = parseAlbum(html);
      let added = 0;
      for (const im of imgs) {
        if (seen[im]) continue;
        seen[im] = 1;
        out.push(im);
        added++;
      }
      if (added === 0) break;
    }
    return out;
  }

  async homeContent(filter) {
    return {
      class: [
        { type_id: "latest", type_name: "最新", type_flag: "0" },
        { type_id: "video", type_name: "有视频", type_flag: "0" },
        { type_id: "catf", type_name: "分类", type_flag: "1" },
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
      vod_remarks: "图集",
      action: "gal:" + c.url,
    }));
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    void filter;
    void extend;

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
        openWeb({ url: BASE + "/search" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 三个索引：分类 / 标签 / 画师
    if (tid === "catf" || tid === "tagf" || tid === "artf") {
      const conf = {
        catf: {
          paths: ["/categories", "/categories/", "/all-categories", "/category", "/category/", "/discover", "/categories/all"],
          prefix: "/category/",
          idp: "c:",
        },
        tagf: {
          paths: ["/tags", "/tags/", "/all-tags", "/tag", "/tag/", "/discover/tags"],
          prefix: "/tag/",
          idp: "t:",
        },
        artf: {
          paths: ["/cosers", "/cosers/", "/all-cosers", "/coser", "/coser/", "/discover/cosers"],
          prefix: "/coser/",
          idp: "a:",
        },
      }[tid];

      let items = [];
      let html = "";
      const traces = [];
      for (const path of conf.paths) {
        const u = BASE + path + (p > 1 ? (path.indexOf("?") >= 0 ? "&" : "?") + "page=" + p : "");
        let code = 0;
        let h = "";
        try {
          const r = await this.net.req(u, { headers: this.h() });
          code = (r && r.code) || 0;
          h = (r && r.content) || "";
        } catch (e) {
          code = -1;
          h = "";
        }
        traces.push(path + "=" + code + "/" + h.length);
        if (!h) continue;
        const got = parseLinks(h, conf.prefix);
        if (got.length > 0) {
          items = got;
          html = h;
          break;
        }
        if (!html) html = h;
      }
      const diag = traces.join(" ");

      // 兜底：只按 href 抽，名字用 slug
      if (items.length === 0 && html) {
        const seen2 = {};
        const re = new RegExp('href="([^"]*' + conf.prefix + '[^"\/]+)"', "g");
        let m2;
        while ((m2 = re.exec(html)) !== null) {
          const u = abs(m2[1]);
          if (seen2[u]) continue;
          seen2[u] = 1;
          const slug = decodeURIComponent(u.split("/").filter(Boolean).pop() || "");
          if (slug) items.push({ url: u, name: slug });
        }
      }
      const list = items.map((x) => ({
        vod_id: conf.idp + x.url,
        vod_name: x.name,
        vod_pic: "",
        vod_remarks: tid === "catf" ? "分类" : tid === "tagf" ? "标签" : "画师",
        vod_tag: "folder",
      }));
      // 一条都没解析出来时，放一张诊断卡片（点开就是那个页面），方便定位
      if (list.length === 0) {
        list.push({
          vod_id: BASE + conf.paths[0],
          vod_name: "诊断：" + diag,
          vod_pic: "",
          vod_remarks: "点开看原页面",
          action: "web|" + BASE + conf.paths[0],
        });
      }
      return this.page(list, p, PAGE_SIZE, list.length);
    }

    let url;
    if (tid.indexOf("c:") === 0 || tid.indexOf("t:") === 0 || tid.indexOf("a:") === 0) {
      const target = tid.substring(2);
      url = target + (p > 1 ? "/page/" + p : "");
    } else if (tid === "video") {
      url = BASE + "/albums/with-video" + (p > 1 ? "/page/" + p : "");
    } else {
      url = BASE + (p > 1 ? "/page/" + p : "/");
    }

    const html = await this.fetchPage(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseList(html);
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
      const html = await this.fetchPage(pageUrl);
      if (html) {
        const t = html.match(/<title>([^<]*)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*-\s*Cosers爱\s*$/, "");
        const imgs = parseAlbum(html);
        if (imgs.length) pic = imgs[0];
        content = "图集 " + imgs.length + " 张（每页 15 张，更多需站内加载）";
      }
      list.push({
        vod_id: pageUrl,
        vod_name: title || "Cosers爱",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "Cosers爱",
        vod_play_url: "图集$" + pageUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    throw new Error("这是图集，点卡片直接看图集");
  }

  async action(op, value) {
    const s = String(op === undefined || op === null ? "" : op);

    // 诊断卡片 / 视频：直接内置浏览器打开
    if (s.indexOf("web|") === 0 || s.indexOf("web:") === 0) {
      const u = s.substring(4);
      return { web: { url: u.indexOf("http") === 0 ? u : BASE + u, mode: "view" } };
    }

    if (s.indexOf("gal|") !== 0 && s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    const imgs = await this.collectAlbum(u);
    if (imgs.length === 0) {
      // 抓不到图也别死路：直接把这个相册页在内置浏览器里打开
      return { web: { url: u, mode: "view" } };
    }

    let title = "";
    try {
      const html = await this.fetchPage(u);
      const t = html && html.match(/<title>([^<]*)<\/title>/);
      if (t) title = clean(t[1]).replace(/\s*-\s*Cosers爱\s*$/, "");
    } catch (e) {
      /* 忽略 */
    }

    const purl = GAL + "?u=" + encodeURIComponent(u) + "&_gv=20261113b";
    const hash = "#t=" + encodeURIComponent(title) + "&i=" + esc(imgs.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    const r = await this.net.req(url, { headers: this.h() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);
    const cards = parseList(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
