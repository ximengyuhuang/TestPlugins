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
  // 兜底：没有 JSON-LD 就扫链接（画师页就属于这种，278KB 全 HTML）
  // ⚠ 窗口必须给够：卡片里 <img srcset> 单个标签就能吃掉 300 字
  // 另外：分类/标签页的 JSON-LD 常常不带 image，这里顺手用 HTML 里的 <img> 补封面
  {
    const src = String(html);
    const re = /href="([^"]*\/album\/[0-9a-f\-]{36})"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const url = abs(m[1]);
      const block = src.substring(m.index, m.index + 1600);
      const im = block.match(/<img[^>]+src="([^"]+)"/) || block.match(/data-src="([^"]+)"/);
      const pic = im ? abs(im[1]) : "";

      if (seen[url]) {
        // 已经有了但没封面 → 补上
        if (pic) {
          for (const it of out) {
            if (it.url === url && !it.pic) it.pic = pic;
          }
        }
        continue;
      }

      let title = "";
      const tm =
        block.match(/<h[1-4][^>]*>([\s\S]{1,120}?)<\/h[1-4]>/) ||
        block.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]{1,120}?)</) ||
        block.match(/alt="([^"]{2,120})"/);
      if (tm) title = clean(tm[1]);
      if (!title) {
        const t2 = block.match(/>([^<>]{4,80})</);
        if (t2) title = clean(t2[1]);
      }
      if (!title) continue;

      seen[url] = 1;
      out.push({ url: url, title: title, pic: pic });
    }
  }
  return out;
}

