// javtiful.com —— FongMi / TVBox QuickJS 源
//
// 取流：视频页 <script id="watch-config"> 里有 playback.endpoint + ticket
//       → POST endpoint (ticket) → {"sources":[{src,type}]}
//       → src 是带 expires/signature 的 MP4 直链（整片，无广告）

import { Spider, openWeb } from "catvod";

const BASE = "https://javtiful.com";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// [tid, 路径, 名称]
const CATS = [
  ["new", "/videos", "最新"],
  ["viewed", "/videos?sort=most_viewed", "最多观看"],
  ["rated", "/videos?sort=top_rated", "评分最高"],
  ["chinese", "/category/chinese-av", "国产AV"],
  ["mature", "/category/mature-woman", "成熟女性"],
  ["amateur", "/category/amateur", "素人"],
  ["beauty", "/category/beautiful-girl", "美少女"],
  ["married", "/category/married-woman", "人妻"],
  ["bigtits", "/category/big-tits", "巨乳"],
  ["school", "/category/school-girls", "学生"],
  ["drama", "/category/drama", "剧情"],
  ["affair", "/category/affair", "出轨"],
  ["office", "/category/office-lady", "OL"],
  ["student", "/category/female-student", "女学生"],
  ["cosplay", "/category/cosplay", "Cosplay"],
  ["teacher", "/category/female-teacher", "女教师"],
  ["milf", "/category/milf", "熟女"],
  ["nurse", "/category/nurse", "护士"],
  ["boss", "/category/female-boss", "女上司"],
  ["sister", "/category/sister-in-law", "嫂子"],
];

// PornHub 标准分类（29 个），本站用搜索实现；值以 / 开头则直接用该路径
const GENRES = [
  ["Asian", "asian"], ["Japanese", "japanese"], ["Uncensored", "/uncensored"], ["Korean", "korean"],
  ["Amateur", "amateur"], ["Anal", "anal"], ["Big Ass", "big-ass"],
  ["Big Tits", "big-tits"], ["Blonde", "blonde"], ["Blowjob", "blowjob"],
  ["Brunette", "brunette"], ["Cosplay", "cosplay"], ["Creampie", "creampie"],
  ["Cuckold", "cuckold"], ["Ebony", "ebony"], ["Fetish", "fetish"],
  ["Handjob", "handjob"], ["Hardcore", "hardcore"], ["Latina", "latina"],
  ["Lesbian", "lesbian"], ["Massage", "massage"], ["Mature", "mature"],
  ["MILF", "milf"], ["Masturbation", "masturbation"], ["POV", "pov"],
  ["Public", "public"], ["Squirt", "squirt"], ["Threesome", "threesome"],
  ["Toys", "toys"],
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
  if (u.indexOf("http") === 0) return u;
  return BASE + "/" + u;
}

// 卡片：<article class="video-card">
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/<article class="video-card/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].substring(0, 3000);

    const t = block.match(/<a href="([^"]+)" class="video-card__title"\s+title="([^"]*)"/) ||
              block.match(/class="video-card__title"[^>]*href="([^"]+)"[^>]*title="([^"]*)"/) ||
              block.match(/<a href="([^"]+)" class="video-card__title"[^>]*>([^<]*)</);
    if (!t) continue;
    const url = absolute(t[1]);
    if (!url || seen[url] || url.indexOf("/video/") < 0) continue;
    seen[url] = 1;

    const img = block.match(/<img[^>]*data-front-lazy-src="([^"]+)"/) || block.match(/<img[^>]*data-front-lazy-current-src="([^"]+)"/);
    const det = block.match(/<span class="video-card__details">([\s\S]{0,120}?)<\/span>/);
    let dur = "";
    let q = "";
    if (det) {
      const dm = det[1].match(/(\d{1,2}:\d{2}:\d{2})/);
      if (dm) dur = dm[1];
      const qm = det[1].match(/<strong[^>]*>([^<]{1,8})<\/strong>/);
      if (qm) q = strip(qm[1]);
    }

    // 角标：有清晰度就用「FHD 02:48:06」，否则只显示时长
    let remark = "";
    if (q && dur) remark = q + " " + dur;
    else if (q) remark = q;
    else if (dur) remark = dur;

    out.push({
      vod_id: url,
      vod_name: decode(t[2]) || strip(t[2]),
      vod_pic: img ? absolute(img[1]) : "",
      vod_remarks: remark,
    });
  }
  return out;
}

export default class Javtiful extends Spider {
  init(extend) {
    this.log("javtiful ready");
  }

