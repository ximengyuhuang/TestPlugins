import { Spider, openWeb } from "catvod";

// SFM Compile（sfmcompile.club）—— WordPress + Bimber 主题
// 列表 /page/N/、分类 /category/<slug>/page/N/、详情 /<slug>/
// 每篇一个 1280x720 的 mp4（<video src>），封面 608x342
// 99 个游戏分类 + 若干角色子分类；支持 ?order=most_views
// ⚠ 直连不通，手机需代理

const BASE = "https://sfmcompile.club";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PAGE_SIZE = 8;

const ORDERS = [
  { n: "最新", v: "" },
  { n: "最多播放", v: "most_views" },
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
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 列表卡片：<article id="post-123" class="entry-tpl-stream …">
//   标题 <h2 class="… entry-title"><a href="…">T</a></h2>
//   封面 <img … data-src="…-608x342.jpg">
//   播放量 <span class="entry-views…"><strong>10.8k</strong>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<article id="post-\d+"/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 6000);
    const link = block.match(/class="[^"]*entry-title[^"]*"[^>]*>\s*<a href="([^"]+)"/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const tm = block.match(/class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]*>([\s\S]{0,200}?)<\/a>/);
    const title = clean(tm ? tm[1] : "");
    if (!title) continue;

    // 封面：首页卡片是内联 <video data-poster-image="…jpg">，分类页是 <img data-src="…jpg">
    // 注意别把 <video data-src="…mp4"> 当封面
    const img =
      block.match(/data-poster-image="([^"]+)"/) ||
      block.match(/data-src="(https:\/\/[^"]+?\.(?:jpe?g|png|webp))"/) ||
      block.match(/src="(https:\/\/sfmcompile\.club\/wp-content\/uploads\/[^"]+?\.(?:jpe?g|png|webp))"/);
    const views = block.match(/class="entry-views[^"]*"[^>]*>\s*<strong>([^<]+)</);
    const cats = [...block.matchAll(/class="entry-category[^"]*"[^>]*>([^<]{1,40})</g)].map((m) => clean(m[1])).filter(Boolean);

    out.push({
      url: url,
      title: title,
      pic: img ? img[1] : "",
      views: views ? views[1] : "",
      cats: cats.filter((c, i, a) => a.indexOf(c) === i).slice(0, 2).join(" / "),
    });
  }
  return out;
}

