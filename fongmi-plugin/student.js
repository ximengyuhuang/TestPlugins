// msdtr2ym.student41.xyz —— BiliTV / catvod QuickJS 插件
//
// 侦查结论（2026-11-26，修正版）：
//   站型   **纯视频站**（MacCMS 系，模板 student），不是图集站
//   列表   /<中文路径>/?fby                          首页 24 条（路径「力争上游」，须 URL 编码）
//           /vodtype/<id>.html                       分类，24 条/页
//           分页 **-页码 后缀**：/vodtype/55-2.html（?page= 无效）
//   详情   /voddetail/<id>.html     ⚠ 详情页本身**没有播放器**，只是封面/标题/分类
//   播放   /vodplay/<id>-1-1.html   ⚠⚠ **必须带详情页 Referer**，否则站点返回首页
//          → player_aaaa = {encrypt:1,url:%68%74%74%70%73…}
//          → encrypt 只是 URL 编码，decodeURIComponent(url) 就是 m3u8
//   搜索   /vodsearch/-------------.html?wd=<词>
//   分类   32 个（站点把「主播网红」重复成 61/102，已去重）
//          用户拍板方案 **D（两级）**：8 个出品方 / 24 个题材，分两个 tab，各自二级 chips

import { Spider, openWeb } from "catvod";

const BASE = "https://msdtr2ym.student41.xyz";
const HOME_PATH = "/%E5%8A%9B%E4%BA%89%E4%B8%8A%E6%B8%B8/?fby";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;
const CACHE_MS = 180000;

/** 出品方（8 个）—— 一级 chips「出品方」 */
const PUBLISHERS = [
  ["105", "麻豆视频"], ["106", "91制片厂"], ["107", "天美传媒"], ["108", "蜜桃传媒"],
  ["110", "星空传媒"], ["111", "精东影业"], ["112", "乐播传媒"], ["113", "兔子先生"],
].map((x) => ({ id: x[0], name: x[1] }));

/** 题材（24 个）—— 一级 chips「题材」 */
const TOPICS = [
  ["55", "偷拍自拍"], ["63", "国产制作"], ["58", "乱伦三观"], ["60", "嫖妓过程"],
  ["57", "淫乱学妹"], ["65", "黑料打烊"], ["61", "主播网红"], ["80", "高清无码"],
  ["81", "中文字幕"], ["20", "媚黑母狗"], ["25", "3D动漫"], ["26", "剧情故事"],
  ["92", "国产精品"], ["93", "华语AV"], ["94", "黑料吃瓜"], ["95", "欧美精品"],
  ["96", "动漫禁漫"], ["97", "学生合集"], ["98", "乱伦精品"], ["99", "探花约炮"],
  ["100", "日本无码"], ["101", "日本有码"], ["103", "日本素人"], ["54", "综合"],
].map((x) => ({ id: x[0], name: x[1] }));

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + HOME_PATH,
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function strip(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function abs(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/** 列表卡片 */
function parseCards(html) {
  const src = String(html || "");
  const out = [];
  const seen = {};
  const re = /<a[^>]*href="([^"]*\/voddetail\/(\d+)\.html)"[^>]*>([\s\S]{0,600}?)<\/a>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const id = m[2];
    if (seen[id]) continue;
    const block = m[3];
    const pic = block.match(/data-src="([^"]+)"/) || block.match(/<img[^>]+src="([^"]+)"/);
    if (!pic) continue;                       // 没有封面的链接不是卡片（导航/更多）
    seen[id] = 1;
    const nameM = block.match(/class="[^"]*photo-name[^"]*"[^>]*>([\s\S]{0,120}?)</);
    let title = nameM ? strip(nameM[1]) : "";
    if (!title) title = strip(block).slice(0, 60);
    out.push({
      id: id,
      url: BASE + "/voddetail/" + id + ".html",
      title: title,
      pic: abs(pic[1]),
      remark: "",
    });
  }
  return out;
}

