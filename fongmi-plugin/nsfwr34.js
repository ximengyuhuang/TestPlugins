// NSFWR34 —— FongMi / TVBox QuickJS 源
// 站点：WordPress + StreamTube；播放器 <video-js data-settings="..."> 里是 m3u8 明文
// 分类/标签：从列表页文章的 class（categories-xxx / video_tag-xxx）动态提取

import { Spider } from "catvod";

const BASE = "https://nsfwr34.com";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 不是内容分类的词
const SKIP_CATS = { featured: 1, widget: 1, uncategorized: 1 };

function headers() {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BASE + "/",
  };
}

function decode(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absolute(u) {
  if (!u) return "";
  u = decode(u).trim();
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE + u;
  if (u.startsWith("http")) return u;
  return BASE + "/" + u;
}

// slug -> 显示名：big-ass -> Big Ass
function titleize(slug) {
  return slug
    .split("-")
    .map((w) => (w.length <= 2 && w !== "3d" && w !== "4k" && w !== "vr" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// 列表页卡片
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/(?=<article class=")/);
  for (const p of parts) {
    if (!/^<article class="/.test(p)) continue;
    const block = p.substring(0, 3000);
    const art = block.match(/<article class="([^"]*)"[\s\S]*?data-embed-url="([^"]+)"/);
    if (!art) continue;

    const link = block.match(/<a class="[^"]*post-permalink[^"]*"\s+title="([^"]*)"\s+href="([^"]+)"/);
    let url = link ? absolute(link[2]) : "";
    if (!url) {
      // 兜底：从 data-embed-url 推 /video/slug/
      const em = art[2].replace("/embed/", "/");
      url = absolute(em);
    }
    if (!url || seen[url]) continue;
    seen[url] = 1;

    let title = link ? decode(link[1]) : "";
    if (!title) {
      const alt = block.match(/<img[^>]*alt="([^"]*)"/);
      if (alt) title = decode(alt[1]);
    }

    const img = block.match(/<img[^>]*src="([^"]+)"/);
    const pic = img ? absolute(img[1]) : "";

    out.push({ vod_id: url, vod_name: title.trim(), vod_pic: pic, vod_remarks: "" });
  }
  return out;
}

// 从卡片 class 里收集分类/标签
function collectTaxonomy(html, cats, tags) {
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const c = m[1];
    const cs = c.match(/categories-([a-z0-9\-]+)/g) || [];
    for (const x of cs) {
      const s = x.substring(11);
      if (!SKIP_CATS[s] && !cats[s]) cats[s] = 1;
    }
    const ts = c.match(/video_tag-([a-z0-9\-]+)/g) || [];
    for (const x of ts) {
      const s = x.substring(10);
      if (!tags[s]) tags[s] = 1;
    }
  }
}

export default class Nsfwr34 extends Spider {
  init(extend) {
    this.log("NSFWR34 ready");
  }

  // ---------------- 发现页 ----------------
  async homeContent(filter) {
    const classes = [
      { type_id: "latest", type_name: "最新" },
    ];
    const filters = {};
    const cats = {};
    const tags = {};

    // 抓列表前 3 页，收集分类与标签
    try {
      for (let p = 1; p <= 3; p++) {
        const url = BASE + "/video/" + (p > 1 ? "page/" + p + "/" : "");
        const r = await this.net.req(url, { headers: headers() });
        if (!r || r.code !== 200) break;
        collectTaxonomy(r.content, cats, tags);
      }
    } catch (e) {
      this.log("taxonomy failed: " + e);
    }

    catalog: {
      for (const s of Object.keys(cats).sort()) {
        classes.push({ type_id: "cat:" + s, type_name: titleize(s) });
      }
    }

    // 标签最多取 200 个
    let n = 0;
    for (const s of Object.keys(tags).sort()) {
      if (n >= 200) break;
      classes.push({ type_id: "tag:" + s, type_name: titleize(s) });
      n++;
    }

    return { class: classes, filters: filters };
  }

  // ---------------- 分类列表 ----------------
  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const suffix = p > 1 ? "page/" + p + "/" : "";

    let url;
    if (tid.indexOf("cat:") === 0) {
      url = BASE + "/categories/" + tid.substring(4) + "/" + suffix;
    } else if (tid.indexOf("tag:") === 0) {
      url = BASE + "/video_tag/" + tid.substring(4) + "/" + suffix;
    } else {
      url = BASE + "/video/" + suffix;
    }

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 20, 0);

    const cards = parseCards(r.content);
    // 站点每页 20 个
    const total = cards.length >= 20 ? (p + 1) * 20 : (p - 1) * 20 + cards.length;
    return this.page(cards, p, 20, total);
  }

  // ---------------- 详情 ----------------
  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = absolute(id);
      let title = "NSFWR34";
      let pic = "";
      let content = "";

      try {
        const r = await this.net.req(pageUrl, { headers: headers() });
        if (r && r.code === 200) {
          const html = r.content;

          const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (h1) {
            const t = decode(h1[1].replace(/<[^>]+>/g, "")).trim();
            if (t) title = t;
          }

          const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
          if (og) pic = absolute(og[1]);
          if (!pic) {
            const th = html.match(/data-thumbnail-image-2="([^"]+)"/);
            if (th) pic = absolute(th[1]);
          }

          const lines = [];

          const desc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/);
          if (desc && desc[1]) lines.push(decode(desc[1]).trim());

          const date = html.match(/<time[^>]*datetime="([^"]+)"/);
          if (date) lines.push("发布: " + date[1].substring(0, 10));

          // 分类 / 标签
          const cs = [];
          const ts = [];
          let m;
          const reC = /href="https:\/\/nsfwr34\.com\/categories\/([a-z0-9\-]+)\/"/g;
          while ((m = reC.exec(html)) !== null) {
            if (!SKIP_CATS[m[1]] && cs.indexOf(m[1]) < 0) cs.push(m[1]);
          }
          const reT = /href="https:\/\/nsfwr34\.com\/video_tag\/([a-z0-9\-]+)\/"/g;
          while ((m = reT.exec(html)) !== null) {
            if (ts.indexOf(m[1]) < 0) ts.push(m[1]);
          }
          if (cs.length) lines.push("分类: " + cs.map(titleize).join(", "));
          if (ts.length) lines.push("标签: " + ts.slice(0, 20).map(titleize).join(", "));

          content = lines.join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title,
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "NSFWR34",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  // ---------------- 播放 ----------------
  async playerContent(flag, id, vipFlags) {
    const pageUrl = absolute(id);
    const r = await this.net.req(pageUrl, { headers: headers() });
    if (!r || r.code !== 200) throw new Error("无法打开详情页");

    // m3u8 在 <video-js data-settings="..."> 里，可能是 JSON 转义（https:\/\/）
    let hay = "";
    const vj = r.content.match(/<video-js[^>]*data-settings="([^"]*)"/);
    if (vj) hay = decode(vj[1]);
    if (!hay) hay = r.content;

    const found = [];
    const re = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.m3u8/g;
    let m;
    while ((m = re.exec(hay)) !== null) {
      let u = m[0].replace(/\\\//g, "/");
      if (found.indexOf(u) < 0) found.push(u);
    }

    if (found.length === 0) throw new Error("没有找到 m3u8");

    // master playlist 优先（含多画质）
    let pick = found.find((u) => u.indexOf("playlist.m3u8") >= 0);
    if (!pick) pick = found[0];

    return {
      parse: 0,
      url: pick,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  // ---------------- 搜索 ----------------
  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const suffix = p > 1 ? "page/" + p + "/" : "";
    const url = BASE + "/" + suffix + "?s=" + encodeURIComponent(key);

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 20, 0);

    const cards = parseCards(r.content);
    const total = cards.length >= 20 ? (p + 1) * 20 : (p - 1) * 20 + cards.length;
    return this.page(cards, p, 20, total);
  }
}
