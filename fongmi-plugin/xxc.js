import { Spider, openWeb } from "catvod";

// xxcosplay（xxcosplay.com）—— Ruby on Rails + Hotwire 自研站
// 分类完全按站点导航 + 用户拍板：最新 | 所有Coser | 标签 | 搜索 | 网页
//   - 画师 / 标签：不分字母，直接分页列表
//   - 相册可能是「6P 5V」：图 webp + 视频 HLS(m3u8)，卡片角标直接写着数量 → 三态卡片
// ✅ 直连可用（不需要挂代理）

const BASE = "https://xxcosplay.com";
const LOC = "/zh-CN";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 24;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + LOC,
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

// 列表卡片：
//   <a class="break-inside-avoid …" href="/zh-CN/albums/<slug>">
//     <img src="…0001.webp" alt="标题">
//     <span title="50 images"> / <span title="5 videos">
//     <p>画师</p><h3>标题</h3>
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/<a class="break-inside-avoid/).slice(1);
  for (const p of parts) {
    const block = p.substring(0, 2600);
    const m = block.match(/href="(\/zh-CN\/albums\/[^"]+)"/);
    if (!m) continue;
    const url = abs(m[1]);
    if (seen[url]) continue;
    seen[url] = 1;

    const img = block.match(/<img[^>]+src="([^"]+)"/);
    const alt = block.match(/<img[^>]+alt="([^"]*)"/);
    const h3 = block.match(/<h3[^>]*>([\s\S]{0,200}?)<\/h3>/);
    const artist = block.match(/<p[^>]*>([\s\S]{0,60}?)<\/p>/);
    const title = clean(h3 ? h3[1] : alt ? alt[1] : "");
    if (!title) continue;

    const imgN = block.match(/title="(\d+)\s*images?"/i);
    const vidN = block.match(/title="(\d+)\s*videos?"/i);

    out.push({
      url: url,
      title: title,
      pic: img ? img[1] : "",
      artist: artist ? clean(artist[1]) : "",
      imgs: imgN ? Number(imgN[1]) : -1,
      vids: vidN ? Number(vidN[1]) : 0,
    });
  }
  return out;
}

// 相册详情的媒体清单在 JSON-LD 里，图片和视频混在同一个 ImageObject 数组，顺序可靠
function parseAlbum(html) {
  const h = String(html);
  const urls = [];
  const seen = {};
  const blocks = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const b of blocks) {
    if (b.indexOf("ImageObject") < 0) continue;
    const re = /"(?:url|contentUrl)"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(b)) !== null) {
      const u = m[1].replace(/\\\//g, "/");
      if (u.indexOf("media.xxcosplay.com") < 0) continue;
      if (seen[u]) continue;
      seen[u] = 1;
      urls.push(u);
    }
  }
  // 兜底：没有 JSON-LD 就直接扫页面
  if (urls.length === 0) {
    const re = /https:\/\/media\.xxcosplay\.com\/[^"'\s\\)]+/g;
    let m;
    while ((m = re.exec(h)) !== null) {
      const u = m[0];
      if (seen[u]) continue;
      if (!/\.(webp|jpe?g|png|gif|m3u8)$/i.test(u.replace(/\?.*$/, ""))) continue;
      seen[u] = 1;
      urls.push(u);
    }
  }
  const imgs = urls.filter((u) => /\.(webp|jpe?g|png|gif)$/i.test(u.replace(/\?.*$/, "")));
  const vids = urls.filter((u) => /\.m3u8$/i.test(u.replace(/\?.*$/, "")));
  return { imgs: imgs, vids: vids };
}

function pageTitle(html) {
  const og = String(html).match(/property="og:title"[^>]*content="([^"]*)"/);
  if (og) return clean(og[1]);
  const t = String(html).match(/<title>([^<]*)<\/title>/);
  return t ? clean(t[1]).replace(/\s*\|\s*xxcosplay\s*$/i, "") : "";
}