export default class St extends Spider {
  init() {
    this.cache = {};
  }

  async getHtml(url, ref) {
    const c = this.cache[url];
    if (c && Date.now() - c.ts < CACHE_MS) return c.html;
    for (let i = 0; i < 2; i++) {
      try {
        // 播放页必须带详情页 Referer，否则站点回首页
        const r = await this.net.req(url, { headers: hdrs(ref || url) });
        if (r && r.code === 200 && r.content) {
          this.cache[url] = { html: r.content, ts: Date.now() };
          return r.content;
        }
      } catch (e) { }
      await new Promise((res) => setTimeout(res, 600));
    }
    return "";
  }

  async homeContent() {
    return {
      class: [
        { type_id: "latest", type_name: "最新" },
        { type_id: "publisher", type_name: "出品方" },
        { type_id: "topic", type_name: "题材" },
        { type_id: "web", type_name: "网页" },
      ],
      subFromTab: true,
    };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.pic ? c.url + "|" + c.pic : c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.remark || "",
    }));
  }

  async listFrom(url, p) {
    const html = await this.getHtml(url);
    if (!html) return this.page([], p, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const cards = parseCards(html);
    const more = p < 50 && cards.length >= PAGE_SIZE * 0.6;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  /** 分类页 URL：分页是 `-页码` 后缀 */
  typeUrl(id, p) {
    return BASE + "/vodtype/" + id + (p > 1 ? "-" + p : "") + ".html";
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "latest");
    const ext = extend || {};

    if (t === "web") {
      try { openWeb({ url: BASE + HOME_PATH }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const sub = String(ext.sub || "");
    if (sub.indexOf("cat:") === 0) {
      return this.listFrom(this.typeUrl(sub.substring(4), p), p);
    }

    if (t === "publisher") return this.listFrom(this.typeUrl(PUBLISHERS[0].id, p), p);
    if (t === "topic") return this.listFrom(this.typeUrl(TOPICS[0].id, p), p);

    // 最新
    return this.listFrom(BASE + HOME_PATH, p);
  }

  async detailContent(ids) {
    const raw = String((ids && ids[0]) || "");
    const bar = raw.indexOf("|");
    const url = bar > 0 ? raw.substring(0, bar) : raw;
    const listCover = bar > 0 ? raw.substring(bar + 1) : "";
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const html = await this.getHtml(pageUrl);
    if (!html) return { list: [] };

    // 标题：<h1> 里其实是分类名（"学生合集"），真正的标题在 <title>/<h2> 里
    let title = "";
    const tt = html.match(/<title>([^<]*)<\/title>/);
    if (tt) title = strip(tt[1]);
    if (!title) {
      const h2 = html.match(/<h2[^>]*>([\s\S]{0,300}?)<\/h2>/);
      if (h2) title = strip(h2[1]);
    }
    if (!title) {
      const h1 = html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/);
      if (h1) title = strip(h1[1]);
    }
    if (title.length > 60) {
      // 站点 <title> 塞了一长串关键词，取第一段更像标题
      const cut = title.split(/[|｜_—–\-]/)[0].trim();
      title = (cut.length >= 6 ? cut : title).slice(0, 60).trim();
    }

    // 封面：优先用列表经 vod_id 传来的（详情页第一张图常是广告）
    let cover = listCover || "";
    if (!cover) {
      const im = html.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
      if (im) cover = abs(im[1]);
    }



    // 分类 chips（详情页里的 /vodtype/<id>.html）
    const cats = [];
    const seenC = {};
    const reC = /href="[^"]*\/vodtype\/(\d+)\.html"[^>]*>([\s\S]{0,80}?)<\/a>/g;
    let m;
    while ((m = reC.exec(html)) !== null) {
      const nm = strip(m[2]);
      if (!nm || seenC[m[1]] || nm.length > 12) continue;
      seenC[m[1]] = 1;
      cats.push({ id: m[1], name: nm });
      if (cats.length >= 4) break;
    }
    const lines = [];
    if (cats.length) lines.push(cats.map((x) => '[a=cr:{"id":"cat:' + x.id + '"}/]' + x.name + "[/a]").join(" · "));

    // 这是**视频站**：播放页 /vodplay/<id>-1-1.html，player_aaaa.url 是 URL 编码的 m3u8
    const vidm = pageUrl.match(/voddetail\/(\d+)\.html/);
    const vid = vidm ? vidm[1] : "";
    const playUrl = vid ? BASE + "/vodplay/" + vid + "-1-1.html" : pageUrl;

    const item = {
      vod_id: pageUrl,
      vod_name: title || "视频",
      vod_pic: cover,
      vod_content: lines.join("\n"),
      vod_remarks: "",
      vod_play_from: "学生41",
      vod_play_url: "正片$" + playUrl,
    };

    // 相关推荐：详情页里的其它卡片
    const rel = [];
    const seenR = {};
    seenR[pageUrl] = 1;
    seenR[raw] = 1;
    for (const c of parseCards(html)) {
      if (rel.length >= 8) break;
      if (seenR[c.url]) continue;
      seenR[c.url] = 1;
      rel.push({ vod_id: c.url, vod_name: c.title, vod_pic: c.pic, vod_remarks: c.remark || "" });
    }

    return { list: [item].concat(rel) };
  }

  async playerContent(flag, id) {
    const raw = String(id || "");
    const header = { "User-Agent": UA, "Referer": BASE + "/" };
    if (/\.(?:m3u8|mp4)(?:$|\?)/i.test(raw)) return { parse: 0, url: raw, header: header };

    const pageUrl = raw.indexOf("http") === 0 ? raw : BASE + raw;
    const vidm2 = pageUrl.match(/\/vodplay\/(\d+)/);
    const refUrl = vidm2 ? BASE + "/voddetail/" + vidm2[1] + ".html" : BASE + "/";
    let html = await this.getHtml(pageUrl, refUrl);
    // 站点对 Referer 敏感：拿回来若是首页（长度大且没有 player_aaaa），换根域 Referer 再试一次
    if (html && html.indexOf("player_aaaa") < 0) {
      delete this.cache[pageUrl];
      html = await this.getHtml(pageUrl, BASE + "/");
    }
    if (!html) throw new Error("播放页取不到");

    // player_aaaa={"encrypt":1,"url":"%68%74%74%70%73..."} —— 只是 URL 编码，解密就是 decodeURIComponent
    // ⚠ 别用 `}</script>` 结尾去匹配：player_aaaa 后面还有 MacPlayer.Init() 之类的代码
    let u = "";
    const pi = html.indexOf("player_aaaa");
    // 只有在 player_aaaa 片段里找 "url"，否则会误取 maccms 配置里的站点地址
    if (pi >= 0) {
      const seg = html.substring(pi, pi + 4000);
      const um = seg.match(/"url"\s*:\s*"([^"]*)"/);
      if (um) u = um[1].replace(/\\\//g, "/");
    }
    if (!u) {
      const any = html.match(/(%68%74%74%70[^"']{10,400})/);
      if (any) u = any[1];
    }
    if (!u) throw new Error("没找到播放地址");

    if (u.indexOf("%") >= 0) {
      try { u = decodeURIComponent(u); } catch (e) { }
    }
    u = u.replace(/\\\//g, "/");
    return { parse: 0, url: u, header: header };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/vodsearch/-------------.html?wd=" + encodeURIComponent(String(key || ""))
      + (p > 1 ? "&page=" + p : "");
    return this.listFrom(url, p);
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];

    // 二级 chips：两个 tab 各自的分类（必须返回数组）
    if (s === "sub|publisher") return PUBLISHERS.map((c) => ({ name: c.name, value: "cat:" + c.id }));
    if (s === "sub|topic") return TOPICS.map((c) => ({ name: c.name, value: "cat:" + c.id }));

    return [];
  }
}