// 详情页取 mp4：优先 <video src>，兜底 JSON-LD 的 contentUrl
function parseVideo(html) {
  const h = String(html);
  const v = h.match(/<video[^>]+src="([^"]+\.mp4[^"]*)"/);
  if (v) return v[1];
  const j = h.match(/"contentUrl":"([^"]+\.mp4[^"]*)"/);
  if (j) return j[1].replace(/\\\//g, "/");
  const any = h.match(/(https:\/\/sfmcompile\.club\/wp-content\/uploads\/[^"'\s]+?\.mp4)/);
  return any ? any[1] : "";
}

export default class Sfm extends Spider {
  init(extend) {
    this.catCache = null;
    this.log("sfmcompile ready");
  }

  // 99 个分类：/all-category/ 是「图片瓦片」列表
  //   <a class="g1-term…" href="…/category/overwatch/" data-bg="…">
  //     <h4 class="g1-term-title">Overwatch</h4><strong>8125</strong> entries
  async loadCats() {
    if (this.catCache && this.catCache.length) return this.catCache;
    const list = [];
    const seen = {};
    try {
      const r = await this.net.req(BASE + "/all-category/", { headers: hdrs() });
      if (r && r.code === 200) {
        const re =
          /href="https:\/\/sfmcompile\.club\/category\/([^"\/]+)\/"[^>]*>[\s\S]{0,500}?<h4[^>]*class="[^"]*g1-term-title[^"]*"[^>]*>([\s\S]{0,80}?)<\/h4>[\s\S]{0,200}?<strong>(\d+)<\/strong>/g;
        let m;
        while ((m = re.exec(r.content)) !== null) {
          const slug = m[1];
          if (seen[slug]) continue;
          seen[slug] = 1;
          list.push({ slug: slug, name: clean(m[2]) || slug, count: Number(m[3]) || 0 });
        }
        // 兜底：老结构（文字链）
        if (list.length === 0) {
          const re2 = /href="https:\/\/sfmcompile\.club\/category\/([^"\/]+)\/"[^>]*>([\s\S]{1,80}?)<\/a>/g;
          let n;
          while ((n = re2.exec(r.content)) !== null) {
            if (seen[n[1]]) continue;
            seen[n[1]] = 1;
            list.push({ slug: n[1], name: clean(n[2]) || n[1], count: 0 });
          }
        }
      }
    } catch (e) {
      this.log("category fetch failed: " + e);
    }
    list.sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : 1));
    this.catCache = list;
    return list;
  }

  groupLetters(list) {
    const g = {};
    for (const c of list) {
      const ch = String(c.slug).charAt(0).toUpperCase();
      const key = ch >= "A" && ch <= "Z" ? ch : "#";
      (g[key] = g[key] || []).push(c);
    }
    return Object.keys(g)
      .sort()
      .map((k) => ({ key: k, items: g[k] }));
  }

  async homeContent(filter) {
    await this.loadCats();
    const classes = [
      { type_id: "latest", type_name: "最新", type_flag: "1" },
      { type_id: "catf", type_name: "分类 (" + (this.catCache ? this.catCache.length : 0) + ")", type_flag: "1" },
      { type_id: "web", type_name: "网页", type_flag: "1" },
    ];
    const filters = {};
    for (const c of classes) {
      if (c.type_id === "catf" || c.type_id === "web") continue;
      filters[c.type_id] = [{ key: "order", name: "排序", value: ORDERS }];
    }
    for (const c of this.catCache) {
      filters["c:" + c.slug] = [{ key: "order", name: "排序", value: ORDERS }];
    }
    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const order = (extend && extend.order) || "";
    const q = order ? "?order=" + order : "";

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 分类信封：字母层
    if (tid === "catf") {
      await this.loadCats();
      const list = this.groupLetters(this.catCache).map((g) => ({
        vod_id: "seg:" + g.key,
        vod_name: g.key,
        vod_pic: "",
        vod_remarks: g.items.length + " 个",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    if (tid.indexOf("seg:") === 0) {
      await this.loadCats();
      const key = tid.substring(4);
      const g = this.groupLetters(this.catCache).find((x) => x.key === key);
      const list = (g ? g.items : []).map((c) => ({
        vod_id: "c:" + c.slug,
        vod_name: c.name,
        vod_pic: "",
        vod_remarks: "分类",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url;
    if (tid === "latest" || !tid) {
      url = BASE + "/" + (p > 1 ? "page/" + p + "/" : "") + q;
    } else {
      const slug = tid.indexOf("c:") === 0 ? tid.substring(2) : tid;
      url = BASE + "/category/" + slug + "/" + (p > 1 ? "page/" + p + "/" : "") + q;
    }

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const list = cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: [c.views ? c.views + " 次" : "", c.cats].filter(Boolean).join(" · ") || "视频",
    }));

    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const pageUrl = String(raw).indexOf("http") === 0 ? String(raw) : BASE + String(raw);
      let title = "";
      let pic = "";
      let content = "";
      let url = "";

      try {
        const r = await this.net.req(pageUrl, { headers: hdrs() });
        if (r && r.code === 200) {
          const html = r.content;
          const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
          title = h1 ? clean(h1[1]) : "";
          const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
          if (og) pic = og[1];
          url = parseVideo(html);

          const cats = [...new Set([...html.matchAll(/class="entry-category[^"]*"[^>]*>([^<]{1,40})</g)].map((m) => clean(m[1])))];
          const tags = [...new Set([...html.matchAll(/href="https:\/\/sfmcompile\.club\/tag\/([^"\/]+)\/"/g)].map((m) => decodeURIComponent(m[1])))];
          const artist = html.match(/Artist:\s*([^\s<]{1,40})/);
          const lines = [];
          if (artist) lines.push("作者: " + artist[1]);
          if (cats.length) lines.push("分类: " + cats.slice(0, 4).join(" / "));
          if (tags.length) lines.push("标签: " + tags.filter((t) => !/^\d+secs|\+$/.test(t)).slice(0, 8).join(" / "));
          content = lines.join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || "SFM Clip",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "SFM Compile",
        vod_play_url: "正片$" + (url || pageUrl),
      });
    }
    return { list: list };
  }

  // vod_play_url 里给的是 mp4 直链时直接用；否则回页面里再取一次
  async playerContent(flag, id, vipFlags) {
    const s = String(id);
    if (/\.mp4(\?|$)/i.test(s)) {
      return {
        parse: 0,
        url: s,
        header: { "User-Agent": UA, "Referer": BASE + "/" },
      };
    }
    const pageUrl = s.indexOf("http") === 0 ? s : BASE + s;
    const r = await this.net.req(pageUrl, { headers: hdrs() });
    if (!r || r.code !== 200) throw new Error("打不开详情页");
    const url = parseVideo(r.content);
    if (!url) throw new Error("没有找到视频地址");
    return {
      parse: 0,
      url: url,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/" + (p > 1 ? "page/" + p + "/" : "") + "?s=" + encodeURIComponent(key);

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const list = cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: [c.views ? c.views + " 次" : "", c.cats].filter(Boolean).join(" · ") || "视频",
    }));
    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
