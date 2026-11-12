import { Spider, openWeb } from "catvod";

// NudeCosplayGirls（nudecosplaygirls.com）—— WordPress + Bimber 主题
// 分类完全照站点顶部导航（去掉 3 个站外广告链接）：
//   最新 | Videos(696) | Albums(2399) | Top Cosplayers(312) | Hot Cosplayers(3217) | 标签(504) | 模特 A-Z(321) | 网页
// 每篇常是「mp4 视频 + 图集」混合 → 二级菜单：▶ 播放视频 / 🖼 查看图集
// ⚠ 直连不通，手机必须走代理

const BASE = "https://nudecosplaygirls.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 15;

// 站点导航里的 4 个内容分类
const NAV = [
  { id: "latest", name: "最新", path: "/", query: "" },
  { id: "vid", name: "Videos (696)", path: "/category/nude-cosplay-videos/", query: "" },
  { id: "alb", name: "Albums (2399)", path: "/category/nude-cosplay-albums/", query: "" },
  { id: "top", name: "Top Cosplayers (312)", path: "/category/nude-cosplay/", query: "" },
  { id: "hot", name: "Hot Cosplayers (3217)", path: "/category/nude-cosplayers/", query: "" },
  { id: "tagf", name: "标签", path: null, query: "" },
  { id: "modf", name: "模特 A-Z", path: null, query: "" },
  { id: "web", name: "网页", path: null, query: "" },
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": ref || BASE + "/",
  };
}

function clean(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
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
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.charAt(0) === "/") return BASE + u;
  return BASE + "/" + u;
}

// 卡片：<article class="entry-tpl-grid … post-<id> …">
//   <a class="g1-frame" href="…"><img src="…-364x205.jpg"></a>
//   <h2 class="…entry-title"><a href="…">标题</a></h2>
function parseCards(html) {
  const out = [];
  const seen = {};
  let src = String(html);
  // ⚠ 分类页里还塞了「Trending Now」侧栏，里面的卡片和主列表同款 article 标记，
  // 不裁掉就会把同一个视频重复带出来（实测第 2/3 页各多 3~4 条重复）
  const ci = src.indexOf("g1-collection-items");
  if (ci >= 0) {
    const ce = src.indexOf("</ul>", ci);
    if (ce > ci) src = src.substring(ci, ce);
  }
  const parts = src.split(/<article class="entry-tpl-/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 6000);
    let url = "";
    const byFrame = block.match(/<a[^>]*class="g1-frame"[^>]*href="([^"]+)"/);
    if (byFrame) url = byFrame[1];
    if (!url) {
      const any = block.match(/href="(https:\/\/nudecosplaygirls\.com\/[a-z0-9\-]+\/)"/);
      if (any) url = any[1];
    }
    if (!url) continue;
    if (/\/category\/|\/tag\/|\/page\/|wp-content|wp-json|\/feed|\/hot\/|\/trending\/|\/az-list\/|\/top-categories\//.test(url)) continue;
    if (seen[url]) continue;
    seen[url] = 1;

    const tm = block.match(/class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]*>([\s\S]{0,200}?)<\/a>/);
    const title = clean(tm ? tm[1] : "");
    if (!title) continue;

    const img = block.match(/<img[^>]+src="(https:\/\/nudecosplaygirls\.com\/wp-content\/uploads\/[^"]+)"/);
    const isVideo = /post_format-post-format-video|format-video/.test(block);
    const idm = block.match(/post-(\d+)/);

    out.push({
      url: url,
      id: idm ? idm[1] : "",
      title: title,
      pic: img ? img[1] : "",
      isVideo: isVideo,
    });
  }
  return out;
}

// 详情页正文：从 entry-content 到「分享按钮」为止（再往后是相关推荐，别算进来）
function contentSeg(html) {
  const h = String(html);
  let i = h.indexOf("entry-content");
  if (i < 0) i = 0;
  let end = h.length;
  for (const marker of ["addtoany_share_save_container", "</article>", "entry-footer"]) {
    const k = h.indexOf(marker, i);
    if (k > i && k < end) end = k;
  }
  return h.slice(i, end);
}

