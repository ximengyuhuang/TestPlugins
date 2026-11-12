import { Spider, openWeb } from "catvod";

// 今日看料（kanliao19.one）—— Typecho + Mirages 主题，和「每日大赛」同源模板
// 列表 /page/N/（23 篇/页）、分类 /category/<slug>/、详情 /archives/<id>/
// 每篇：dplayer + 明文 m3u8（无 auth_key、无加密分片）+ 明文图集（/usr/uploads/）
// ⚠ 直连不通，手机必须走代理

const DOMAINS = ["https://kanliao19.one"];
let BASE = DOMAINS[0];
let baseChecked = false;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 23;

// [slug, 名称]
const CATS = [
  ["rdgz", "热点关注"],
  ["dy", "抖音"],
  ["ks", "快手"],
  ["douyu", "斗鱼"],
  ["hy", "虎牙"],
  ["hj", "花椒"],
  ["tt", "推特"],
  ["wh", "网红"],
  ["asmr", "ASMR"],
  ["xb", "X播"],
  ["xsp", "小视频"],
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/",
  };
}

async function ensureBase(spider) {
  if (baseChecked) return BASE;
  for (const d of DOMAINS) {
    try {
      const r = await spider.net.req(d + "/", { headers: hdrs(d + "/") });
      if (r && r.code === 200 && String(r.content).indexOf("今日看料") >= 0) {
        BASE = d;
        break;
      }
    } catch (e) {
      /* 试下一个 */
    }
  }
  baseChecked = true;
  return BASE;
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
  if (u.charAt(0) === "/") return BASE + u;
  return BASE + "/" + u;
}

// 列表卡片：<article> → <a href="…/archives/<id>/">
// 标题在 <h2 class="post-card-title"> 里，前面还塞了个 <div class="wrap">角标</div>
// 封面在 <script>loadBannerDirect('…')</script>，没有就是渐变色块
function parseCards(html) {
  const out = [];
  const seen = {};
  const blocks = String(html).split(/<article[\s>]/).slice(1);
  for (const b of blocks) {
    const block = b.substring(0, 6000);
    const link = block.match(/<a href="([^"]*\/archives\/(\d+)\/)"\s*>/);
    if (!link) continue;
    const url = abs(link[1]);
    if (seen[url]) continue;
    seen[url] = 1;

    const tm = block.match(/class="post-card-title"[^>]*>([\s\S]{0,400}?)<\/h2>/);
    let raw = tm ? tm[1].replace(/<div class="wrap">[\s\S]*?<\/div>/, "") : "";
    const title = clean(raw);
    if (!title) continue;

    const banner = block.match(/loadBannerDirect\('([^']+)'/);
    // ⚠ 卡片上的 loadBannerDirect 大多是 820×420 的广告 GIF，只有 /usr/uploads/ 才是帖子封面
    let pic = "";
    if (banner) {
      const bu = abs(banner[1]);
      if (bu.indexOf("/usr/uploads/") >= 0 && !/\.gif(\?|$)/i.test(bu)) pic = bu;
    }
    const cm = block.match(/class="post-card-info"[^>]*>([\s\S]{0,600}?)<\/div>/);
    let cats = "";
    if (cm) {
      const spans = [...cm[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => clean(m[1])).filter(Boolean);
      if (spans.length >= 3) cats = spans[spans.length - 1];
    }

    out.push({
      url: url,
      title: title,
      pic: pic,
      cats: cats,
    });
  }
  return out;
}

// 视频：<div class="dplayer" data-config='{"video":{"url":"…m3u8"}}'>
function parseVideos(html) {
  const out = [];
  const src = String(html);
  const re = /<div class="dplayer"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const seg = src.substring(m.index, m.index + 6000);
    const cfgM = seg.match(/data-config='([\s\S]{0,4000}?)'/);
    if (!cfgM) continue;
    const um = cfgM[1].match(/"url":"([^"]+?\.m3u8[^"]*)"/);
    if (!um) continue;
    const u = um[1].replace(/\\\//g, "/");
    if (out.some((x) => x.url === u)) continue;
    out.push({ url: u });
  }
  return out;
}

