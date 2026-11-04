// xchina.co —— FongMi / TVBox QuickJS 源
//
// 用中文站 xchina.co（不要用 en.xchina.co，那是英文站，标题全英文）
// 取流很直接：详情页 div#video-player 的 data-src 就是 m3u8（带 Referer/Origin 校验）

import { Spider, openWeb } from "catvod";

const BASE = "https://xchina.co";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// [tid, 路径, 名称]
const CATS = [
  ["s21", "/video-series/21", "麻豆传媒"],
  ["s20", "/video-series/20", "糖心Vlog"],
  ["s8", "/video-series/8", "香蕉视频"],
  ["s42", "/video-series/42", "精东影业"],
  ["s5", "/video-series/5", "无码"],
  ["s4", "/video-series/4", "有码"],
  ["s62", "/video-series/62", "模特私拍"],
  ["s44", "/video-series/44", "热舞"],
  ["s55", "/video-series/55", "PANS"],
  ["s15", "/video-series/15", "Faphouse"],
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

// 卡片：<a href="/video/xxx" class="group block"> … <img src=… alt="标题">
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/<a href="(\/video\/[^"]+)"[^>]*class="[^"]*group block[^"]*"[^>]*>/);
  // split 带捕获组：偶数下标是内容，奇数下标是 href
  for (let i = 1; i < parts.length; i += 2) {
    const url = absolute(parts[i]);
    const block = (parts[i + 1] || "").substring(0, 1600);
    if (!url || seen[url]) continue;
    seen[url] = 1;

    const img = block.match(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/) ||
                block.match(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/);
    let pic = "";
    let title = "";
    if (img) {
      if (img[1].indexOf("http") === 0) {
        pic = img[1];
        title = img[2];
      } else {
        title = img[1];
        pic = img[2];
      }
    }
    if (!title) {
      const t = block.match(/<span class="line-clamp-2[^"]*">([\s\S]*?)<\/span>/);
      if (t) title = strip(t[1]);
    }
    if (!title) title = url.replace(/^.*\/video\//, "");

    out.push({ vod_id: url, vod_name: decode(title), vod_pic: pic, vod_remarks: "" });
  }
  return out;
}

export default class XChina extends Spider {
  init(extend) {
    this.log("xchina ready");
  }

  async homeContent(filter) {
    const classes = [{ type_id: CATS[0][0], type_name: CATS[0][2] }];
    classes.push({ type_id: "web", type_name: "网页" });
    for (let i = 1; i < CATS.length; i++) classes.push({ type_id: CATS[i][0], type_name: CATS[i][2] });
    return { class: classes };
  }

  async categoryContent(tid, pg, filter, extend) {
    if (tid === "web") {
      try {
        openWeb({ url: BASE });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 23, 0);
    }

    let path = CATS[0][1];
    for (const c of CATS) {
      if (c[0] === tid) {
        path = c[1];
        break;
      }
    }

    const p = Number(pg) || 1;
    const url = BASE + path + (p > 1 ? "/" + p : "");

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 23, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 23, (p - 1) * 23);

    // 站点在超过最后一页时会重复返回最后一页，这里检测并截断
    if (p > 1 && this.isRepeat(tid, cards)) {
      return this.page([], p, 23, (p - 1) * 23);
    }

    return this.page(cards, p, 23, (p + 1) * 23);
  }

  // 记录每个分类已见过的首页 id，避免越界后重复
  isRepeat(key, cards) {
    if (!cards.length) return false;
    this.seenFirst = this.seenFirst || {};
    const set = this.seenFirst[key] || (this.seenFirst[key] = {});
    const first = cards[0].vod_id;
    if (set[first]) return true;
    set[first] = 1;
    return false;
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = String(id).indexOf("http") === 0 ? String(id) : absolute(String(id));
      let title = "";
      let pic = "";
      let content = "";
      let quality = "";

      try {
        const r = await this.net.req(pageUrl, { headers: headers() });
        if (r && r.code === 200) {
          const html = r.content;

          const ogt = html.match(/property="og:title"[^>]*content="([^"]+)"/);
          const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          title = ogt ? decode(ogt[1]) : h1 ? strip(h1[1]) : "";
          if (title && h1) {
            // h1 里含番号 span，取完整文本更准确
            const full = strip(h1[1]);
            if (full.length > title.length) title = full;
          }

          const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
          if (ogi) pic = decode(ogi[1]);

          const lines = [];
          const tags = [];
          const reT = /href="[^"]*(?:category|series)[^"]*"[^>]*>([^<]{1,30})</g;
          let m;
          while ((m = reT.exec(html)) !== null) {
            const t = strip(m[1]);
            if (t && t.length < 20 && tags.indexOf(t) < 0) tags.push(t);
          }
          if (tags.length) lines.push("分类: " + tags.slice(0, 10).join(" / "));

          const desc = html.match(/property="og:description"[^>]*content="([^"]+)"/);
          if (desc) lines.push(decode(desc[1]).substring(0, 140));

          // 清晰度：取 master.m3u8 里最高的 RESOLUTION
          const ds = html.match(/id="video-player"[\s\S]{0,400}?data-src="([^"]+)"/);
          if (ds) {
            try {
              const pr = await this.net.req(absolute(decode(ds[1])), { headers: headers() });
              if (pr && pr.code === 200) {
                const res = [];
                const reR = /RESOLUTION=\d+x(\d+)/g;
                let mr;
                while ((mr = reR.exec(pr.content)) !== null) res.push(Number(mr[1]));
                if (res.length) {
                  quality = Math.max.apply(null, res) + "P";
                  lines.unshift("清晰度: " + quality);
                }
              }
            } catch (e) {
              this.log("quality failed: " + e);
            }
          }

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
        vod_play_from: "xChina",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const pageUrl = String(id).indexOf("http") === 0 ? String(id) : absolute(String(id));

    const r = await this.net.req(pageUrl, { headers: headers() });
    if (!r || r.code !== 200) throw new Error("无法打开详情页");

    const m = r.content.match(/id="video-player"[\s\S]{0,400}?data-src="([^"]+)"/);
    if (!m) throw new Error("找不到播放地址");

    return {
      parse: 0,
      url: absolute(decode(m[1])),
      header: {
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Origin": BASE,
      },
    };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/search?type=video&q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 23, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 23, (p - 1) * 23);
    if (p > 1 && this.isRepeat("s:" + key, cards)) return this.page([], p, 23, (p - 1) * 23);
    return this.page(cards, p, 23, (p + 1) * 23);
  }
}
