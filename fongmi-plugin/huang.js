// huang.video —— FongMi / TVBox QuickJS 源
//
// 取流：视频页 data-xg-player-source-value 就是 m3u8（需要 Referer: https://huang.video/）
// 分集：视频页里的 /series/<id> → 系列页列出全部剧集

import { Spider, openWeb } from "catvod";

const BASE = "https://huang.video";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// [tid, 参数, 名称]
const CATS = [
  ["latest", "sort=latest", "最新"],
  ["popular", "sort=popular", "最热"],
  ["popular_24h", "sort=popular_24h", "24小时最热"],
  ["popular_7d", "sort=popular_7d", "7天最热"],
];

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function strip(s) {
  return decode((s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function absolute(u) {
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("/") === 0) return BASE + u;
  return u;
}

// 卡片：<article id="video_123" class="card …">
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/<article id="video_\d+"/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].substring(0, 2600);

    const a = block.match(/href="(\/videos\/\d+)"[^>]*aria-label="([^"]*)"/) ||
              block.match(/aria-label="([^"]*)"[^>]*href="(\/videos\/\d+)"/);
    let url = "";
    let title = "";
    if (a) {
      if (a[1].indexOf("/videos/") === 0) {
        url = a[1];
        title = a[2];
      } else {
        title = a[1];
        url = a[2];
      }
    }
    if (!url) {
      const u = block.match(/href="(\/videos\/\d+)"/);
      if (u) url = u[1];
    }
    if (!url || seen[url]) continue;
    seen[url] = 1;

    if (!title) {
      const t = block.match(/class="line-clamp-2"[^>]*>([^<]{1,120})</);
      if (t) title = t[1];
    }

    const img = block.match(/<img[^>]*src="([^"]+)"/);
    const dur = block.match(/badge[^"]*"[^>]*>\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*</);

    out.push({
      vod_id: absolute(url),
      vod_name: strip(title) || url,
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: dur ? dur[1] : "",
    });
  }
  return out;
}

// 系列页里的剧集列表：<li><a href="/videos/ID">…<span>第N集</span>…
function parseEpisodes(html) {
  const at = html.indexOf("episodes-title");
  const seg = at >= 0 ? html.substring(at, at + 40000) : html;
  const out = [];
  const seen = {};
  const re = /href="(\/videos\/\d+)"[\s\S]{0,400}?<span class="font-semibold">([^<]{1,16})<\/span>/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = 1;
    out.push({ url: m[1], label: strip(m[2]) });
  }
  return out;
}

// /creators 页：按厂牌分组，每组下面是博主
function parseCreators(html) {
  const groups = [];
  const parts = html.split(/id="creator_category_(\d+)-title"/);
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const rest = parts[i + 1] || "";
    const nm = rest.match(/^[^>]*>([^<]{1,40})<\/h2>/);
    const name = nm ? strip(nm[1]) : "分类" + id;

    const body = rest.substring(0, 60000);
    const creators = [];
    const seen = {};
    const re = /href="\/creators\/([a-z0-9\-_]+)"[\s\S]{0,260}?<h3[^>]*>([^<]{1,40})<\/h3>/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (seen[m[1]]) continue;
      seen[m[1]] = 1;
      creators.push({ slug: m[1], name: strip(m[2]) });
    }
    if (creators.length) groups.push({ id: id, name: name, creators: creators });
  }
  return { groups: groups };
}

export default class HuangVideo extends Spider {
  init(extend) {
    this.log("huang.video ready");
  }