  async homeContent(filter) {
    // CATS = [最新, 最多观看, 评分最高, ...题材]
    const sorts3 = CATS.slice(0, 3);
    const themes = CATS.slice(3);
    const classes = sorts3.map(([k, , n]) => ({ type_id: k, type_name: n }));
    classes.splice(1, 0, { type_id: "web", type_name: "网页" });

    // 动态补全分类：/categories 页的 category-card
    if (!this.cats) {
      try {
        const r = await this.net.req(BASE + "/categories", { headers: headers() });
        if (r && r.code === 200) {
          const list = [];
          const re = /<a class="category-card" href="([^"]+)"[\s\S]{0,500}?alt="([^"]*)"/g;
          let m;
          while ((m = re.exec(r.content)) !== null) {
            const path = m[1];
            const name = decode(m[2]).trim();
            if (name && path && path.indexOf("/category/") >= 0) list.push([name, path]);
          }
          this.cats = list;
        }
      } catch (e) {
        this.log("categories failed: " + e);
      }
    }

    // 动态分类收进「分类」文件夹（不在首页平铺）
    const dyn = (this.cats || []).slice();

    // 二级结构：题材 / 分类 / 标准分类 三个文件夹入口
    classes.push({ type_id: "themef", type_name: "题材 (" + themes.length + ")", type_flag: "1" });
    classes.push({ type_id: "catf", type_name: "分类 (" + dyn.length + ")", type_flag: "1" });
    classes.push({ type_id: "genf", type_name: "标准分类 (" + GENRES.length + ")", type_flag: "1" });

    // 排序筛选器（右下角漏斗；分类页会忽略，列表页生效）
    const sorts = [
      { n: "最新", v: "" },
      { n: "最多观看", v: "most_viewed" },
      { n: "评分最高", v: "top_rated" },
    ];
    const filters = {};
    for (const c of classes) filters[c.type_id] = [{ key: "sort", name: "排序", value: sorts }];
    for (const [name] of GENRES) filters["g:" + name] = [{ key: "sort", name: "排序", value: sorts }];
    for (const [, path] of dyn) filters["c:" + path] = [{ key: "sort", name: "排序", value: sorts }];

    return { class: classes, filters: filters };
  }

  // 题材文件夹
  themeFolders() {
    return CATS.slice(3).map(([key, , name]) => ({
      vod_id: "t:" + key,
      vod_name: name,
      vod_pic: "",
      vod_remarks: "题材",
      vod_tag: "folder",
    }));
  }

  // 分类文件夹：动态分类
  catFolders() {
    return (this.cats || []).map(([name, path]) => ({
      vod_id: "c:" + path,
      vod_name: name,
      vod_pic: "",
      vod_remarks: "分类",
      vod_tag: "folder",
    }));
  }

