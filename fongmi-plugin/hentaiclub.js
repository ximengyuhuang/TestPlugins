import { Spider, openWeb } from "catvod";

// 绅士会所（hentaiclub.net）—— 自研平台，纯图集站（无视频）
// 分类：最新 | R-15 | R-18 | 标签 | 搜索 | 网页
//   最新   /page/<N>/                 25 条/页
//   分类   /sort/r15.html             分页 /sort/r15.html/<N>/（1012 页）
//   标签   /tagshow.html → 3103 个    分组后 /tag/<名字>/<N>/（25 条/页）
//   搜索   /search/<关键词>/<N>/
//   详情   /r15|r18/<id>.html         data-fancybox 的 data-src 就是原图（cdn.sshs.rip，webp）
// ✅ 直连可用；图片无防盗链

const BASE = "https://www.hentaiclub.net";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 25;

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
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

// 卡片：<div class="item col-xs-6 …">
//   <img class="item-img lazy" data-original="…webp" alt="标题">
//   <div class="item-title"><a class="item-link" href="…/r15/71396.html">
//     <div class="item-link-text">标题</div></a> … <span class="item-num"> [30P] …</span>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<div class="item col-/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 2200);
    const link = block.match(/href="((?:https:\/\/www\.hentaiclub\.net)?\/r1[58]\/\d+\.html)"/);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;

    let title = "";
    const tm = block.match(/class="item-link-text"[^>]*>([\s\S]{0,160}?)<\/div>/);
    if (tm) title = clean(tm[1]);
    if (!title) {
      const am = block.match(/<img[^>]+alt="([^"]*)"/);
      if (am) title = clean(am[1]);
    }
    if (!title) continue;
    seen[url] = 1;

    const pic = block.match(/data-original="([^"]+)"/) || block.match(/<img[^>]+src="(https:\/\/[^"]+)"/);
    const cnt = block.match(/\[(\d+)P\]/);
    const sort = block.match(/class="item-sort"[^>]*>([^<]{1,10})</);

    out.push({
      url: url,
      title: title,
      pic: pic ? pic[1] : "",
      count: cnt ? Number(cnt[1]) : 0,
      sort: sort ? clean(sort[1]) : "",
    });
  }
  return out;
}

// 详情页图集：data-fancybox 的 data-src
function parseGallery(html) {
  const out = [];
  const seen = {};
  const re = /data-src="(https?:\/\/cdn\.[^"]+?\.(?:webp|jpe?g|png|gif))"/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const u = m[1];
    if (seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  if (out.length === 0) {
    // 兜底：正文里的懒加载图
    const re2 = /data-original="(https?:\/\/cdn\.[^"]+?\.(?:webp|jpe?g|png|gif))"/g;
    while ((m = re2.exec(String(html))) !== null) {
      const u = m[1];
      if (seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
  }
  return out;
}

