// Rule34Video —— FongMi / TVBox QuickJS 源
// 站点：KVS 架构；播放地址在详情页的 var flashvars 里（MP4 直链，token 绑 IP、有时效）

import { Spider } from "catvod";

const BASE = "https://rule34video.com";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function headers(referer) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": referer || BASE + "/",
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

// 列表页解析：先按卡片边界切分，再在每块里取第一个 a.th 和 img
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/(?=<div class="[^"]*\bitem\b[^"]*\bthumb\b)/);
  for (const p of parts) {
    if (!/^<div class="[^"]*\bitem\b[^"]*\bthumb\b/.test(p)) continue;
    const block = p.substring(0, 4000);
    const a = block.match(/<a class="[^"]*\bth\b[^"]*"\s+href="([^"]+)"\s+title="([^"]*)"/);
    if (!a) continue;
    const url = absolute(a[1]);
    if (!url || seen[url]) continue;
    seen[url] = 1;
    const img = block.match(/<img[^>]*src="([^"]*)"/);
    const pic = img ? decode(img[1]).split("!")[0] : "";
    out.push({ vod_id: url, vod_name: decode(a[2]), vod_pic: pic, vod_remarks: "" });
  }
  return out;
}

export default class Rule34Video extends Spider {
  init(extend) {
    this.log("Rule34Video ready");
  }

  // ---------------- 发现页 ----------------
  async homeContent(filter) {
    const classes = [
      { type_id: "latest", type_name: "最新" },
      { type_id: "viewed", type_name: "最热" },
      { type_id: "rating", type_name: "评分最高" },
      { type_id: "duration", type_name: "时长最长" },
    ];

    try {
      const r = await this.net.req(BASE + "/categories/", { headers: headers() });
      if (r && r.code === 200) {
        const re = /<a[^>]*href="https:\/\/rule34video\.com\/categories\/([a-z0-9\-]+)\/"[^>]*>([\s\S]*?)<\/a>/g;
        const seen = {};
        let m;
        while ((m = re.exec(r.content)) !== null && classes.length < 80) {
          const slug = m[1];
          if (seen[slug]) continue;
          let name = "";
          const t = m[2].match(/<div class="thumb_title">([^<]*)<\/div>/);
          if (t) name = decode(t[1]).trim();
          if (!name) {
            const alt = m[2].match(/alt="([^"]*)"/);
            if (alt) name = decode(alt[1]).trim();
          }
          if (!name) continue;
          seen[slug] = 1;
          classes.push({ type_id: "cat:" + slug, type_name: name });
        }
      }
    } catch (e) {
      this.log("categories failed: " + e);
    }

    return { class: classes };
  }

  // ---------------- 分类列表 ----------------
  async categoryContent(tid, pg, filter, extend) {
    let url;
    if (tid.indexOf("cat:") === 0) {
      const slug = tid.substring(4);
      url = BASE + "/categories/" + slug + "/" + (pg > 1 ? pg + "/" : "");
    } else {
      const sort = tid === "latest" ? "post_date" : tid;
      url = BASE + "/latest-updates/" + (pg > 1 ? pg + "/" : "") + "?sort_by=" + sort;
    }

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], pg, 23, 0);

    const cards = parseCards(r.content);
    const total = cards.length >= 23 ? (pg + 1) * 23 : (pg - 1) * 23 + cards.length;
    return this.page(cards, pg, 23, total);
  }

  // ---------------- 详情 ----------------
  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = absolute(id);
      let title = "Rule34Video";
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

          // .vp-meta 里三个 span：上传时间 / 观看数 / 时长
          const stats = [];
          const meta = html.match(/<div class="vp-meta">([\s\S]*?)<\/div>/);
          if (meta) {
            const spans = meta[1].match(/<span>([^<]*)<\/span>/g) || [];
            const vals = spans.map((s) => decode(s.replace(/<[^>]+>/g, "")).trim());
            if (vals[0]) stats.push("上传: " + vals[0]);
            if (vals[1]) stats.push("观看: " + vals[1]);
            if (vals[2]) stats.push("时长: " + vals[2]);
          }

          const fv = html.match(/var\s+flashvars\s*=\s*\{([\s\S]*?)\};/);
          if (fv) {
            const p = fv[1].match(/preview_url\s*:\s*'([^']*)'/);
            if (p) pic = absolute(p[1]);

            const cat = fv[1].match(/video_categories\s*:\s*'([^']*)'/);
            const tags = fv[1].match(/video_tags\s*:\s*'([^']*)'/);
            if (cat && cat[1]) stats.push(decode(cat[1]));
            if (tags && tags[1]) stats.push(decode(tags[1]));
          }

          content = stats.join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title,
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "Rule34Video",
        // 地址在播放时现取（token 有时效）
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

    const fv = r.content.match(/var\s+flashvars\s*=\s*\{([\s\S]*?)\};/);
    if (!fv) throw new Error("找不到播放配置");

    const pick = (k) => {
      const m = fv[1].match(new RegExp(k + "\\s*:\\s*'([^']*)'"));
      return m ? m[1] : "";
    };

    const candidates = [
      pick("video_alt_url3"),
      pick("video_alt_url2"),
      pick("video_alt_url"),
      pick("video_url"),
    ].filter((u) => u && u.indexOf(".mp4") >= 0);

    if (candidates.length === 0) throw new Error("没有可用的 mp4 地址");

    return {
      parse: 0,
      url: absolute(candidates[0]),
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  // ---------------- 搜索 ----------------
  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search/" + encodeURIComponent(key) + "/" + (p > 1 ? p + "/" : "");
    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 23, 0);

    const cards = parseCards(r.content);
    const total = cards.length >= 23 ? (p + 1) * 23 : (p - 1) * 23 + cards.length;
    return this.page(cards, p, 23, total);
  }
}