  async homeContent(filter) {
    const classes = [];
    for (const [tid, , name] of CATS) classes.push({ type_id: tid, type_name: name });
    classes.push({ type_id: "web", type_name: "网页" });

    // 排序筛选器只给上面几个总列表
    const sorts = CATS.map(([tid, , name]) => ({ n: name, v: tid }));
    const filters = {};
    for (const [tid] of CATS) filters[tid] = [{ key: "sort", name: "排序", value: sorts }];
    filters["web"] = [{ key: "sort", name: "排序", value: sorts }];

    // 厂牌 + 博主（来自 /creators 页）
    if (!this.taxonomy) {
      try {
        const r = await this.net.req(BASE + "/creators", { headers: headers() });
        if (r && r.code === 200) this.taxonomy = parseCreators(r.content);
      } catch (e) {
        this.log("creators failed: " + e);
      }
    }

    const tax = this.taxonomy || { groups: [] };

    // 5 个厂牌作为「文件夹分类」：点进去是博主列表（列表样式）
    for (const g of tax.groups) {
      const tid = "cc:" + g.id;
      classes.push({
        type_id: tid,
        type_name: g.name + " (" + g.creators.length + ")",
        type_flag: "1",
      });
    }

    // 所有分类（含厂牌文件夹）都给排序筛选
    for (const c of classes) filters[c.type_id] = [{ key: "sort", name: "排序", value: sorts }];

    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    if (tid === "web") {
      try {
        openWeb({ url: BASE });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 24, 0);
    }

    const p = Number(pg) || 1;

    // 厂牌层：列出该厂牌的博主（folder 卡片，点进去才是视频列表）
    if (tid.indexOf("cc:") === 0) {
      const id = tid.substring(3);
      const tax = this.taxonomy || { groups: [] };
      let g = null;
      for (const x of tax.groups) {
        if (String(x.id) === String(id)) {
          g = x;
          break;
        }
      }
      if (!g) return this.page([], 1, 60, 0);

      const folders = g.creators.map((c) => ({
        vod_id: "cr:" + c.slug,
        vod_name: c.name,
        vod_pic: "",
        vod_remarks: g.name,
        vod_tag: "folder",
      }));
      return this.page(folders, 1, folders.length, folders.length);
    }

    let url;

    if (tid.indexOf("cr:") === 0) {
      url = BASE + "/creators/" + tid.substring(3) + (p > 1 ? "?page=" + p : "");
    } else {
      const sort = (extend && extend.sort) || tid || "latest";
      url = BASE + "/videos?sort=" + encodeURIComponent(sort) + (p > 1 ? "&page=" + p : "");
    }

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 24, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 24, (p - 1) * 24);
    return this.page(cards, p, 24, (p + 1) * 24);
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = String(id).indexOf("http") === 0 ? String(id) : absolute(String(id));
      let title = "";
      let pic = "";
      let content = "";
      let playUrl = "正片$" + pageUrl;
      let quality = "";

      try {
        const r = await this.net.req(pageUrl, { headers: headers() });
        if (r && r.code === 200) {
          const html = r.content;

          const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
          const ogt = html.match(/property="og:title"[^>]*content="([^"]*)"/);
          title = h1 ? strip(h1[1]) : ogt ? strip(ogt[1]).replace(/\s*\|.*$/, "") : "";
          title = title.replace(/\s*\|\s*黄视频\s*$/, "").trim();

          const ogi = html.match(/property="og:image"[^>]*content="([^"]*)"/);
          if (ogi) pic = decode(ogi[1]);

          const lines = [];

          // 系列剧：找到所属系列页，取全部剧集
          const seriesLinks = [];
          const reS = /href="(\/series\/\d+)"/g;
          let ms;
          while ((ms = reS.exec(html)) !== null) {
            if (seriesLinks.indexOf(ms[1]) < 0) seriesLinks.push(ms[1]);
            if (seriesLinks.length >= 3) break;
          }

          const vid = (pageUrl.match(/\/videos\/(\d+)/) || [])[1] || "";
          for (const sl of seriesLinks) {
            try {
              const sr = await this.net.req(absolute(sl), { headers: headers() });
              if (!sr || sr.code !== 200) continue;
              // 确认这个系列里确实有当前这集
              if (vid && sr.content.indexOf("/videos/" + vid) < 0) continue;

              const eps = parseEpisodes(sr.content);
              if (eps.length > 1) {
                const parts = [];
                for (const e of eps) parts.push(e.label + "$" + absolute(e.url));
                playUrl = parts.join("#");
                lines.push("共 " + eps.length + " 集");
              }
              const st = sr.content.match(/id="series-title"[^>]*>([\s\S]{0,80}?)<\/h1>/);
              if (st) lines.push("系列: " + strip(st[1]));
              break;
            } catch (e) {
              this.log("series failed: " + e);
            }
          }

          const desc = html.match(/property="og:description"[^>]*content="([^"]*)"/) ||
                       html.match(/<meta name="description" content="([^"]*)"/);
          if (desc) lines.push(strip(desc[1]).substring(0, 120));

          content = lines.filter(Boolean).join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || String(id),
        vod_pic: pic,
        vod_content: content,
        vod_remarks: quality,
        vod_play_from: "huang",
        vod_play_url: playUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const pageUrl = String(id).indexOf("http") === 0 ? String(id) : absolute(String(id));

    const r = await this.net.req(pageUrl, { headers: headers() });
    if (!r || r.code !== 200) throw new Error("无法打开详情页");

    const m = r.content.match(/data-xg-player-source-value="([^"]+)"/);
    if (!m) throw new Error("找不到播放地址");

    return {
      parse: 0,
      url: decode(m[1]),
      header: {
        "User-Agent": UA,
        "Referer": BASE + "/",
      },
    };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 24, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 24, (p - 1) * 24);
    return this.page(cards, p, 24, (p + 1) * 24);
  }
}
