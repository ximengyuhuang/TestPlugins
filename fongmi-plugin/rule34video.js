// Rule34Video —— FongMi / TVBox QuickJS 源 (v3)
// 新增：标签分组、排序筛选器

import { Spider, openWeb } from "catvod";

const BASE = "https://rule34video.com";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SORTS = [
  { n: "最新", v: "post_date" },
  { n: "最热", v: "video_viewed" },
  { n: "评分", v: "rating" },
  { n: "时长", v: "duration" },
];

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
    this.log("Rule34Video v3 ready");
  }

  // ---------------- 发现页 ----------------
  async homeContent(filter) {
    const classes = [
      { type_id: "latest", type_name: "最新" },
      // 在浏览器里看原站，放第二位
      { type_id: "web", type_name: "网页" },
      { type_id: "sort:video_viewed", type_name: "最热" },
      { type_id: "sort:rating", type_name: "评分最高" },
      { type_id: "sort:duration", type_name: "时长最长" },
    ];
    const filters = {};

    // 分类（约 46 个）
    try {
      const r = await this.net.req(BASE + "/categories/", { headers: headers() });
      if (r && r.code === 200) {
        const re = /<a[^>]*href="https:\/\/rule34video\.com\/categories\/([a-z0-9\-]+)\/"[^>]*>([\s\S]*?)<\/a>/g;
        const seen = {};
        let m;
        while ((m = re.exec(r.content)) !== null && classes.length < 60) {
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

    // 热门标签（前 8 页 ≈ 200 个；注意分页要用路径 /tags/2/，?page= 无效）
    try {
      for (let p = 1; p <= 8; p++) {
        const url = BASE + "/tags/" + (p > 1 ? p + "/" : "") + "?sort=quantity";
        const r = await this.net.req(url, { headers: headers() });
        if (!r || r.code !== 200) break;
        const re = /<a class="button" href="https:\/\/rule34video\.com\/tags\/([^\/"]+)\/">([^<]*)<\/a>/g;
        const seen = {};
        let m;
        let added = 0;
        while ((m = re.exec(r.content)) !== null) {
          const slug = m[1];
          if (seen[slug]) continue;
          const name = decode(m[2]).trim();
          if (!name) continue;
          seen[slug] = 1;
          const id = "tag:" + slug;
          if (classes.some((c) => c.type_id === id)) continue;
          classes.push({ type_id: id, type_name: name });
          added++;
          if (classes.length >= 300) break;
        }
        if (added === 0) break;
      }
    } catch (e) {
      this.log("tags failed: " + e);
    }

    // 每个分类都给排序筛选器
    const sortFilter = { key: "sort", name: "排序", value: SORTS };
    for (const c of classes) {
      filters[c.type_id] = [sortFilter];
    }

    return { class: classes, filters: filters };
  }

  // ---------------- 分类列表 ----------------
  async categoryContent(tid, pg, filter, extend) {
    // 点「网页」打开原站
    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 23, 0);
    }

    const sort = (extend && extend.sort) || "post_date";
    const p = Number(pg) || 1;
    const suffix = p > 1 ? p + "/" : "";

    let url;
    if (tid.indexOf("cat:") === 0) {
      url = BASE + "/categories/" + tid.substring(4) + "/" + suffix + "?sort_by=" + sort;
    } else if (tid.indexOf("tag:") === 0) {
      url = BASE + "/tags/" + tid.substring(4) + "/" + suffix + "?sort_by=" + sort;
    } else if (tid.indexOf("sort:") === 0) {
      url = BASE + "/latest-updates/" + suffix + "?sort_by=" + tid.substring(5);
    } else {
      url = BASE + "/latest-updates/" + suffix + "?sort_by=" + (tid === "latest" ? sort : tid);
    }

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 23, 0);

    const cards = parseCards(r.content);
    const total = cards.length >= 23 ? (p + 1) * 23 : (p - 1) * 23 + cards.length;
    return this.page(cards, p, 23, total);
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

          const stats = [];
          const meta = html.match(/<div class="vp-meta">([\s\S]*?)<\/div>/);
          if (meta) {
            const spans = meta[1].match(/<span>([^<]*)<\/span>/g) || [];
            const vals = spans.map((s) => decode(s.replace(/<[^>]+>/g, "")).trim());
            if (vals[0]) stats.push("上传: " + vals[0]);
            if (vals[1]) stats.push("观看: " + vals[1]);
            if (vals[2]) stats.push("时长: " + vals[2]);
          }

          let models = "";
          let cat = "";
          let tags = "";
          const fv = html.match(/var\s+flashvars\s*=\s*\{([\s\S]*?)\};/);
          if (fv) {
            const p = fv[1].match(/preview_url\s*:\s*'([^']*)'/);
            if (p) pic = absolute(p[1]);

            const m1 = fv[1].match(/video_categories\s*:\s*'([^']*)'/);
            const m2 = fv[1].match(/video_tags\s*:\s*'([^']*)'/);
            const m3 = fv[1].match(/video_models\s*:\s*'([^']*)'/);
            if (m3) models = decode(m3[1]);
            if (m1) cat = decode(m1[1]);
            if (m2) tags = decode(m2[1]);
          }

          // 播放页简介只显示 3 行（activity_video.xml: maxLines=3），必须压紧
          const line1 = stats.join(" | ");
          const line2 = [models ? "作者: " + models : "", cat ? "分类: " + cat : ""].filter(Boolean).join(" | ");
          const line3 = tags ? "标签: " + tags : "";
          content = [line1, line2, line3].filter(Boolean).join("\n");
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
