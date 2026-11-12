import { Spider, openWeb } from "catvod";

// 色圖網（photos18.com）—— Yii2 图集站，纯图片
// 分类（用户拍板）：最新 | 最火 | 推薦 | 20 个分类全平铺 | 搜索 | 网页
//   列表    /           翻页 ?page=N&per-page=M
//   排序    /sort/created 最新 · /sort/views 最火 · /sort/score 推薦
//   分类    /cat/<id>
//   详情    /v/<短ID>
//   图集    <a href="https://img.photos18.com/images/image/<前缀>/<id>.webp?0" data-fancybox="gallery">
//   封面    /images/node/xx/xxxx.avif
// ⚠ 整站在 Cloudflare 管理挑战后面（我这边 403），手机上大概率能开

const BASE = "https://www.photos18.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PER_PAGE = 30;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8",
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

// 卡片：<div class="card"> … <a class="visited" href="…/v/AyRE7">
//   <img src="…/images/node/96/965155.avif">
//   <div class="card-body"><a href="…/v/AyRE7">标题</a> <label class="badge">極品美女</label>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<div class="card">/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 3000);
    const link = block.match(/href="((?:https:\/\/www\.photos18\.com)?\/v\/[A-Za-z0-9]+)"/);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;

    // 标题：card-body 里指向同一个 /v/ 的锚点文字
    let title = "";
    const idTail = link[1].split("/").pop();
    const tm = block.match(new RegExp('href="[^"]*/v/' + idTail + '"[^>]*>([\\s\\S]{0,200}?)<\\/a>', "i"));
    if (tm) title = clean(tm[1]);
    if (!title) {
      const am = block.match(/<img[^>]+alt="([^"]{2,})"/);
      if (am) title = clean(am[1]);
    }
    if (!title) continue;
    seen[url] = 1;

    const pic = block.match(/<img[^>]+src="([^"]+)"/);
    const badge = block.match(/class="badge[^"]*"[^>]*>([\s\S]{0,30}?)<\/label>/);

    out.push({
      url: url,
      title: title,
      pic: pic ? abs(pic[1]) : "",
      cat: badge ? clean(badge[1]) : "",
    });
  }
  return out;
}

// 相册页图集
function parseGallery(html) {
  const out = [];
  const seen = {};
  const re = /href="(https?:\/\/img\.photos18\.com\/images\/image\/[^"?]+?\.(?:webp|jpe?g|avif|png))/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const u = m[1];
    if (seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

export default class Photos18 extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.cats = null;
    this.log("photos18 ready");
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

  // 20 个分类（带数量）：首页侧栏 <a href="…/cat/11"><p>極品美女 (147414)</p></a>
  async loadCats() {
    if (this.cats && this.cats.length) return this.cats;
    const html = await this.fetchPage(BASE + "/");
    const list = [];
    const seen = {};
    const re = /href="(?:https:\/\/www\.photos18\.com)?\/cat\/(\d+)"[^>]*>[\s\S]{0,120}?<p>([\s\S]{0,60}?)<\/p>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (seen[id]) continue;
      const text = clean(m[2]);
      if (!text) continue;
      seen[id] = 1;
      const c = text.match(/^(.*?)\s*[（(](\d+)[)）]/);
      list.push({ id: id, name: c ? c[1] : text, count: c ? Number(c[2]) : 0 });
    }
    this.cats = list;
    return list;
  }

  async homeContent(filter) {
    let cats = [];
    try {
      cats = await this.loadCats();
    } catch (e) {
      this.log("loadCats failed: " + e);
    }
    const classes = [
      { type_id: "created", type_name: "最新", type_flag: "0" },
      { type_id: "views", type_name: "最火", type_flag: "0" },
      { type_id: "score", type_name: "推薦", type_flag: "0" },
    ];
    for (const c of cats) {
      classes.push({ type_id: "cat:" + c.id, type_name: c.name, type_flag: "0" });
    }
    classes.push({ type_id: "search", type_name: "搜索", type_flag: "1" });
    classes.push({ type_id: "web", type_name: "网页", type_flag: "1" });
    return { class: classes };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.cat || "图集",
      action: "gal:" + c.url,
    }));
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    void filter;
    void extend;

    if (tid === "web" || tid === "search") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PER_PAGE, 0);
    }

    let url;
    const q = "?page=" + p + "&per-page=" + PER_PAGE;
    if (tid.indexOf("cat:") === 0) {
      url = BASE + "/cat/" + tid.substring(4) + q;
    } else {
      url = BASE + "/sort/" + tid + q;
    }

    const html = await this.fetchPage(url);
    if (!html) return this.page([], p, PER_PAGE, (p - 1) * PER_PAGE);
    const cards = parseCards(html);
    if (cards.length === 0) return this.page([], p, PER_PAGE, (p - 1) * PER_PAGE);
    return this.page(this.cardsToList(cards), p, PER_PAGE, (p + 1) * PER_PAGE);
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
        if (t) title = clean(t[1]);
        const imgs = parseGallery(html);
        if (imgs.length) pic = imgs[0];
        content = "图集 " + imgs.length + " 张";
      }
      list.push({
        vod_id: pageUrl,
        vod_name: title || "色圖網",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "色圖網",
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
    if (t) title = clean(t[1]);

    const purl = GAL + "?u=" + encodeURIComponent(u);
    // 同一相册的图都在一个目录 → 用 ?b= 压缩
    const cut = imgs[0].lastIndexOf("/");
    const dir = cut > 0 ? imgs[0].substring(0, cut) : "";
    const sameDir = dir && imgs.every((x) => x.substring(0, cut) === dir);
    const entries = sameDir ? imgs.map((x) => x.substring(cut)) : imgs;
    const bq = sameDir ? "&b=" + encodeURIComponent(dir) : "";

    const hash = "#t=" + encodeURIComponent(title) + bq + "&i=" + esc(entries.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url =
      BASE + "/?q=" + encodeURIComponent(key) + "&category_id=&page=" + p + "&per-page=" + PER_PAGE;
    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PER_PAGE, 0);
    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PER_PAGE, (p - 1) * PER_PAGE);
    return this.page(this.cardsToList(cards), p, PER_PAGE, (p + 1) * PER_PAGE);
  }
}