export default class Xxc extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.log("xxcosplay ready");
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

  // 三态卡片
  cardsToList(cards) {
    const list = [];
    for (const c of cards) {
      const imgs = c.imgs < 0 ? 0 : c.imgs;
      const vids = c.vids;
      const remark = [imgs ? imgs + " 图" : "", vids ? vids + " 视频" : "", c.artist].filter(Boolean).join(" · ");
      // 只有视频 → 直接进详情播放
      if (imgs === 0 && vids > 0) {
        list.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: remark || vids + " 个视频" });
        continue;
      }
      // 只有图（或数量未知）→ 一点直接开画廊
      if (vids === 0) {
        list.push({
          vod_id: c.url,
          vod_name: c.title,
          vod_pic: c.pic,
          vod_remarks: remark || "图集",
          action: "gal:" + c.url,
        });
        continue;
      }
      // 图 + 视频 → 二级菜单
      list.push({
        vod_id: "mix|" + c.url,
        vod_name: c.title,
        vod_pic: c.pic,
        vod_remarks: remark,
        vod_tag: "folder",
      });
    }
    return list;
  }

  async homeContent(filter) {
    return {
      class: [
        { type_id: "latest", type_name: "最新", type_flag: "0" },
        { type_id: "artists", type_name: "所有Coser", type_flag: "1" },
        { type_id: "tags", type_name: "标签", type_flag: "1" },
        { type_id: "search", type_name: "搜索", type_flag: "1" },
        { type_id: "web", type_name: "网页", type_flag: "1" },
      ],
    };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    void filter;
    void extend;

    if (tid === "web" || tid === "search") {
      try {
        openWeb({ url: BASE + (tid === "search" ? LOC + "/search" : LOC) });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 所有Coser：画师也是卡片式（注意页面顶部那排 chip 是固定的推荐条，不跟翻页走）
    if (tid === "artists") {
      const html = await this.fetchPage(BASE + LOC + "/artists?page=" + p);
      const list = [];
      const seen = {};
      const parts = String(html).split(/<a class="break-inside-avoid/).slice(1);
      for (const part of parts) {
        const block = part.substring(0, 2600);
        const m = block.match(/href="\/zh-CN\/artists\/([^"\/]+)"/);
        if (!m) continue;
        const slug = m[1];
        if (seen[slug]) continue;
        const ps = [...block.matchAll(/<p[^>]*>([\s\S]{0,60}?)<\/p>/g)].map((x) => clean(x[1])).filter(Boolean);
        const name = ps.length ? ps[ps.length - 1] : slug;
        if (!name) continue;
        seen[slug] = 1;
        const cnt = block.match(/(\d+)\s*个相册/);
        const img = block.match(/<img[^>]+src="([^"]+)"/);
        list.push({
          vod_id: "a:" + slug,
          vod_name: name,
          vod_pic: img ? img[1] : "",
          vod_remarks: cnt ? cnt[1] + " 个相册" : "画师",
          vod_tag: "folder",
        });
      }
      return this.page(list, p, PAGE_SIZE, list.length >= PAGE_SIZE ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + list.length);
    }

    // 标签：卡片带「4568 相册」
    if (tid === "tags") {
      const html = await this.fetchPage(BASE + LOC + "/tags?page=" + p);
      const list = [];
      const seen = {};
      const re =
        /<a[^>]+href="\/zh-CN\/tags\/([^"\/]+)"[^>]*>\s*<p[^>]*>([\s\S]{0,60}?)<\/p>\s*<p[^>]*>(\d+)\s*相册/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const slug = m[1];
        if (seen[slug]) continue;
        seen[slug] = 1;
        list.push({
          vod_id: "t:" + slug,
          vod_name: clean(m[2]),
          vod_pic: "",
          vod_remarks: m[3] + " 相册",
          vod_tag: "folder",
        });
      }
      return this.page(list, p, PAGE_SIZE, list.length >= PAGE_SIZE ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + list.length);
    }

    // 二级菜单
    if (tid.indexOf("mix|") === 0) {
      const pageUrl = tid.substring(4);
      const html = await this.fetchPage(pageUrl);
      const list = [];
      if (html) {
        const media = parseAlbum(html);
        if (media.vids.length > 0) {
          list.push({
            vod_id: "v|" + pageUrl + "|0",
            vod_name: "▶ 播放视频" + (media.vids.length > 1 ? "（" + media.vids.length + " 个版本）" : ""),
            vod_pic: "",
            vod_remarks: media.vids.length > 1 ? media.vids.length + " 集" : "视频",
          });
        }
        if (media.imgs.length > 0) {
          list.push({
            vod_id: "gal|" + pageUrl,
            vod_name: "🖼 查看图集 (" + media.imgs.length + " 张)",
            vod_pic: "",
            vod_remarks: "图集",
            action: "gal|" + pageUrl,
          });
        }
      }
      if (list.length === 0) {
        list.push({ vod_id: pageUrl, vod_name: "（没有内容）", vod_pic: "", vod_remarks: "" });
      }
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url;
    if (tid.indexOf("a:") === 0) {
      url = BASE + LOC + "/artists/" + tid.substring(2) + "?page=" + p;
    } else if (tid.indexOf("t:") === 0) {
      url = BASE + LOC + "/tags/" + tid.substring(2) + "?page=" + p;
    } else {
      url = BASE + LOC + "?page=" + p;
    }

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const cards = parseCards(r.content);
    const list = this.cardsToList(cards);
    if (list.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const id = String(raw);
      let pageUrl = "";
      if (id.indexOf("v|") === 0) {
        pageUrl = id.split("|")[1] || "";
      } else {
        pageUrl = id.indexOf("http") === 0 ? id : BASE + id;
      }

      let playUrl = "正片$v|" + pageUrl + "|0";
      let title = "";
      let pic = "";
      let content = "";
      const html = await this.fetchPage(pageUrl);
      if (html) {
        title = pageTitle(html);
        const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
        if (og) pic = og[1];
        const media = parseAlbum(html);
        content = "图 " + media.imgs.length + " 张 · 视频 " + media.vids.length + " 个";
        if (media.vids.length > 1) {
          playUrl = media.vids.map((v, i) => "版本 " + (i + 1) + "$v|" + pageUrl + "|" + i).join("#");
        } else if (media.vids.length === 1) {
          playUrl = "正片$v|" + pageUrl + "|0";
        }
      }

      list.push({
        vod_id: id.indexOf("v|") === 0 ? id : "v|" + pageUrl + "|0",
        vod_name: title || "xxcosplay",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "xxcosplay",
        vod_play_url: playUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const s = String(id);
    let pageUrl = "";
    let idx = 0;
    if (s.indexOf("v|") === 0) {
      const parts = s.split("|");
      pageUrl = parts[1] || "";
      idx = Number(parts[2]) || 0;
    } else {
      pageUrl = s.indexOf("http") === 0 ? s : BASE + s;
    }

    const html = await this.fetchPage(pageUrl);
    if (!html) throw new Error("打不开相册页");
    const media = parseAlbum(html);
    if (media.vids.length === 0) throw new Error("这个相册没有视频");
    const url = media.vids[Math.min(idx, media.vids.length - 1)];

    return {
      parse: 0,
      url: url,
      header: { "User-Agent": UA, "Referer": BASE + LOC },
    };
  }

  async action(op, value) {
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("gal|") !== 0 && s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    const html = await this.fetchPage(u);
    if (!html) return { msg: "打不开相册页" };

    const media = parseAlbum(html);
    if (media.imgs.length === 0) return { msg: "这个相册没有图片" };

    const title = pageTitle(html);
    const purl = GAL + "?u=" + encodeURIComponent(u) + "&_gv=20261113b";

    // 这站的图片路径带中文百分号编码，一张就 280 字符，50 张能到 14KB。
    // 同一相册的图都在一个目录里 → 用 ?b= 传公共前缀，片段里只放 /0001.webp 这种短名。
    const first = media.imgs[0];
    const cut = first.lastIndexOf("/");
    const dir = cut > 0 ? first.substring(0, cut) : "";
    const sameDir = dir && media.imgs.every((x) => x.substring(0, cut) === dir);
    const entries = sameDir ? media.imgs.map((x) => x.substring(cut)) : media.imgs;
    const bq = sameDir ? "&b=" + encodeURIComponent(dir) : "";

    const hash = "#t=" + encodeURIComponent(title) + bq + "&i=" + esc(entries.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + LOC + "/search?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(r.content);
    const list = this.cardsToList(cards);
    if (list.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
