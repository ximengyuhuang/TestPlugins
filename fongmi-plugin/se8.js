import { Spider, openWeb } from "catvod";

// 8se.me（8色人体摄影）—— xchina 网络的姊妹站，纯图集站
// 分类：最新 | 分类(8) | 搜索 | 网页
// 站点结构：
//   最新      /photos/<p>.html
//   分类      /categories.html → 8 个分类 → /photos|videos/series-<id>.html（p>1 为 /series-<id>/<p>.html）
//   相册      /photo/id-<hash>.html（p>1 为 /photo/id-<hash>/<p>.html）
//   图片      https://img.xchina.io/photos/<hash>/0001_600x0.webp（原图 0001.jpg）
// ⚠ 整站在 Cloudflare 管理挑战后面：要先点「网页」过验证，插件再带 cookie 请求

const BASE = "https://8se.me";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 12;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/",
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

// 封面：站点可能用 background-image / data-bg / <img src> 三种写法，逐个兜
function pickPic(block) {
  const cands = [];
  const b1 = block.match(/background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  if (b1) cands.push(b1[1]);
  const d1 = block.match(/data-(?:background[_-]image|bg|original|src)="([^"]+)"/);
  if (d1) cands.push(d1[1].split(/[\s,]+/)[0]);
  const s1 = block.match(/data-srcset="([^"]+)"/);
  if (s1) cands.push(s1[1].split(/[\s,]+/)[0]);
  const i1 = block.match(/<img[^>]+src="([^"]+)"/);
  if (i1) cands.push(i1[1]);
  const any = block.match(/(https?:\/\/[^"'\s)]+?\.(?:webp|jpe?g|png))/);
  if (any) cands.push(any[1]);
  for (const c of cands) {
    if (c && c.indexOf("data:") !== 0 && c.indexOf("//") > 0) return c;
  }
  return "";
}

// 卡片：<div class="item photo"> … <a href="/photo/id-xxx.html" title="标题">
//   <div class="img" style="background-image:url('…/00021_600x0.webp')">
//   <div class="tags"><div>30P</div>
function parseCards(html) {
  const out = [];
  const seen = {};
  const src = String(html);
  const parts = src.split(/<div class="item /).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 3000);
    const link = block.match(/href="((?:https:\/\/8se\.me)?\/(?:photo|video)\/id-[^"]+)"/);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;

    let title = "";
    const tm = block.match(/<a[^>]+href="[^"]*\/id-[^"]*"[^>]*title="([^"]*)"/);
    if (tm) title = clean(tm[1]);
    if (!title) {
      const t2 = block.match(/class="title"[^>]*>\s*<a[^>]*>([\s\S]{0,120}?)<\/a>/);
      if (t2) title = clean(t2[1]);
    }
    if (!title) continue;
    seen[url] = 1;

    const cnt = block.match(/<div>(\d+)P<\/div>/);
    const sub = block.match(/class="subs"[\s\S]{0,200}?<div>\s*<a[^>]*>([\s\S]{0,40}?)<\/a>/);

    out.push({
      url: url,
      title: title,
      pic: pickPic(block),
      count: cnt ? Number(cnt[1]) : 0,
      cat: sub ? clean(sub[1]) : "",
      isVideo: url.indexOf("/video/") >= 0,
    });
  }
  return out;
}

