import { Spider, openWeb, aesX } from "catvod";

// 每日大赛（mrds66.com）—— Typecho + Mirages 主题
// 结构：列表 /page/N/            30 篇/页
//       分类 /category/<slug>/<n>/
//       详情 /archives/<id>/
// 每篇：1~3 个视频（dplayer，data-config JSON 里的 m3u8，HLS + AES-128）
//       + 9~29 张图集（pic.gyezbp.cn/upload_01/）
//       + 一堆广告图（pic.gyezbp.cn/hc237/，必须过滤）
// ⚠ 站点直连超时，手机必须挂代理

// 站点域名会换（2026-11-07 从 mrds66.com 换到 mrds.com，内容/图床/密钥都没变）
// 主用 mrds.com，探不通就退回旧域名
const DOMAINS = ["https://mrds.com", "https://www.mrds66.com"];
let BASE = DOMAINS[0];
let baseChecked = false;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 图集画廊页（App 内 WebView 打开）
const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

const PAGE_SIZE = 30;

// 图片解密参数：从站点 /usr/plugins/ai/common/image.0821.js 里扒出来的
// AES-128-CBC，key / iv 都是 16 字节 ASCII（CryptoJS 里用 charCode 拼出来的）
const ENC_KEY = "f5d965df75336270";
const ENC_IV = "97b60394abc2fbe1";
// 同一对 key/iv 的 base64（aesX 要 base64 入参）
const ENC_KEY_B64 = "ZjVkOTY1ZGY3NTMzNjI3MA==";
const ENC_IV_B64 = "OTdiNjAzOTRhYmMyZmJlMQ==";

// 封面走代理解密；真机上不灵就改 false，退回统一占位图
const USE_COVER_PROXY = true;

// [slug, 名称]
const CATS = [
  ["mrds", "每日大赛"],
  ["ztds", "主题大赛"],
  ["rstt", "热搜吃瓜"],
  ["xazd", "校园学生"],
  ["blyp", "必撸大赛"],
  ["fctg", "反差泄密"],
  ["mhds", "网红黑料"],
  ["lqdp", "猎奇重口"],
  ["jdsj", "AV看片"],
  ["mxwh", "明星大赛"],
  ["smdh", "动漫之家"],
  ["dypd", "影视国漫"],
  ["mtds", "cos写真"],
  ["ysds", "声控ASMR"],
  ["czds", "寸止挑战"],
  ["hjds", "混剪PMV"],
  ["tgds", "原创投稿"],
  ["omjp", "欧美精品"],
  ["qwcs", "全网参赛"],
  ["aijc", "AI剧场"],
];

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + "/",
  };
}