function parseVideos(html) {
  const seg = contentSeg(html);
  const out = [];
  const seen = {};
  const re = /<video[^>]+src="([^"]+\.mp4[^"]*)"/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    const u = m[1];
    if (seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

// 图集：新帖 <img class="wp-image-xxx">，老帖就是 <p><img src="…">，两种都收
// 排除：18+ 角标、站徽、卡片缩略图（-364x205）
function parseImages(html) {
  const seg = contentSeg(html);
  const out = [];
  const seen = {};
  const re = /<img[^>]+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    const src = m[1];
    if (!src) continue;
    if (/18plus|logo|\/icon|banner\.|spinner|placeholder|-364x205\./i.test(src)) continue;
    if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(src)) continue;
    if (src.indexOf("wp-content/uploads") < 0) continue;
    if (seen[src]) continue;
    seen[src] = 1;
    out.push(src);
  }
  return out;
}

export default class Ncg extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.tagCache = null;
    this.modCache = null;
    this.log("nudecosplaygirls ready");
  }

  cacheGet(url) {
    const c = this.htmlCache && this.htmlCache[url];
    return c && Date.now() - c.ts < 120000 ? c.html : "";
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

  // 用 WP REST 一次批量判断每篇「有几个视频 / 几张图」，避免每张卡片都发一次请求。
  // 拿不到就返回 null，退回「一律当混合帖」的保守做法。
  async classify(ids) {
    const list = (ids || []).filter(Boolean);
    if (list.length === 0) return null;
    try {
      const url =
        BASE + "/wp-json/wp/v2/posts?include=" + list.join(",") + "&per_page=100&_fields=id,content";
      const r = await this.net.req(url, {
        headers: { "User-Agent": UA, Accept: "application/json", "Referer": BASE + "/" },
      });
      if (!r || r.code !== 200) return null;
      const arr = JSON.parse(r.content);
      if (!Array.isArray(arr)) return null;
      const map = {};
      for (const p of arr) {
        const html = (p.content && p.content.rendered) || "";
        map[String(p.id)] = { vids: parseVideos(html).length, imgs: parseImages(html).length };
      }
      return map;
    } catch (e) {
      this.log("classify failed: " + e);
      return null;
    }
  }

  // /top-categories/ 上的 504 个标签（带数量）
  async loadTags() {
    if (this.tagCache && this.tagCache.length) return this.tagCache;
    const list = [];
    const seen = {};
    const r = await this.net.req(BASE + "/top-categories/", { headers: hdrs() });
    if (r && r.code === 200) {
      const re = /href="https:\/\/nudecosplaygirls\.com\/tag\/([^"\/]+)\/"[^>]*>([\s\S]{0,40}?)<span[^>]*>\s*(\d+)/g;
      let m;
      while ((m = re.exec(r.content)) !== null) {
        if (seen[m[1]]) continue;
        seen[m[1]] = 1;
        list.push({ slug: m[1], name: clean(m[2]) || m[1], count: Number(m[3]) || 0 });
      }
      // 兜底：不带数量的写法
      if (list.length === 0) {
        const re2 = /href="https:\/\/nudecosplaygirls\.com\/tag\/([^"\/]+)\/"[^>]*>([\s\S]{0,40}?)<\/a>/g;
        let n;
        while ((n = re2.exec(r.content)) !== null) {
          if (seen[n[1]]) continue;
          seen[n[1]] = 1;
          list.push({ slug: n[1], name: clean(n[2]) || n[1], count: 0 });
        }
      }
    }
    list.sort((a, b) => b.count - a.count);
    this.tagCache = list;
    return list;
  }

  // /az-list/ 上的 321 个模特（WP 里是 category）
  async loadModels() {
    if (this.modCache && this.modCache.length) return this.modCache;
    const list = [];
    const seen = {};
    const r = await this.net.req(BASE + "/az-list/", { headers: hdrs() });
    if (r && r.code === 200) {
      const skip = { "nude-cosplay-videos": 1, "nude-cosplay-albums": 1, "nude-cosplay": 1, "nude-cosplayers": 1, blog: 1 };
      const re = /href="https:\/\/nudecosplaygirls\.com\/category\/([^"\/]+)\/"[^>]*>([\s\S]{0,60}?)<\/a>/g;
      let m;
      while ((m = re.exec(r.content)) !== null) {
        const slug = m[1];
        if (skip[slug] || seen[slug]) continue;
        const name = clean(m[2]);
        if (!name) continue;
        seen[slug] = 1;
        list.push({ slug: slug, name: name });
      }
    }
    list.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    this.modCache = list;
    return list;
  }

  groupLetters(list, keyField) {
    const g = {};
    for (const it of list) {
      const ch = String(it[keyField]).charAt(0).toUpperCase();
      const key = ch >= "A" && ch <= "Z" ? ch : "#";
      (g[key] = g[key] || []).push(it);
    }
    return Object.keys(g)
      .sort()
      .map((k) => ({ key: k, items: g[k] }));
  }

  async homeContent(filter) {
    return {
      class: NAV.map((n) => ({
        type_id: n.id,
        type_name: n.name,
        type_flag: "0",
      })),
    };
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

    // 标签：字母层 → 标签 → 视频
    if (tid === "tagf") {
      await this.loadTags();
      const list = this.groupLetters(this.tagCache, "name").map((g) => ({
        vod_id: "tseg:" + g.key,
        vod_name: g.key,
        vod_pic: "",
        vod_remarks: g.items.length + " 个",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }
    if (tid.indexOf("tseg:") === 0) {
      await this.loadTags();
      const key = tid.substring(5);
      const g = this.groupLetters(this.tagCache, "name").find((x) => x.key === key);
      const list = (g ? g.items : []).map((t) => ({
        vod_id: "t:" + t.slug,
        vod_name: t.name,
        vod_pic: "",
        vod_remarks: t.count ? t.count + " 个" : "标签",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    // 模特：字母层 → 模特 → 视频
    if (tid === "modf") {
      await this.loadModels();
      const list = this.groupLetters(this.modCache, "name").map((g) => ({
        vod_id: "mseg:" + g.key,
        vod_name: g.key,
        vod_pic: "",
        vod_remarks: g.items.length + " 位",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }
    if (tid.indexOf("mseg:") === 0) {
      await this.loadModels();
      const key = tid.substring(5);
      const g = this.groupLetters(this.modCache, "name").find((x) => x.key === key);
      const list = (g ? g.items : []).map((m) => ({
        vod_id: "c:" + m.slug,
        vod_name: m.name,
        vod_pic: "",
        vod_remarks: "模特",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    // 二级菜单：视频 / 图集
    if (tid.indexOf("mix|") === 0) {
      const pageUrl = tid.substring(4);
      const html = await this.fetchPage(pageUrl);
      const list = [];
      if (html) {
        const vids = parseVideos(html);
        const imgs = parseImages(html);
        if (vids.length > 0) {
          list.push({
            vod_id: "v|" + pageUrl + "|0",
            vod_name: "▶ 播放视频" + (vids.length > 1 ? "（" + vids.length + " 个版本）" : ""),
            vod_pic: "",
            vod_remarks: vids.length > 1 ? vids.length + " 集" : "视频",
          });
        }
        if (imgs.length > 0) {
          list.push({
            vod_id: "gal|" + pageUrl,
            vod_name: "🖼 查看图集 (" + imgs.length + " 张)",
            vod_pic: "",
            vod_remarks: "图集",
            action: "gal|" + pageUrl,
          });
        }
      }
      if (list.length === 0) {
        list.push({ vod_id: pageUrl, vod_name: "（没有内容）", vod_pic: "", vod_remarks: "" });
      }
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url;
    if (tid.indexOf("c:") === 0) {
      url = BASE + "/category/" + tid.substring(2) + "/" + (p > 1 ? "page/" + p + "/" : "");
    } else if (tid.indexOf("t:") === 0) {
      url = BASE + "/tag/" + tid.substring(2) + "/" + (p > 1 ? "page/" + p + "/" : "");
    } else {
      const nav = NAV.find((n) => n.id === tid) || NAV[0];
      url = BASE + nav.path + (p > 1 ? "page/" + p + "/" : "") + nav.query;
    }

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    // 列表阶段用一次 REST 批量判断每篇的媒体构成
    const cls = await this.classify(cards.map((c) => c.id));

    const list = cards
      .map((c) => {
        const k = cls && cls[c.id];
        const known = !!(k && (k.vids > 0 || k.imgs > 0));
        // 只有视频 → 直接进详情播放
        if (known && k.vids > 0 && k.imgs === 0) {
          return { vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: k.vids + " 个视频" };
        }
        // 只有图集 → 点卡片直接开画廊
        if (known && k.vids === 0 && k.imgs > 0) {
          return {
            vod_id: c.url,
            vod_name: c.title,
            vod_pic: c.pic,
            vod_remarks: "图集 · " + k.imgs + " 张",
            action: "gal:" + c.url,
          };
        }
        // 混合
        if (known) {
          return {
            vod_id: "mix|" + c.url,
            vod_name: c.title,
            vod_pic: c.pic,
            vod_remarks: k.vids + " 视频 · " + k.imgs + " 图",
            vod_tag: "folder",
          };
        }
        // REST 没给出信息（部分帖子视频是插件渲染的，REST content 是空的）
        // → 按卡片自带的 format-video 判断，绝不因为「没探测到」就丢掉
        if (c.isVideo) {
          return { vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: "视频" };
        }
        // 既不是视频格式、REST 也说没图 → 纯文字帖（Blog），丢掉
        return null;
      })
      .filter(Boolean);

    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const id = String(raw);
      let pageUrl = "";
      let idx = 0;
      if (id.indexOf("v|") === 0) {
        const parts = id.split("|");
        pageUrl = parts[1] || "";
        idx = Number(parts[2]) || 0;
      } else {
        pageUrl = id.indexOf("http") === 0 ? id : BASE + id;
      }

      let title = "";
      let pic = "";
      let content = "";
      let playUrl = "正片$" + (id.indexOf("v|") === 0 ? id : "v|" + pageUrl + "|0");
      const html = await this.fetchPage(pageUrl);
      if (html) {
        const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
        if (h1) title = clean(h1[1]);
        const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
        if (og) pic = og[1];
        const vids = parseVideos(html);
        const imgs = parseImages(html);
        content = "视频 " + vids.length + " 个 · 图集 " + imgs.length + " 张";
        // 多个视频 → 选集
        if (vids.length > 1) {
          playUrl = vids.map((v, i) => "版本 " + (i + 1) + "$v|" + pageUrl + "|" + i).join("#");
        } else if (vids.length === 1) {
          playUrl = "正片$v|" + pageUrl + "|0";
        }
      }

      const vid = id.indexOf("v|") === 0 ? id : "v|" + pageUrl + "|0";
      list.push({
        vod_id: vid,
        vod_name: title || "Cosplay",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "NudeCosplayGirls",
        vod_play_url: playUrl,
      });
      void idx;
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const s = String(id);
    let pageUrl = "";
    let idx = 0;
    if (s.indexOf("v|") === 0) {
      const parts = s.split("|");
      pageUrl = parts[1] || "";
      idx = Number(parts[2]) || 0;
    } else {
      pageUrl = s.indexOf("http") === 0 ? s : BASE + s;
    }

    const html = await this.fetchPage(pageUrl);
    if (!html) throw new Error("打不开帖子页");

    const vids = parseVideos(html);
    if (vids.length === 0) throw new Error("该帖没有视频");
    const url = vids[Math.min(idx, vids.length - 1)];

    return {
      parse: 0,
      url: url,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async action(op, value) {
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("gal|") !== 0 && s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    const html = await this.fetchPage(u);
    if (!html) return { msg: "打不开帖子页" };

    const imgs = parseImages(html);
    if (imgs.length === 0) return { msg: "这个帖子没有图片" };

    let title = "";
    const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
    if (h1) title = clean(h1[1]);

    const purl = GAL + "?u=" + encodeURIComponent(u);
    const hash = "#t=" + encodeURIComponent(title) + "&i=" + esc(imgs.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/" + (p > 1 ? "page/" + p + "/" : "") + "?s=" + encodeURIComponent(key);

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const cls = await this.classify(cards.map((c) => c.id));
    const list = cards
      .map((c) => {
        const k = cls && cls[c.id];
        const known = !!(k && (k.vids > 0 || k.imgs > 0));
        if (known && k.vids > 0 && k.imgs === 0) {
          return { vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: k.vids + " 个视频" };
        }
        if (known && k.vids === 0 && k.imgs > 0) {
          return {
            vod_id: c.url,
            vod_name: c.title,
            vod_pic: c.pic,
            vod_remarks: "图集 · " + k.imgs + " 张",
            action: "gal:" + c.url,
          };
        }
        if (known) {
          return {
            vod_id: "mix|" + c.url,
            vod_name: c.title,
            vod_pic: c.pic,
            vod_remarks: k.vids + " 视频 · " + k.imgs + " 图",
            vod_tag: "folder",
          };
        }
        if (c.isVideo) {
          return { vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: "视频" };
        }
        return null;
      })
      .filter(Boolean);
    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