export default class HentaiClub extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.tagCache = null;
    this.log("hentaiclub ready");
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
        { type_id: "latest", type_name: "最新", type_flag: "0" },
        { type_id: "r15", type_name: "R-15", type_flag: "0" },
        { type_id: "r18", type_name: "R-18", type_flag: "0" },
        { type_id: "tagf", type_name: "标签", type_flag: "1" },
        { type_id: "search", type_name: "搜索", type_flag: "1" },
        { type_id: "web", type_name: "网页", type_flag: "1" },
      ],
    };
  }

  // 3103 个标签：只抓一次标签云
  async loadTags() {
    if (this.tagCache && this.tagCache.length) return this.tagCache;
    const html = await this.fetchPage(BASE + "/tagshow.html");
    const list = [];
    const seen = {};
    const re = /href="(?:https:\/\/www\.hentaiclub\.net)?\/tag\/([^"\/]+)\/?"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1];
      let name = raw;
      try {
        name = decodeURIComponent(raw);
      } catch (e) {}
      if (seen[name]) continue;
      seen[name] = 1;
      list.push({ slug: raw, name: name });
    }
    this.tagCache = list;
    return list;
  }

  groupByFirstChar(tags) {
    const g = {};
    for (const t of tags) {
      let ch = String(t.name).charAt(0).toUpperCase();
      // 只保留字母/数字，其余（中文、符号）归到「其他」
      const key = /[A-Z0-9]/.test(ch) ? ch : "其他";
      (g[key] = g[key] || []).push(t);
    }
    const keys = Object.keys(g).sort((a, b) => {
      if (a === "其他") return 1;
      if (b === "其他") return -1;
      return a < b ? -1 : 1;
    });
    return keys.map((k) => ({ key: k, items: g[k] }));
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: this.coverPic(c.pic),
      vod_remarks: [c.count ? c.count + "P" : "", c.sort].filter(Boolean).join(" · ") || "图集",
      action: "gal:" + c.url,
    }));
  }

  // 封面走本地代理：App 原生图片加载器可能被 CDN 挡（8se 就是这么修好的）
  coverPic(pic) {
    if (!pic) return "";
    try {
      return this.proxyUrl({ u: pic });
    } catch (e) {
      return pic;
    }
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

  async proxy(params) {
    const u = (params && (params.u || params.url)) || "";
    if (!u) return [404, "text/plain", "no url"];
    const h = hdrs();
    h["Accept"] = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
    try {
      const st = await this.net.openStream(u, { headers: h });
      const bytes = await this.readBytes(st);
      if (!bytes || bytes.length === 0) return [404, "text/plain", "empty"];
      let mime = "image/webp";
      if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
      else if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = "image/png";
      return [200, mime, bytes];
    } catch (e) {
      this.log("cover proxy failed: " + e);
      return [404, "text/plain", "fail"];
    }
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
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 标签层
    if (tid === "tagf") {
      const tags = await this.loadTags();
      const groups = this.groupByFirstChar(tags);
      const list = groups.map((g) => ({
        vod_id: "tg:" + g.key,
        vod_name: g.key,
        vod_pic: "",
        vod_remarks: g.items.length + " 个",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }
    if (tid.indexOf("tg:") === 0) {
      const tags = await this.loadTags();
      const groups = this.groupByFirstChar(tags);
      const key = tid.substring(3);
      const g = groups.find((x) => x.key === key);
      const list = (g ? g.items : []).map((t) => ({
        vod_id: "t:" + t.name,
        vod_name: t.name,
        vod_pic: "",
        vod_remarks: "标签",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url;
    if (tid.indexOf("t:") === 0) {
      const name = tid.substring(2);
      url = BASE + "/tag/" + encodeURIComponent(name) + "/" + (p > 1 ? p + "/" : "");
    } else if (tid === "r15" || tid === "r18") {
      url = BASE + "/sort/" + tid + ".html" + (p > 1 ? "/" + p + "/" : "");
    } else {
      url = BASE + "/page/" + p + "/";
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
      const html = await this.fetchPage(pageUrl);
      if (html) {
        const t = html.match(/<title>([^<]*)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*-\s*绅士会所\s*$/, "");
        const imgs = parseGallery(html);
        if (imgs.length) pic = imgs[0];
        content = "图集 " + imgs.length + " 张";
      }
      list.push({
        vod_id: pageUrl,
        vod_name: title || "绅士会所",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "绅士会所",
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
    if (s.indexOf("gal|") !== 0 && s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    const html = await this.fetchPage(u);
    if (!html) return { msg: "打不开这个图集" };

    const imgs = parseGallery(html);
    if (imgs.length === 0) return { msg: "这个图集没抓到图片" };

    let title = "";
    const t = html.match(/<title>([^<]*)<\/title>/);
    if (t) title = clean(t[1]).replace(/\s*-\s*绅士会所\s*$/, "");

    const purl = GAL + "?u=" + encodeURIComponent(u) + "&_gv=20261113b";
    const hash = "#t=" + encodeURIComponent(title) + "&i=" + esc(imgs.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search/" + encodeURIComponent(key) + "/" + (p > 1 ? p + "/" : "");

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