// 探一次主域名，不行就换备用域名（只探一次，结果缓存在模块里）
async function ensureBase(spider) {
  if (baseChecked) return BASE;
  for (const d of DOMAINS) {
    try {
      const r = await spider.net.req(d + "/", { headers: hdrs(d + "/") });
      if (r && r.code === 200 && String(r.content).indexOf("每日大赛") >= 0) {
        BASE = d;
        break;
      }
    } catch (e) {
      /* 换下一个 */
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

// 列表封面只能用它：正文/封面图全是 AES 密文，原生加载器解不开
function picFallback() {
  return BASE + "/usr/themes/Mirages/images/social.jpg";
}

/* ---------- base64（QuickJS 里没有 Buffer / btoa，自己实现） ---------- */
const B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToB64(bytes) {
  let out = "";
  let i = 0;
  const n = bytes.length;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64CHARS[(v >> 18) & 63] + B64CHARS[(v >> 12) & 63] + B64CHARS[(v >> 6) & 63] + B64CHARS[v & 63];
  }
  const rest = n - i;
  if (rest === 1) {
    const v = bytes[i] << 16;
    out += B64CHARS[(v >> 18) & 63] + B64CHARS[(v >> 12) & 63] + "==";
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64CHARS[(v >> 18) & 63] + B64CHARS[(v >> 12) & 63] + B64CHARS[(v >> 6) & 63] + "=";
  }
  return out;
}

function b64ToBytes(s) {
  const out = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "=") break;
    const v = B64CHARS.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

// 列表卡片：<article> 里 <a href="/archives/<id>/">
//   封面在 <script>loadBannerDirect('…jpeg', …)</script>
//   标题在 <h2 class="post-card-title">
//   分类在 post-card-info 末尾的 <span>分类1, 分类2</span>
function parseCards(html) {
  const out = [];
  const seen = {};
  const blocks = String(html).split(/<article[\s>]/).slice(1);
  for (const b of blocks) {
    const block = b.substring(0, 6000);
    const link = block.match(/<a href="(\/archives\/(\d+)\/)"\s*>/);
    if (!link) continue;
    const url = BASE + link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const banner = block.match(/loadBannerDirect\('([^']+)'/);
    const tm =
      block.match(/class="post-card-title"[^>]*>([\s\S]{0,300}?)<div class="wrap"/) ||
      block.match(/class="post-card-title"[^>]*>([\s\S]{0,300}?)<\/h2>/);
    const title = clean(tm ? tm[1] : "");
    // 站点公告 / 广告位的卡片没有标题，直接跳过
    if (!title) continue;

    const cm = block.match(/class="post-card-info"[^>]*>([\s\S]{0,600}?)<\/div>/);
    let cats = "";
    if (cm) {
      const spans = [...cm[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => clean(m[1])).filter(Boolean);
      // 前两个 span 是作者和日期，最后一个是分类
      if (spans.length >= 3) cats = spans[spans.length - 1];
    }

    out.push({
      url: url,
      title: title,
      // 封面原地址是密文，交给 proxy() 解密后再给 App
      encPic: banner ? banner[1].replace(/^\/\//, "https://") : "",
      cats: cats,
    });
  }
  return out;
}

// 视频：<div class="dplayer" … data-config='{…"video":{"url":"…m3u8?auth_key=…"}}'>
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
    const tm = seg.match(/data-video_title="([^"]*)"/);
    out.push({ url: u, title: tm ? clean(tm[1]) : "" });
  }
  return out;
}

// 图集：只认 pic.gyezbp.cn/upload_01/，其余（hc237 = 广告）全丢
function parseImages(html) {
  const all = [
    ...new Set(
      [...String(html).matchAll(/https:\/\/pic\.gyezbp\.cn\/[^"'\s)]+?\.(?:jpe?g|png|webp)/gi)].map((m) => m[0])
    ),
  ];
  let content = all.filter((u) => u.indexOf("/upload_01/") >= 0);
  if (content.length === 0) content = all.filter((u) => !/hc237|avatar|logo|banner|nav/i.test(u));
  return content;
}

export default class Mrds extends Spider {
  init(extend) {
    this.htmlCache = {};
    this.log("mrds ready");
  }

  // 帖子页缓存：二级菜单探测过 → 详情/播放/图集直接复用
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

  // 封面：走本地代理解密（proxyUrl + proxy），失败就退回站点明文占位图
  // 真机上代理不可用（图片全裂）的话，把 USE_COVER_PROXY 改成 false 就退回占位图
  coverPic(c) {
    if (!USE_COVER_PROXY || !c.encPic) return picFallback();
    try {
      return this.proxyUrl({ u: c.encPic });
    } catch (e) {
      this.log("proxyUrl failed: " + e);
      return picFallback();
    }
  }

  // 读流全部字节
  async readBytes(stream) {
    const chunks = [];
    let total = 0;
    for (;;) {
      const buf = await stream.read(65536);
      if (!buf) break;
      const a = new Uint8Array(buf);
      chunks.push(a);
      total += a.length;
    }
    try {
      stream.close();
    } catch (e) {}
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  // App 的图片加载器会来打这个代理：取密文 → AES-128-CBC 解密 → 回原始 JPEG 字节
  async proxy(params) {
    const u = (params && (params.u || params.url)) || "";
    if (!u) return [404, "text/plain", "no url"];
    try {
      const st = await this.net.openStream(u, { headers: hdrs() });
      const bytes = await this.readBytes(st);
      if (!bytes || bytes.length === 0) return [404, "text/plain", "empty"];
      const b64 = bytesToB64(bytes);
      const plainB64 = aesX("AES/CBC/PKCS5Padding", false, b64, true, ENC_KEY_B64, ENC_IV_B64, true);
      if (!plainB64) return [404, "text/plain", "decrypt failed"];
      return [200, "image/jpeg", b64ToBytes(plainB64)];
    } catch (e) {
      this.log("cover decrypt failed: " + e);
      return [404, "text/plain", "fail"];
    }
  }

  async homeContent(filter) {
    await ensureBase(this);
    // 全站设 type_flag="1" → 列表行模式（用户指定：这站要列表排版）
    const classes = [{ type_id: "latest", type_name: "最新", type_flag: "1" }];
    for (const [slug, name] of CATS) classes.push({ type_id: slug, type_name: name, type_flag: "1" });
    classes.push({ type_id: "web", type_name: "网页", type_flag: "1" });
    return { class: classes };
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

    // ---- 二级菜单：这条帖子有哪些视频 / 图集 ----
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
        list.push({ vod_id: pageUrl, vod_name: "（没有内容）", vod_pic: "", vod_remarks: "" });
      }
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    let url;
    if (tid === "latest" || !tid) {
      url = BASE + "/" + (p > 1 ? "page/" + p + "/" : "");
    } else {
      url = BASE + "/category/" + tid + "/" + (p > 1 ? p + "/" : "");
    }

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    // 列表阶段不发额外请求，点开卡片才知道有几个视频 / 几张图
    const list = cards.map((c) => ({
      vod_id: "mix|" + c.url,
      vod_name: c.title,
      vod_pic: this.coverPic(c),
      vod_remarks: c.cats || "视频+图集",
      vod_tag: "folder",
    }));

    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const id = String(raw);
      if (id.indexOf("v|") === 0) {
        const parts = id.split("|");
        const pageUrl = parts[1] || "";
        const idx = Number(parts[2]) || 0;
        let title = "";
        let pic = "";
        let content = "";
        const html = await this.fetchPage(pageUrl);
        if (html) {
          const t = html.match(/<title>([^<]*)<\/title>/);
          if (t) title = clean(t[1]).replace(/\s*-\s*每日大赛\s*$/, "");
          const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
          if (og) pic = og[1];
          const vids = parseVideos(html);
          const imgs = parseImages(html);
          content = "视频 " + vids.length + " 个 · 图集 " + imgs.length + " 张";
        }
        list.push({
          vod_id: id,
          vod_name: title || "视频",
          vod_pic: pic,
          vod_content: content,
          vod_play_from: "每日大赛",
          vod_play_url: "正片$" + id,
        });
        continue;
      }

      // 兜底：直接给了页面地址
      const pageUrl = id.indexOf("http") === 0 ? id : BASE + id;
      const html = await this.fetchPage(pageUrl);
      const vids = html ? parseVideos(html) : [];
      let title = "";
      if (html) {
        const t = html.match(/<title>([^<]*)<\/title>/);
        if (t) title = clean(t[1]).replace(/\s*-\s*每日大赛\s*$/, "");
      }
      list.push({
        vod_id: "v|" + pageUrl + "|0",
        vod_name: title || "视频",
        vod_pic: "",
        vod_content: vids.length ? "视频 " + vids.length + " 个" : "该帖没有视频",
        vod_play_from: "每日大赛",
        vod_play_url: "正片$v|" + pageUrl + "|0",
      });
      void vids;
    }
    return { list: list };
  }

  // m3u8 带 auth_key，且会过期 → 每次播放都重新取一次页面
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

  // 点「查看图集」→ 全部图片塞进画廊页（列表放 # 片段，不受 8KB 请求行限制）
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
    if (t) title = clean(t[1]).replace(/\s*-\s*每日大赛\s*$/, "");

    const purl = GAL + "?u=" + encodeURIComponent(u);
    const short = imgs.map((x) => (x.indexOf("https://pic.gyezbp.cn") === 0 ? x.substring(21) : x)).join("|");
    // 图片是 AES-128-CBC 整体加密的（站点用 CryptoJS 在浏览器里解），
    // 把 key / iv 交给画廊页，由 WebCrypto 解 —— 见 gallery.html 的 initEnc()
    const hash =
      "#t=" + encodeURIComponent(title) +
      "&b=" + encodeURIComponent("https://pic.gyezbp.cn") +
      "&i=" + esc(short) +
      "&k=" + ENC_KEY +
      "&v=" + ENC_IV;
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    await ensureBase(this);
    const p = Number(pg) || 1;
    const url = BASE + "/search/" + encodeURIComponent(key) + "/" + (p > 1 ? p + "/" : "");

    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);

    const list = cards.map((c) => ({
      vod_id: "mix|" + c.url,
      vod_name: c.title,
      vod_pic: this.coverPic(c),
      vod_remarks: c.cats || "视频+图集",
      vod_tag: "folder",
    }));
    return this.page(list, p, PAGE_SIZE, (p + 1) * PAGE_SIZE);
  }
}