  // 标准分类文件夹
  genreFolders() {
    return GENRES.map(([name]) => ({
      vod_id: "g:" + name,
      vod_name: name,
      vod_pic: "",
      vod_remarks: "标准",
      vod_tag: "folder",
    }));
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

    // ---- 文件夹导航层 ----
    if (tid === "themef") {
      const list = this.themeFolders();
      return this.page(list, 1, list.length, list.length);
    }
    if (tid === "catf") {
      const list = this.catFolders();
      return this.page(list, 1, list.length, list.length);
    }
    if (tid === "genf") {
      const list = this.genreFolders();
      return this.page(list, 1, list.length, list.length);
    }

    let path = CATS[0][1];
    if (tid.indexOf("c:") === 0) {
      path = tid.substring(2);
    } else if (tid.indexOf("t:") === 0) {
      const key = tid.substring(2);
      for (const c of CATS) {
        if (c[0] === key) {
          path = c[1];
          break;
        }
      }
    } else {
      for (const c of CATS) {
        if (c[0] === tid) {
          path = c[1];
          break;
        }
      }
    }

    const p = Number(pg) || 1;

    // 标准分类：值以 / 开头用路径，否则走搜索
    if (tid.indexOf("g:") === 0) {
      const name = tid.substring(2);
      let val = "";
      for (const g of GENRES) {
        if (g[0] === name) {
          val = g[1];
          break;
        }
      }

      let url;
      if (val.indexOf("/") === 0) {
        url = BASE + val + (p > 1 ? "?page=" + p : "");
      } else {
        url = BASE + "/search?q=" + encodeURIComponent(name) + (p > 1 ? "&page=" + p : "");
      }

      const r = await this.net.req(url, { headers: headers() });
      if (!r || r.code !== 200) return this.page([], p, 24, 0);
      const cards = parseCards(r.content);
      if (cards.length === 0) return this.page([], p, 24, (p - 1) * 24);
      return this.page(cards, p, 24, (p + 1) * 24);
    }

    const sep = path.indexOf("?") >= 0 ? "&" : "?";
    const sort = (extend && extend.sort) || "";
    let url = BASE + path + (p > 1 ? sep + "page=" + p : "");
    if (sort) url += (url.indexOf("?") >= 0 ? "&" : "?") + "sort=" + sort;

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
      let duration = "";

      try {
        const r = await this.net.req(pageUrl, { headers: headers() });
        if (r && r.code === 200) {
          const html = r.content;

          const ogt = html.match(/property="og:title"[^>]*content="([^"]+)"/);
          const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          title = ogt ? decode(ogt[1]) : h1 ? strip(h1[1]) : "";
          title = title.replace(/\s*[-|]\s*Javtiful.*$/i, "").trim();

          const ogi = html.match(/property="og:image"[^>]*content="([^"]+)"/);
          pic = ogi ? decode(ogi[1]) : "";

          const d = html.match(/(\d{1,2}:\d{2}:\d{2})/);
          if (d) duration = d[1];

          const lines = [];
          if (duration) lines.push("时长: " + duration);

          const tags = [];
          const reT = /href="https:\/\/javtiful\.com\/(?:zh\/)?(?:category|tag)\/([^"\/]+)"/g;
          let m;
          while ((m = reT.exec(html)) !== null) {
            try {
              const g = decodeURIComponent(m[1]);
              if (tags.indexOf(g) < 0) tags.push(g);
            } catch (e) {}
          }
          if (tags.length) lines.push("分类: " + tags.slice(0, 10).join(" / "));

          const desc = html.match(/property="og:description"[^>]*content="([^"]+)"/);
          if (desc) lines.push(decode(desc[1]).substring(0, 120));

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
        vod_remarks: duration,
        vod_play_from: "javtiful",
        vod_play_url: "正片$" + pageUrl,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const pageUrl = String(id).indexOf("http") === 0 ? String(id) : absolute(String(id));

    const r = await this.net.req(pageUrl, { headers: headers() });
    if (!r || r.code !== 200) throw new Error("无法打开详情页");

    // watch-config 里的 playback
    const m = r.content.match(/<script[^>]*id="watch-config"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("找不到 watch-config");

    let cfg;
    try {
      cfg = JSON.parse(m[1].trim());
    } catch (e) {
      throw new Error("watch-config 解析失败");
    }

    const pb = cfg.playback || {};
    const endpoint = pb.endpoint || "";
    const ticket = pb.ticket || "";
    if (!endpoint || !ticket) throw new Error("缺少播放参数");

    const ep = endpoint.indexOf("http") === 0 ? endpoint : BASE + endpoint;

    // POST ticket 换 sources
    const r2 = await this.net.req(ep, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": pageUrl,
        "Origin": BASE,
      },
      body: "ticket=" + encodeURIComponent(ticket),
    });

    if (!r2 || r2.code !== 200) throw new Error("换源失败");

    let data;
    try {
      data = JSON.parse(r2.content);
    } catch (e) {
      throw new Error("换源返回解析失败");
    }

    const sources = data.sources || [];
    if (!sources.length) throw new Error("没有可用源");

    // 按 URL 里的 1080p/720p/480p 归类（多画质交给播放器切）
    function qualityOf(u) {
      const q = String(u).match(/(\d{3,4})p/);
      return q ? Number(q[1]) : 0;
    }

    const values = [];
    const seenSrc = {};
    for (const s of sources) {
      const src = s && s.src ? absolute(s.src) : "";
      if (!src || seenSrc[src]) continue;
      seenSrc[src] = 1;
      const q = qualityOf(src);
      values.push({ n: q ? q + "P" : "源" + (values.length + 1), v: src, q: q });
    }
    values.sort((a, b) => b.q - a.q);
    if (values.length === 0) throw new Error("没有可用源");

    const urlField = values.length > 1
      ? { values: values.map((x) => ({ n: x.n, v: x.v })), position: 0 }
      : values[0].v;

    return {
      parse: 0,
      url: urlField,
      header: { "User-Agent": UA, "Referer": pageUrl },
    };
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = BASE + (p > 1 ? "/search?page=" + p + "&q=" : "/search?q=") + encodeURIComponent(key);

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 24, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 24, (p - 1) * 24);
    return this.page(cards, p, 24, (p + 1) * 24);
  }
}