// 图集：正文图都在 /usr/uploads/，其余全是广告图（.gif banner、gravatar 头像…）
function parseImages(html) {
  const src = String(html);
  const out = [];
  const seen = {};
  const re = /<img[^>]+(?:data-src|data-original|src)="([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const u = abs(m[1].replace(/&amp;/g, "&"));
    if (!u) continue;
    if (u.indexOf("/usr/uploads/") < 0) continue;
    if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)) continue;
    if (seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

export default class Kanliao extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.log("kanliao ready");
  }

  cacheGet(url) {
    const c = this.htmlCache && this.htmlCache[url];
    return c && Date.now() - c.ts < 120000 ? c.html : "";
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

  // 并发探测每篇的媒体构成（8 个一批），顺手把 HTML 灌进缓存
  async probePages(urls) {
    const out = {};
    const BATCH = 8;
    for (let i = 0; i < urls.length; i += BATCH) {
      const slice = urls.slice(i, i + BATCH);
      await Promise.all(
        slice.map(async (u) => {
          try {
            const html = await this.fetchPage(u);
            if (!html) return;
            out[u] = { vids: parseVideos(html).length, imgs: parseImages(html).length };
          } catch (e) {
            /* 单篇失败跳过 */
          }
        })
      );
    }
    return out;
  }

  // 按「视频 / 图集 / 混合」三态生成卡片（纯文字帖丢掉）
  buildCards(cards, info) {
    const out = [];
    for (const c of cards) {
      const k = info[c.url];
      if (k && k.vids === 0 && k.imgs === 0) continue;
      if (k && k.vids > 0 && k.imgs === 0) {
        out.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: k.vids + " 个视频" });
        continue;
      }
      if (k && k.vids === 0 && k.imgs > 0) {
        out.push({
          vod_id: c.url,
          vod_name: c.title,
          vod_pic: c.pic,
          vod_remarks: "图集 · " + k.imgs + " 张",
          action: "gal:" + c.url,
        });
        continue;
      }
      out.push({
        vod_id: "mix|" + c.url,
        vod_name: c.title,
        vod_pic: c.pic,
        vod_remarks: k ? k.vids + " 视频 · " + k.imgs + " 图" : c.cats || "视频+图集",
        vod_tag: "folder",
      });
    }
    return out;
  }

  async homeContent(filter) {
    await ensureBase(this);
    const classes = [{ type_id: "latest", type_name: "最新", type_flag: "1" }];
    for (const [slug, name] of CATS) classes.push({ type_id: slug, type_name: name, type_flag: "1" });
    classes.push({ type_id: "web", type_name: "网页", type_flag: "1" });    return { class: classes };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    if (tid !== "web") await ensureBase(this);

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, PAGE_SIZE, 0);
    }

    // 二级菜单：一篇帖子有哪些视频 / 图集
    if (tid.indexOf("mix|") === 0) {
      const pageUrl = tid.substring(4);
      const html = await this.fetchPage(pageUrl);
      const list = [];
      if (html) {
        const vids = parseVideos(html);
        const imgs = parseImages(html);
        vids.forEach((v, i) => {
          list.push({
            vod_id: "v|" + pageUrl + "|" + i,
            vod_name: "▶ 播放视频" + (vids.length > 1 ? " " + (i + 1) : ""),
            vod_pic: "",
            vod_remarks: vids.length > 1 ? "版本 " + (i + 1) : "视频",
          });
        });
        if (imgs.length > 0) {
          list.push({
            vod_id: "gal|" + pageUrl,
            vod_name: "🖼 查看图集 (" + imgs.length + " 张)",
            vod_pic: "",
            vod_remarks: "图集",
            action: "gal|" + pageUrl,
          });
        }
      }
      if (list.length === 0) {
        list.push({ vod_id: pageUrl, vod_name: "（没有内容 / 帖子已失效）", vod_pic: "", vod_remarks: "" });
      }
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url;
    if (tid === "latest" || !tid) {
      url = BASE + "/" + (p > 1 ? "page/" + p + "/" : "");
    } else {
      // 分类翻页是 /category/<slug>/<n>/，不是 /page/N/
      url = BASE + "/category/" + tid + "/" + (p > 1 ? p + "/" : "");
    }

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    // 列表阶段并发探测（结果进 htmlCache，点开时不再重复请求）
    const info = await this.probePages(cards.map((c) => c.url));
    const list = this.buildCards(cards, info);

    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const id = String(raw);
      const isV = id.indexOf("v|") === 0;
      const parts = isV ? id.split("|") : [];
      const pageUrl = isV ? parts[1] || "" : id.indexOf("http") === 0 ? id : BASE + id;
      const idx = isV ? Number(parts[2]) || 0 : 0;

      let title = "";
      let pic = "";
      let content = "";
      const html = await this.fetchPage(pageUrl);
      if (html) {
        const t = html.match(/<title>([^<]*)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*-\s*今日看料.*$/, "");
        const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
        if (og) pic = abs(og[1]);
        const vids = parseVideos(html);
        const imgs = parseImages(html);
        content = "视频 " + vids.length + " 个 · 图集 " + imgs.length + " 张";
      }

      const vid = isV ? id : "v|" + pageUrl + "|0";
      list.push({
        vod_id: vid,
        vod_name: title || "视频",
        vod_pic: pic,
        vod_content: content,
        vod_play_from: "今日看料",
        vod_play_url: "正片$" + vid,
      });
      void idx;
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
    if (!html) throw new Error("打不开帖子页");

    const vids = parseVideos(html);
    if (vids.length === 0) throw new Error("该帖没有视频");
    const v = vids[Math.min(idx, vids.length - 1)];

    return {
      parse: 0,
      url: v.url,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  // 图集：图片是明文，直接塞给画廊页
  async action(op, value) {
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("gal|") !== 0 && s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    const html = await this.fetchPage(u);
    if (!html) return { msg: "打不开帖子页" };

    const imgs = parseImages(html);
    if (imgs.length === 0) return { msg: "这个帖子没有图片" };

    let title = "";
    const t = html.match(/<title>([^<]*)<\/title>/);
    if (t) title = clean(t[1]).replace(/\s*-\s*今日看料.*$/, "");

    const purl = GAL + "?u=" + encodeURIComponent(u);
    const hash = "#t=" + encodeURIComponent(title) + "&i=" + esc(imgs.join("|"));
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    await ensureBase(this);
    const p = Number(pg) || 1;
    const url = BASE + "/?s=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const info = await this.probePages(cards.map((c) => c.url));
    const list = this.buildCards(cards, info);
    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