// 通用：抽某种前缀的链接（分类/标签/画师索引页用）
function parseLinks(html, prefix) {
  const out = [];
  const seen = {};
  const src = String(html);
  const isUuidText = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
  const re = new RegExp('href="([^"]*' + prefix + '[^"\/]+)"', "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    const url = abs(m[1]);
    if (seen[url]) continue;

    // 取这个链接之后的一大块（img 的 srcset 经常就超过 300 字，窗口必须够大）
    const block = src.substring(m.index, m.index + 1600);

    let name = "";
    const nm =
      block.match(/<h[1-4][^>]*>([\s\S]{1,60}?)<\/h[1-4]>/) ||
      block.match(/class="[^"]*(?:name|title|coser)[^"]*"[^>]*>([\s\S]{1,60}?)</) ||
      block.match(/alt="([^"]{2,60})"/);
    if (nm) name = clean(nm[1]);
    if (!name || isUuidText(name)) {
      // 退而求其次：块里第一个像名字的文本节点
      const cands = [...block.matchAll(/>([^<>]{2,30})</g)]
        .map((x) => clean(x[1]))
        .filter(
          (t) =>
            t &&
            !/^\d+$/.test(t) &&
            !/^(作品|图集|分类|标签|画师|照片|共|更多|查看|加载)/.test(t) &&
            !isUuidText(t)
        );
      if (cands.length) name = cands[0];
    }
    if (!name) name = decodeURIComponent(url.split("/").filter(Boolean).pop() || "");
    if (!name) continue;

    let pic = "";
    const im = block.match(/<img[^>]+src="([^"]+)"/) || block.match(/data-src="([^"]+)"/);
    if (im) pic = abs(im[1]);

    seen[url] = 1;
    out.push({ url: url, name: name, pic: pic });
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
    const r = await this.reqRetry(url, 2);
    if (!r.html || r.code !== 200) return "";
    this.cacheSet(url, r.html);
    return r.html;
  }

  // 带重试的请求：CF 对连续请求偶尔判爬虫，隔一下再试通常能过
  async reqRetry(url, tries = 3) {
    let code = 0;
    let html = "";
    for (let i = 0; i < tries; i++) {
      try {
        const r = await this.net.req(url, { headers: this.h() });
        code = (r && r.code) || 0;
        html = (r && r.content) || "";
      } catch (e) {
        code = -1;
        html = "";
      }
      if (html && code === 200) return { code: code, html: html };
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 600 + i * 700));
    }
    return { code: code, html: html };
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

  // 相册分页：优先按页面里真实的分页链接翻（/album/<uuid>/2、/3 …），
  // 拿不到分页链接时才按数字递增猜
  async collectAlbum(albumUrl) {
    const base = String(albumUrl).replace(/\/+$/, "");
    const out = [];
    const seen = {};
    const seenPages = {};
    let queue = [base];
    let guard = 0;

    while (queue.length > 0 && guard < 40) {
      guard++;
      const u = queue.shift();
      if (seenPages[u]) continue;
      seenPages[u] = 1;

      let html = "";
      try {
        html = await this.fetchPage(u);
      } catch (e) {
        html = "";
      }
      if (!html && u === base) {
        const rel = base.replace(BASE, "");
        const r2 = await this.fetchFirst([base + "/", BASE + "/en" + rel]);
        html = r2.html;
      }
      if (!html) continue;

      const imgs = parseAlbum(html);
      for (const im of imgs) {
        if (seen[im]) continue;
        seen[im] = 1;
        out.push(im);
      }

      // 找这一页里的其它分页链接
      const rel = base.replace(BASE, "");
      const paging = new Set();
      const rePage = new RegExp('href="([^"]*' + rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '/(\\d+))"', "g");
      let mp;
      while ((mp = rePage.exec(html)) !== null) {
        const cand = abs(mp[1]);
        if (!seenPages[cand]) paging.add(cand);
      }
      if (paging.size > 0) {
        queue = queue.concat([...paging].sort());
      } else if (out.length > 0) {
        // 没有分页链接 → 猜下一页，最多试 3 页（避免白跑）
        const next = base + "/" + (seenPages.size);
        if (!seenPages[next] && Object.keys(seenPages).length < 6) queue.push(next);
      }
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

  cardsToList(cards, asFolder) {
    return cards.map((c) => {
      if (asFolder) {
        // 「有视频」那栏：这些相册里有视频 → 点开先给二级菜单（图集 / 视频）
        return {
          vod_id: "mix|" + c.url,
          vod_name: c.title,
          vod_pic: c.pic,
          vod_remarks: "含视频",
          vod_tag: "folder",
        };
      }
      return {
        vod_id: c.url,
        vod_name: c.title,
        vod_pic: c.pic,
        vod_remarks: "图集",
        action: "gal:" + c.url,
      };
    });
  }

  // 从相册页找视频地址（m3u8 / mp4 / <video src>）
  extractVideo(html) {
    const h = String(html);
    const m =
      h.match(/"(https?:[^"]+?\.m3u8[^"]*)"/) ||
      h.match(/<video[^>]+src="([^"]+)"/) ||
      h.match(/<source[^>]+src="([^"]+)"/) ||
      h.match(/"(https?:[^"]+?\.mp4[^"]*)"/);
    return m ? m[1].replace(/\\\//g, "/") : "";
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

    // 二级菜单：含视频的相册
    if (tid.indexOf("mix|") === 0) {
      const albumUrl = tid.substring(4);
      const list = [];
      let imgs = [];
      let vurl = "";
      try {
        const html = await this.fetchPage(albumUrl);
        if (html) {
          vurl = this.extractVideo(html);
          imgs = parseAlbum(html);
        }
      } catch (e) {
        /* 忽略 */
      }
      if (imgs.length > 0) {
        list.push({
          vod_id: "gal2|" + albumUrl,
          vod_name: "🖼 查看图集 (" + imgs.length + " 张)",
          vod_pic: "",
          vod_remarks: "图集",
          action: "gal2|" + albumUrl,
        });
      }
      if (vurl) {
        list.push({
          vod_id: "v|" + vurl,
          vod_name: "▶ 播放视频",
          vod_pic: "",
          vod_remarks: "视频",
        });
      }
      // 拿不到直链就用网页播（站点播放器能选第 1/2/3 集）
      list.push({
        vod_id: "web|" + albumUrl,
        vod_name: "▶ 播放视频（网页，可选集）",
        vod_pic: "",
        vod_remarks: "视频",
        action: "web|" + albumUrl,
      });
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
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
        vod_pic: x.pic || "",
        vod_remarks: tid === "catf" ? "分类" : tid === "tagf" ? "标签" : "画师",
        vod_tag: "folder",
      }));
      // 一条都没解析出来时，放一张诊断卡片（点开就是那个页面），方便定位
      if (list.length === 0) {
        list.push({
          vod_id: BASE + conf.paths[0],
          vod_name: "诊断 " + diag,
          vod_pic: "",
          vod_remarks: "点开看原页面",
          action: "web|" + BASE + conf.paths[0],
        });
      }
      return this.page(list, p, PAGE_SIZE, list.length);
    }

    // 每个栏目可能有好几种写法（CF 对不同路径策略不同），逐个试
    let cands = [];
    if (tid.indexOf("c:") === 0 || tid.indexOf("t:") === 0 || tid.indexOf("a:") === 0) {
      const target = tid.substring(2);
      cands = p > 1 ? [target + "/page/" + p, target + "?page=" + p, target + "/" + p] : [target];
    } else if (tid === "video") {
      cands =
        p > 1
          ? [BASE + "/albums/with-video/page/" + p, BASE + "/albums/with-video?page=" + p]
          : [BASE + "/reels", BASE + "/reels/", BASE + "/albums/with-video", BASE + "/videos"];
    } else {
      cands = p > 1 ? [BASE + "/page/" + p, BASE + "/page/" + p + "/", BASE + "/?page=" + p] : [BASE + "/"];
    }

    let code = 0;
    let html = "";
    let used = cands[0];
    let cards = [];
    for (const c of cands) {
      const rr = await this.reqRetry(c, 2);
      const k = rr.code;
      const h = rr.html;
      if (!h) continue;
      const got = parseList(h);
      if (got.length > 0) {
        code = k;
        html = h;
        used = c;
        cards = got;
        this.cacheSet(c, h);
        break;
      }
      if (!html) {
        code = k;
        html = h;
        used = c;
      }
    }

    if (cards.length === 0 && p > 1) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    if (cards.length === 0) {
      // 诊断卡片：把状态码和长度直接显示出来
      const path = used.replace(BASE, "");
      return this.page(
        [
          {
            vod_id: used,
            vod_name: "诊断 " + code + "/" + html.length + " " + path,
            vod_pic: "",
            vod_remarks: "点开看原页面",
            action: "web|" + used,
          },
        ],
        p,
        PAGE_SIZE,
        (p - 1) * PAGE_SIZE + 1
      );
    }
    return this.page(this.cardsToList(cards, tid === "video"), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
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

    if (s.indexOf("gal2|") === 0) {
      // 二级菜单里的「查看图集」：直接拼画廊（图片同样走代理）
      const a2 = s.substring(5);
      const real2 = await this.collectAlbum(a2);
      if (real2.length === 0) return { web: { url: a2, mode: "view" } };
      let t2 = "";
      try {
        const h2 = await this.fetchPage(a2);
        const mt = h2 && h2.match(/<title>([^<]*)<\/title>/);
        if (mt) t2 = clean(mt[1]).replace(/\s*-\s*Cosers爱\s*$/, "");
      } catch (e) {
        /* 忽略 */
      }
      const pj = real2.map((x) => {
        try {
          return this.proxyUrl({ u: x });
        } catch (e) {
          return x;
        }
      });
      return {
        web: {
          url: GAL + "?u=" + encodeURIComponent(a2) + "&_gv=20261113c#t=" + encodeURIComponent(t2) + "&i=" + esc(pj.join("|")),
          mode: "view",
        },
      };
    }
    if (s.indexOf("gal|") !== 0 && s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    const real = await this.collectAlbum(u);
    if (real.length === 0) return { web: { url: u, mode: "view" } };

    let title = "";
    try {
      const html = await this.fetchPage(u);
      const t = html && html.match(/<title>([^<]*)<\/title>/);
      if (t) title = clean(t[1]).replace(/\s*-\s*Cosers爱\s*$/, "");
    } catch (e) {
      /* 忽略 */
    }

    // ⚠ 图片必须走插件代理：这站对「没有登录 cookie 的请求」只给带水印的预览图。
    // 代理里带 WebView 的 cookie（含 cf_clearance 和登录态）+ 站内 Referer，才能拿到干净图。
    const proxied = real.map((x) => {
      try {
        return this.proxyUrl({ u: x });
      } catch (e) {
        return x;
      }
    });

    const purl = GAL + "?u=" + encodeURIComponent(u) + "&_gv=20261113c";
    const hash = "#t=" + encodeURIComponent(title) + "&i=" + esc(proxied.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async readBytes(stream) {
    const chunks = [];
    let total = 0;
    for (;;) {
      const buf = await stream.read(65536);
      if (!buf) break;
      const a = new Uint8Array(buf);
      chunks.push(a);
      total += a.length;
    }
    try {
      stream.close();
    } catch (e) {}
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  // 图片代理：带登录 cookie + 站内 Referer
  async proxy(params) {
    const u = (params && (params.u || params.url)) || "";
    if (!u) return [404, "text/plain", "no url"];
    const h = this.h(BASE + "/");
    h["Accept"] = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
    h["Sec-Fetch-Dest"] = "image";
    h["Sec-Fetch-Site"] = "same-site";
    try {
      const st = await this.net.openStream(u, { headers: h });
      const bytes = await this.readBytes(st);
      if (!bytes || bytes.length === 0) return [404, "text/plain", "empty"];
      let mime = "image/avif";
      if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
      else if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = "image/png";
      else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = "image/webp";
      return [200, mime, bytes];
    } catch (e) {
      this.log("img proxy failed: " + e);
      return [404, "text/plain", "fail"];
    }
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    const r = await this.net.req(url, { headers: this.h() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);
    const cards = parseList(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    return this.page(this.cardsToList(cards, tid === "video"), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
