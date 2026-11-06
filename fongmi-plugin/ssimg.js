import { Spider, openWeb } from "catvod";

// 绅士俱乐部（ssimg.xyz）—— Typecho 1.2 + photograph 主题，纯图集站
// 结构：列表 https://ssimg.xyz/  /category/<slug>/?page=N   每页 18 篇
//       详情 /<分类>/<id>.html
//       图集全在 <div class="post-item" data-src="原图">，无分页、无防盗链、无会员墙
//       ⚠ 缩略图是懒加载：<img src="占位.webp" data-original="原图">

const BASE = "https://ssimg.xyz";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 画廊页（App 内 WebView 打开）
// 线上：https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html
// 本地调试改回：http://192.168.110.70:8000/gallery.html
const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 18;

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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 转义：只处理会破坏 URL 参数/片段的字符，保留 / : 等
function esc(s) {
  return String(s)
    .replace(/%/g, "%25")
    .replace(/&/g, "%26")
    .replace(/#/g, "%23")
    .replace(/\+/g, "%2B")
    .replace(/ /g, "%20");
}

// 列表卡片：<div class="item col-..."> 里含 封面 + item-link + 标题 + [NP]
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<div class="item\s/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 2000);
    const link = block.match(/class="item-link"\s+href="(https:\/\/ssimg\.xyz\/[a-z0-9]+\/\d+\.html)"/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const tm = block.match(/item-link-text">\s*([\s\S]{0,160}?)\s*<\/div>/);
    const cover = block.match(/data-original="([^"]+)"/);
    const num = block.match(/\[(\d+)P\]/);

    out.push({
      url: url,
      title: clean(tm ? tm[1] : "") || "未命名",
      pic: cover ? cover[1] : "",
      count: num ? Number(num[1]) : 0,
    });
  }
  return out;
}

// 详情页图集：<div data-fancybox="gallery" class="post-item ..." data-src="原图">
function parseImages(html) {
  const out = [];
  const seen = {};
  const re = /class="post-item[^"]*"[^>]*data-src="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const u = m[1];
    if (!u || seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

export default class Ssimg extends Spider {
  init(extend) {}

  async homeContent(filter) {
    const classes = [
      { type_id: "latest", type_name: "最新" },
      { type_id: "r15", type_name: "r15" },
      { type_id: "r18", type_name: "r18" },
      { type_id: "cos", type_name: "cos" },
      { type_id: "web", type_name: "网页" },
    ];
    return { class: classes };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    let url;
    if (tid === "latest" || !tid) {
      url = BASE + "/" + (p > 1 ? "?page=" + p : "");
    } else {
      // r15 / r18 / cos
      url = BASE + "/category/" + tid + "/" + (p > 1 ? "?page=" + p : "");
    }

    const r = await this.net.req(url, { headers: hdrs() });
    // 分页越界站点直接返回 404
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const list = cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.count ? "图集 · " + c.count + "张" : "图集",
      action: "gal:" + c.url,
    }));

    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  // 点卡片 → 抓详情页 → 把全部原图塞进画廊页（列表放 # 片段，绕开 Pages 8KB 请求行上限）
  async action(op, value) {
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    let imgs = [];
    let title = "";
    try {
      const r = await this.net.req(u, { headers: hdrs() });
      if (r && r.code === 200) {
        imgs = parseImages(r.content);
        const t = r.content.match(/<title>([^<]*)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*-\s*绅士俱乐部\s*$/, "");
      }
    } catch (e) {
      this.log("gallery prefetch failed: " + e);
    }

    if (imgs.length === 0) return { msg: "这个帖子没有图片" };

    const purl = GAL + "?u=" + encodeURIComponent(u);
    const hash = "#t=" + encodeURIComponent(title) + "&i=" + esc(imgs.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  // 卡片走 action，一般不落到详情；留一个兜底实现
  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const s = String(id);
      let title = "图集";
      let pic = "";
      let content = "";
      try {
        const r = await this.net.req(s, { headers: hdrs() });
        if (r && r.code === 200) {
          const t = r.content.match(/<title>([^<]*)<\/title>/);
          if (t) title = clean(t[1]).replace(/\s*-\s*绅士俱乐部\s*$/, "");
          const n = parseImages(r.content).length;
          const date = r.content.match(/日期：<\/span><span[^>]*>([^<]*)</);
          const og = r.content.match(/data-original="(https?:\/\/[^"]+)"/);
          if (og) pic = og[1];
          content = (date ? "日期: " + clean(date[1]) + "\n" : "") + "类型: 图集（" + n + " 张，点列表卡片直接打开画廊）";
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }
      list.push({
        vod_id: s,
        vod_name: title,
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "绅士俱乐部",
        vod_play_url: "查看图集$" + s,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    throw new Error("这是图集，请从列表点卡片打开");
  }

  // Typecho 搜索只有一页（?page=2 → 404），一次返回即可
  async searchContent(key, quick, pg = "1") {
    const url = BASE + "/search/" + encodeURIComponent(key) + "/";
    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], 1, PAGE_SIZE, 0);

    const cards = parseCards(r.content);
    const list = cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.count ? "图集 · " + c.count + "张" : "图集",
      action: "gal:" + c.url,
    }));
    return this.page(list, 1, PAGE_SIZE, list.length);
  }
}
