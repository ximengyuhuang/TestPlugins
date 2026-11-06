import { Spider, openWeb } from "catvod";

const BASE = "https://www.xiaocongzy.com";
const CDN = "https://img.ziyuanquancdn.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 画廊页地址
// 线上：https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html
// 本地调试改回：http://192.168.110.70:8000/gallery.html
const GAL = "https://ximengyuhuang.github.io/TestPlugins/fongmi-plugin/gallery.html";

// 首页归档分类（来自 /navigation）
const ARCHIVES = [
  ["daoyuqudao", "岛遇渠道"],
  ["huanyuxingqiu", "欢愉星球"],
  ["weimiquan", "微密圈"],
  ["gengxinyuan1", "更新源1"],
  ["gengxinyuan2", "更新源2"],
  ["gengxinyuan3", "更新源3"],
  ["siyuquan", "丝语圈"],
  ["miyukongjian", "秘语空间"],
  ["yutangquan", "语堂圈"],
  ["tiefenkongjian", "铁粉空间"],
];

const TAG_SITEMAPS = [
  "/post_tag-sitemap.xml",
  "/post_tag-sitemap2.xml",
  "/post_tag-sitemap3.xml",
];

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
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeName(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

// 站点自己的标题串，两种格式：
//   列表页： 作者 | 2026-11-06 视频 🎬 | 正文标题
//   搜索页： 作者 2025-08-02 00:00:29 #话题…
// 返回 {author, date, kind, title}，认不出来就整体当标题
function splitTitle(full) {
  const s = clean(full);
  let m = s.match(/^(.+?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*([^|]*)\|\s*([\s\S]+)$/);
  if (m) {
    return { author: m[1].trim(), date: m[2], kind: m[3].trim(), title: m[4].trim() };
  }
  m = s.match(/^(.+?)\s+(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}:\d{2}\s+([\s\S]+)$/);
  if (m) {
    return { author: m[1].trim(), date: m[2], kind: "", title: m[3].trim() };
  }
  return { author: "", date: "", kind: "", title: s };
}

// 解析列表卡片：返回 {url,title,author,pic,mp4,count,isVideo}
function parseCards(html) {
  const out = [];
  const seen = {};
  const blocks = html.split(/<article[^>]*class="post-card/).slice(1);
  for (const b of blocks) {
    const block = b.substring(0, 6000);
    const link = block.match(/<h2 class="post-title">\s*<a href="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const tt = splitTitle(link[2]);

    // 视频：<video ... src="…mp4">  或  <source src="…mp4">
    let mp4 = "";
    const v1 = block.match(/<video[^>]*\ssrc="(https?:\/\/[^"]+\.mp4[^"]*)"/);
    const v2 = block.match(/<source[^>]*\ssrc="(https?:\/\/[^"]+\.mp4[^"]*)"/);
    if (v1) mp4 = v1[1];
    else if (v2) mp4 = v2[1];

    let poster = "";
    const p1 = block.match(/<video[^>]*\sposter="([^"]+)"/);
    if (p1) poster = p1[1];

    // 封面兜底：卡片里的第一张图
    if (!poster) {
      const im = block.match(/<img[^>]+src="(https?:\/\/img\.ziyuanquancdn\.com\/[^"]+)"/);
      if (im) poster = im[1];
    }

    // 图集张数徽章：<span class="img-count-badge">共 7 张</span>
    let count = 0;
    const bd = block.match(/img-count-badge">\s*共?\s*(\d+)\s*张/);
    if (bd) count = Number(bd[1]);

    out.push({
      url: url,
      title: tt.title,
      author: tt.author,
      date: tt.date,
      pic: poster,
      mp4: mp4,
      count: count,
      isVideo: mp4 !== "",
    });
  }
  return out;
}

// 从帖子页提取全部图片
function parseImages(html) {
  const out = [];
  const seen = {};
  const re = /(https:\/\/img\.ziyuanquancdn\.com\/[^"'\s\\]+?\.(?:jpg|jpeg|png|webp))/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = 1;
    out.push(m[1]);
  }
  return out;
}

function cardName(c) {
  return c.author ? c.author + " · " + c.title : c.title;
}

function cardRemarks(c) {
  if (c.isVideo) return "视频";
  return c.count ? "图集 · " + c.count + "张" : "图集";
}

export default class Xiaocong extends Spider {
  init(extend) {}

  // 抓 sitemap 里的博主标签（约 2425 个）
  async loadTags() {
    if (this.tags && this.tags.length) return this.tags;
    const list = [];
    const seen = {};
    for (const sm of TAG_SITEMAPS) {
      try {
        const r = await this.net.req(BASE + sm, { headers: hdrs(BASE + "/sitemap.xml") });
        if (!r || r.code !== 200) continue;
        const re = /<loc>[^<]*\/tags\/([^<]+)<\/loc>/g;
        let m;
        while ((m = re.exec(r.content)) !== null) {
          const slug = m[1].replace(/\/$/, "");
          if (!slug || seen[slug]) continue;
          seen[slug] = 1;
          list.push({ slug: slug, name: decodeName(slug) });
        }
      } catch (e) {
        this.log("tag sitemap failed: " + e);
      }
    }
    list.sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    this.tags = list;
    return list;
  }

  // 按首字母分组
  groupLetters() {
    const g = {};
    for (const t of this.tags || []) {
      const ch = String(t.name).charAt(0).toUpperCase();
      const key = ch >= "A" && ch <= "Z" ? ch : "#";
      g[key] = g[key] || [];
      g[key].push(t);
    }
    this.groups = Object.keys(g)
      .sort()
      .map((k) => ({ key: k, items: g[k] }));
    return this.groups;
  }

  async homeContent(filter) {
    await this.loadTags();
    this.groupLetters();
    const classes = [
      { type_id: "latest", type_name: "最新" },
      { type_id: "web", type_name: "网页" },
      { type_id: "archf", type_name: "归档 (" + ARCHIVES.length + ")", type_flag: "1" },
      { type_id: "authf", type_name: "博主 (" + (this.tags ? this.tags.length : 0) + ")", type_flag: "1" },
    ];
    return { class: classes };
  }

  // 文件夹层
  folderList(tid) {
    if (tid === "archf") {
      return ARCHIVES.map(([slug, name]) => ({
        vod_id: "a:" + slug,
        vod_name: name,
        vod_pic: "",
        vod_remarks: "归档",
        vod_tag: "folder",
      }));
    }
    if (tid === "authf") {
      return this.groupLetters().map((g) => ({
        vod_id: "seg:" + g.key,
        vod_name: g.key,
        vod_pic: "",
        vod_remarks: g.items.length + " 位",
        vod_tag: "folder",
      }));
    }
    if (tid.indexOf("seg:") === 0) {
      const key = tid.substring(4);
      const g = this.groupLetters().find((x) => x.key === key);
      if (!g) return [];
      return g.items.map((t) => ({
        vod_id: "b:" + t.slug,
        vod_name: t.name,
        vod_pic: "",
        vod_remarks: "博主",
        vod_tag: "folder",
      }));
    }
    return [];
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;

    // ---- 文件夹 ----
    if (tid === "archf" || tid === "authf" || tid.indexOf("seg:") === 0) {
      if (tid !== "archf" && (!this.tags || !this.tags.length)) await this.loadTags();
      const list = this.folderList(tid);
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 12, 0);
    }

    // ---- 视频/图集列表 ----
    let path = "/";
    if (tid === "latest") path = "/";
    else if (tid.indexOf("a:") === 0) path = "/" + tid.substring(2) + "/";
    else if (tid.indexOf("b:") === 0) path = "/tags/" + tid.substring(2) + "/";
    else path = "/" + tid + "/";

    const url = BASE + path + (p > 1 ? "page/" + p + "/" : "");
    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, 12, 0);

    const raw = parseCards(r.content);
    if (raw.length === 0) return this.page([], p, 12, (p - 1) * 12);

    const list = raw
      .filter((c) => c.isVideo || c.pic) // 丢掉纯文字公告帖
      .map((c) => {
        if (c.isVideo) {
          // 视频：把 mp4 直接带进 id，点开即播，不用再请求详情
          return {
            vod_id: "v|" + c.url + "|" + c.mp4 + "|" + c.pic,
            vod_name: cardName(c),
            vod_pic: c.pic,
            vod_remarks: cardRemarks(c),
          };
        }
        // 图集：卡片上挂 action，点开画廊
        return {
          vod_id: c.url,
          vod_name: cardName(c),
          vod_pic: c.pic,
          vod_remarks: cardRemarks(c),
          action: "gal:" + c.url,
        };
      });

    return this.page(list, p, 12, (p + 1) * 12);
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const s = String(id);
      if (s.indexOf("v|") === 0) {
        const parts = s.split("|");
        const pageUrl = parts[1] || "";
        const mp4 = parts[2] || "";
        let pic = parts[3] || "";
        let name = "视频";
        let content = "";

        try {
          const r = await this.net.req(pageUrl, { headers: hdrs() });
          if (r && r.code === 200) {
            const t = r.content.match(/<title>([^<]*)<\/title>/);
            if (t) {
              const raw = clean(t[1]).replace(/\s*-\s*小葱资源\s*$/, "");
              const tt = splitTitle(raw);
              name = tt.author ? tt.author + " · " + tt.title : tt.title || name;
            }
            const og = r.content.match(/property="og:image"[^>]*content="([^"]+)"/);
            if (og) pic = og[1];
            const ex = r.content.match(/<p class="post-excerpt">([\s\S]*?)<\/p>/);
            const desc = ex ? clean(ex[1]).replace(/…$/, "").slice(0, 120) : "";
            content = (desc ? desc + "\n" : "") + "类型: 视频";
          }
        } catch (e) {
          this.log("detail failed: " + e);
        }

        list.push({
          vod_id: id,
          vod_name: name,
          vod_pic: pic,
          vod_content: content,
          vod_play_from: "小葱资源",
          vod_play_url: "正片$" + id,
        });
        continue;
      }

      // 图集帖（一般不走到这里）
      list.push({
        vod_id: id,
        vod_name: "图集",
        vod_pic: "",
        vod_content: "",
        vod_play_from: "小葱资源",
        vod_play_url: "查看图集$" + id,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const s = String(id);
    if (s.indexOf("v|") === 0) {
      const parts = s.split("|");
      const mp4 = parts[2] || "";
      if (!mp4) throw new Error("没有视频地址");
      return {
        parse: 0,
        url: mp4,
        header: { "User-Agent": UA, "Referer": BASE + "/" },
      };
    }
    throw new Error("这是图集，请从列表点卡片打开");
  }

  // 图集卡片点击 → 把图片列表塞进 URL，画廊页秒开
  async action(op, value) {
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("gal:") !== 0) return { msg: "未知操作" };
    const u = s.substring(4);

    let title = "";
    let imgs = [];
    try {
      const r = await this.net.req(u, { headers: hdrs() });
      if (r && r.code === 200) {
        imgs = parseImages(r.content);
        const t = r.content.match(/<title>([^<]*)<\/title>/);
        if (t) {
          const raw = clean(t[1]).replace(/\s*-\s*小葱资源\s*$/, "");
          const tt = splitTitle(raw);
          title = tt.author ? tt.author + " · " + tt.title : tt.title;
        }
      }
    } catch (e) {
      this.log("gallery prefetch failed: " + e);
    }

    // 图片列表放进 URL 片段（#）里：片段不发给服务器，所以不会被 GitHub Pages
    // 的 8KB 请求行上限拦成 414；query 里只留帖子地址做兜底
    const esc = (s) =>
      String(s).replace(/%/g, "%25").replace(/&/g, "%26").replace(/#/g, "%23").replace(/\+/g, "%2B").replace(/ /g, "%20");
    const purl = GAL + "?u=" + encodeURIComponent(u);
    if (imgs.length === 0) return { web: { url: purl, mode: "view" } };

    // 图片只传路径，页面前缀补全
    const short = imgs.map((x) => x.replace(CDN, "")).join("|");
    const hash = "#t=" + encodeURIComponent(title) + "&b=" + encodeURIComponent(CDN) + "&i=" + esc(short);
    return { web: { url: purl + hash, mode: "view" } };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + "/?s=" + encodeURIComponent(key) + (p > 1 ? "&paged=" + p : "");
    const r = await this.net.req(url, { headers: hdrs() });
    if (!r || r.code !== 200) return this.page([], p, 12, 0);

    const raw = parseCards(r.content);
    if (raw.length === 0) return this.page([], p, 12, (p - 1) * 12);

    const list = raw
      .filter((c) => c.isVideo || c.pic)
      .map((c) => {
        if (c.isVideo) {
          return {
            vod_id: "v|" + c.url + "|" + c.mp4 + "|" + c.pic,
            vod_name: cardName(c),
            vod_pic: c.pic,
            vod_remarks: cardRemarks(c),
          };
        }
        return {
          vod_id: c.url,
          vod_name: cardName(c),
          vod_pic: c.pic,
          vod_remarks: cardRemarks(c),
          action: "gal:" + c.url,
        };
      });
    return this.page(list, p, 12, (p + 1) * 12);
  }
}