// 相册页里的图片：<div class="img" style="background-image:url('…/photos/<hash>/0001_600x0.webp')">
function parseAlbumImgs(html, hash) {
  const out = [];
  const seen = {};
  const re = /background-image:\s*url\('(https:\/\/[^']*?\/photos\/[^']*?\/[0-9]+(?:_\d+x\d+)?\.(?:webp|jpg|jpeg|png))'\)/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    let u = m[1];
    if (hash && u.indexOf("/" + hash + "/") < 0) continue;
    if (seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

export default class Se8 extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.catCache = null;
    this.log("8se ready");
  }

  cacheGet(url) {
    const c = this.htmlCache && this.htmlCache[url];
    return c && Date.now() - c.ts < 180000 ? c.html : "";
  }

  cacheSet(url, html) {
    this.htmlCache = this.htmlCache || {};
    this.htmlCache[url] = { html: html, ts: Date.now() };
  }

  // 统一请求：带 WebView 里的 cookie；被 CF 拦下就提示先过验证
  async fetch(url) {
    const hit = this.cacheGet(url);
    if (hit) return hit;

    const h = hdrs();
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
      body.indexOf("Attention Required") >= 0 ||
      body.length < 1500;

    if (blocked) {
      throw new Error("被 Cloudflare 拦住：请先点「网页」完成验证，再回来刷新");
    }
    this.cacheSet(url, body);
    return body;
  }

  async homeContent(filter) {
    return {
      class: [
        { type_id: "latest", type_name: "最新", type_flag: "0" },
        { type_id: "catf", type_name: "分类", type_flag: "1" },
        { type_id: "search", type_name: "搜索", type_flag: "1" },
        { type_id: "web", type_name: "网页", type_flag: "1" },
      ],
    };
  }

  // 8 个分类（/categories.html）
  async loadCats() {
    if (this.catCache && this.catCache.length) return this.catCache;
    const html = await this.fetch(BASE + "/categories.html");
    const list = [];
    const seen = {};
    const re = /<a[^>]+href="(https:\/\/8se\.me\/(?:photos|videos)\/series-[^"]+)"[^>]*>([\s\S]{0,80}?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[1];
      if (seen[url]) continue;
      const text = clean(m[2]);
      if (!text) continue;
      seen[url] = 1;
      const c = text.match(/^(.*?)\s*\((\d+)\)/);
      list.push({
        url: url,
        name: c ? c[1] : text,
        count: c ? Number(c[2]) : 0,
      });
    }
    this.catCache = list;
    return list;
  }

  cardsToList(cards) {
    const out = [];
    for (const c of cards) {
      const remark = [c.count ? c.count + "P" : "", c.cat].filter(Boolean).join(" · ");
      if (c.isVideo) {
        // 视频类相册：先给详情，播放时尽力解析
        out.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: remark || "视频" });
        continue;
      }
      out.push({
        vod_id: c.url,
        vod_name: c.title,
        vod_pic: c.pic,
        vod_remarks: remark || "图集",
        action: "gal:" + c.url,
      });
    }
    return out;
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
        openWeb({ url: BASE + "/search.html" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 分类层
    if (tid === "catf") {
      const cats = await this.loadCats();
      const list = cats.map((c) => ({
        vod_id: "c:" + c.url,
        vod_name: c.name,
        vod_pic: "",
        vod_remarks: c.count ? c.count + " 本" : "分类",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url;
    if (tid.indexOf("c:") === 0) {
      const base = tid.substring(2); // .../series-xxx.html
      url = p <= 1 ? base : base.replace(/\.html$/, "/" + p + ".html");
    } else {
      url = BASE + "/photos/" + p + ".html";
    }

    const html = await this.fetch(url);
    const cards = parseCards(html);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    return this.page(this.cardsToList(cards), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  // 把一个相册的所有分页都抓下来，返回原图地址
  async collectAlbum(pageUrl) {
    const hashM = pageUrl.match(/id-([0-9a-z]+)/i);
    const hash = hashM ? hashM[1] : "";
    const out = [];
    const seen = {};
    for (let p = 1; p <= 30; p++) {
      const u = p <= 1 ? pageUrl : pageUrl.replace(/\.html$/, "/" + p + ".html");
      let html = "";
      try {
        html = await this.fetch(u);
      } catch (e) {
        break;
      }
      if (!html) break;
      const imgs = parseAlbumImgs(html, hash);
      let added = 0;
      for (const img of imgs) {
        // 统一换原图：…/0001_600x0.webp → …/0001.jpg
        let full = img;
        if (/_600x0\.webp$/i.test(full)) full = full.replace(/_600x0\.webp$/i, ".jpg");
        else full = full.replace(/_\d+x\d+\.(webp|jpg|jpeg|png)$/i, ".$1");
        if (seen[full]) continue;
        seen[full] = 1;
        out.push(full);
        added++;
      }
      if (added === 0) break;
    }
    return out;
  }

  async action(op, value) {
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("gal|") !== 0 && s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const pageUrl = s.substring(4);

    const imgs = await this.collectAlbum(pageUrl);
    if (imgs.length === 0) return { msg: "这个相册没抓到图片（可能需要先点「网页」过验证）" };

    let title = "";
    try {
      const first = await this.fetch(pageUrl);
      const t = first.match(/<title>([^<]*)<\/title>/);
      if (t) title = clean(t[1]).replace(/\s*-\s*8色人体摄影\s*$/, "");
    } catch (e) {
      /* 忽略 */
    }

    const purl = GAL + "?u=" + encodeURIComponent(pageUrl);
    // 同一相册的图都在 /photos/<hash>/ 下 → 用 ?b= 传公共前缀，片段里只放文件名
    const cut = imgs[0].lastIndexOf("/");
    const dir = cut > 0 ? imgs[0].substring(0, cut) : "";
    const sameDir = dir && imgs.every((x) => x.substring(0, cut) === dir);
    const entries = sameDir ? imgs.map((x) => x.substring(cut)) : imgs;
    const bq = sameDir ? "&b=" + encodeURIComponent(dir) : "";

    const hash = "#t=" + encodeURIComponent(title) + bq + "&i=" + esc(entries.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const id = String(raw);
      const pageUrl = id.indexOf("http") === 0 ? id : BASE + id;
      let title = "";
      let pic = "";
      let content = "";
      let playUrl = "正片$" + pageUrl;
      try {
        const html = await this.fetch(pageUrl);
        const t = html.match(/<title>([^<]*)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*-\s*8色人体摄影\s*$/, "");
        const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
        if (og) pic = og[1];
        const vids = [];
        const mv = html.match(/<video[^>]+src="([^"]+)"/) || html.match(/"(https?:\/\/[^"]+?\.m3u8[^"]*)"/);
        if (mv) vids.push(mv[1]);
        content = vids.length ? "视频 " + vids.length + " 个" : "图集";
        if (vids.length) playUrl = "正片$" + pageUrl;
      } catch (e) {
        this.log("detail failed: " + e);
      }
      list.push({
        vod_id: pageUrl,
        vod_name: title || "8se",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "8se",
        vod_play_url: playUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const s = String(id);
    const pageUrl = s.indexOf("http") === 0 ? s : BASE + s;
    if (/\.(mp4|m3u8)(\?|$)/i.test(s)) {
      return { parse: 0, url: s, header: { "User-Agent": UA, "Referer": BASE + "/" } };
    }
    const html = await this.fetch(pageUrl);
    const mv = html.match(/<video[^>]+src="([^"]+)"/) || html.match(/"(https?:\/\/[^"]+?\.m3u8[^"]*)"/);
    if (!mv) throw new Error("没有找到视频地址（这是图集，请从卡片直接进图集）");
    return { parse: 0, url: mv[1], header: { "User-Agent": UA, "Referer": BASE + "/" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search/" + encodeURIComponent(key) + "/" + (p > 1 ? p + ".html" : "1.html");
    try {
      const html = await this.fetch(url);
      const cards = parseCards(html);
      if (cards.length > 0) return this.page(this.cardsToList(cards), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
    } catch (e) {
      this.log("search failed: " + e);
    }
    return this.page([], p, PAGE_SIZE, 0);
  }
}
