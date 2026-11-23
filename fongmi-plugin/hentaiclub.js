// 绅士会所（hentaiclub.net）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯图集（H 图集/写真），全站无视频
//   列表  /page/N/                 全部（1613 页）
//         /sort/r15.html/N/        R-15（1015 页）
//         /sort/r18.html/N/        R-18
//         /tag/<标签名>/N/          标签
//   随机  /rand.html                 302 → 随机详情页（需从返回 HTML 里认出自身链接）
//   详情  /r15/<id>.html  /r18/<id>.html
//         图片 <img data-original="https://cdn.sshs.rip/...webp">
//         张数 <span class="item-num"> [11P] </span>
//         标签 <a href="/tag/<名>/">
//   注意  标签总览页 /tagshow.html 由 JS 动态渲染，服务端拿不到 → 做成页内搜索框
//         标签名必须与站点完全一致（不存在的标签返回 0 卡片）

import { Spider, openWeb } from "catvod";

const BASE = "https://www.hentaiclub.net";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function clean(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** 解析列表卡片。<div class="item col-xs-6 ..."> 每张一个 */
function parseCards(html) {
  const text = String(html || "");
  const marks = [];
  const re = /<div class="item col-xs-6[^"]*">/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : text.length;
    const b = text.substring(from, to);

    // 站点现在给的是相对地址 href="/r15/71554.html"
    const link = b.match(/href="((?:https:\/\/www\.hentaiclub\.net)?\/(?:r15|r18)\/\d+\.html)"/);
    if (!link) continue;
    const url = link[1].indexOf("http") === 0 ? link[1] : BASE + link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const img = b.match(/data-original="([^"]+)"/) || b.match(/src="(https:\/\/cdn[^"]+)"/);
    const title = b.match(/class="item-link-text">\s*([\s\S]{0,200}?)\s*<\/(?:span|div)>/);
    const num = b.match(/class="item-num"[^>]*>\s*\[?\s*(\d+)\s*P/);
    const sort = b.match(/class="item-sort">\s*([^<]{1,10})\s*</);

    out.push({
      vod_id: url,
      vod_name: clean(title ? title[1] : "") || url,
      vod_pic: img ? decode(img[1]) : "",
      // 图集站：remarks 必须是纯「11P」——App 用 ^(\\d+)P(?:[·\\s]*(\\d+)V)?$ 判定
      // 判定为「纯图集」后点卡片才直接进图集，否则会进详情页再跳网页
      vod_remarks: num ? num[1] + "P" : "",
      vod_tag: "",
    });
  }
  return out;
}

/** 从随机页返回的详情 HTML 里认出「自身这条」的地址 */
function selfLink(html) {
  const text = String(html || "");
  const counts = {};
  const order = [];
  const re = /\/(r1[58])\/(\d+)\.html/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1] + "/" + m[2];
    if (!counts[key]) {
      counts[key] = 0;
      order.push(key);
    }
    counts[key]++;
  }
  if (!order.length) return "";
  // 出现次数最多的就是当前条目（面包屑 + 导航会重复指向自己）
  let best = order[0];
  for (const k of order) if (counts[k] > counts[best]) best = k;
  return BASE + "/" + best + ".html";
}

/** 详情页的图片与标签 */
function parseDetail(html) {
  const text = String(html || "");

  // 图片：data-original 优先，退到 cdn 直链
  const imgs = [];
  const seen = {};
  let m;
  const re1 = /data-original="(https:\/\/[^"]+\.(?:webp|jpg|jpeg|png|gif))"/g;
  while ((m = re1.exec(text)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = 1; imgs.push(m[1]); }
  }
  if (!imgs.length) {
    const re2 = /"(https:\/\/cdn\.sshs\.rip\/[^"]+\.(?:webp|jpg|jpeg|png|gif))"/g;
    while ((m = re2.exec(text)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = 1; imgs.push(m[1]); }
    }
  }

  // 标签
  const tags = [];
  const seenT = {};
  const re3 = /<a[^>]*href="(?:https:\/\/www\.hentaiclub\.net)?\/tag\/([^"\/]+)\/"[^>]*>\s*([^<]{1,40})/g;
  while ((m = re3.exec(text)) !== null) {
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (e) { }
    slug = decode(slug).trim();
    if (!slug || seenT[slug]) continue;
    seenT[slug] = 1;
    tags.push({ slug: slug, name: clean(m[2]) || slug });
  }

  const titleM = text.match(/<title>([^<]*)<\/title>/);
  let title = clean(titleM ? titleM[1] : "").replace(/\s*-\s*绅士会所\s*$/, "").trim();

  const num = text.match(/\[?\s*(\d+)\s*P\s*\]?/);
  const cover = imgs.length ? imgs[0] : "";

  return { title: title, imgs: imgs, tags: tags, count: num ? Number(num[1]) : imgs.length, cover: cover };
}

/** 大小写无关地取响应头（okhttp 给的是小写键） */
function headerOf(headers, name) {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) return String(headers[k] || "");
  }
  return "";
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|p):/, "");
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

export default class HentaiClub extends Spider {
  init() { }

  async homeContent() {
    // 形式③ 扁平 tab：全部 / R-15 / R-18 / 随机 / 标签 / 网页
    const classes = [
      { type_id: "all", type_name: "全部" },
      { type_id: "r15", type_name: "R-15" },
      { type_id: "r18", type_name: "R-18" },
      { type_id: "rand", type_name: "随机" },
      { type_id: "tagsearch", type_name: "标签" },
      { type_id: "web", type_name: "网页" },
    ];

    // 站点只有分级，无排序/时长/画质 → 不给筛选组
    return { class: classes, filters: {}, subFromTab: true };
  }

  /** 某标签（博主）的图集列表 */
  async tagList(name, p) {
    if (!name) return this.page([], p, PAGE_SIZE, 0);
    const enc = encodeURIComponent(name);
    const url = p <= 1 ? BASE + "/tag/" + enc + "/" : BASE + "/tag/" + enc + "/" + p + "/";
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }

    const cards = html ? parseCards(html) : [];
    if (!cards.length && p === 1) {
      return this.page([{
        vod_id: "", vod_name: "标签「" + name + "」没有内容（标签名需与站点完全一致）",
        vod_pic: "", vod_remarks: "提示",
      }], 1, PAGE_SIZE, 1);
    }
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "all");

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 「标签」tab：面板里选了标签 → extend.sub = "tag:<名字>"，就地返回该标签的列表
    if (t === "tagsearch") {
      const sel = (extend && extend.sub) ? String(extend.sub) : "";
      if (!sel || sel.indexOf("tag:") !== 0) {
        return this.page([{
          vod_id: "", vod_name: "在上方选一个标签（博主）",
          vod_pic: "", vod_remarks: "提示",
        }], 1, PAGE_SIZE, 1);
      }
      return this.tagList(sel.substring(4).trim(), p);
    }

    // ---------- 随机：/rand 返回 302（Location 就是随机到的详情页）----------
    if (t === "rand") {
      const want = 6;
      const cards = [];
      const seen = {};
      for (let i = 0; i < want && cards.length < 4; i++) {
        // 关键：redirect:0 才拿得到 302 的 Location，跟随跳转后 HTML 里没有任何自身链接
        let loc = "";
        try {
          const r = await this.net.req(BASE + "/rand", { headers: hdrs(), redirect: 0 });
          loc = headerOf(r && r.headers, "location");
        } catch (e) { loc = ""; }
        if (!loc) continue;
        const url = loc.indexOf("http") === 0 ? loc : BASE + loc;
        if (seen[url]) continue;
        seen[url] = 1;

        let html = "";
        try {
          const r2 = await this.net.req(url, { headers: hdrs() });
          if (r2 && r2.code === 200) html = r2.content;
        } catch (e) { html = ""; }
        if (!html) continue;
        const d = parseDetail(html);
        cards.push({
          vod_id: url,
          vod_name: d.title || url,
          vod_pic: d.cover,
          vod_remarks: d.count ? d.count + "P" : "",
        });
      }
      return this.page(cards, 1, PAGE_SIZE, cards.length);
    }

    // ---------- 标签 ----------
    if (t.indexOf("tag:") === 0) {
      const name = t.substring(4).trim();
      if (!name) return this.page([], p, PAGE_SIZE, 0);
      const enc = encodeURIComponent(name);
      const url = p <= 1
        ? BASE + "/tag/" + enc + "/"
        : BASE + "/tag/" + enc + "/" + p + "/";
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }

      const cards = html ? parseCards(html) : [];
      if (!cards.length && p === 1) {
        // 站点对不存在的标签直接报错/空页 → 给一张可读的提示卡
        return this.page([{
          vod_id: "",
          vod_name: "标签「" + name + "」没有内容（标签名需与站点完全一致，区分大小写）",
          vod_pic: "",
          vod_remarks: "提示",
        }], 1, PAGE_SIZE, 1);
      }
      const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
      return this.page(cards, p, PAGE_SIZE, total);
    }

    // ---------- 全部 / R-15 / R-18 ----------
    let url;
    if (t === "r15") {
      url = p <= 1 ? BASE + "/sort/r15.html" : BASE + "/sort/r15.html/" + p + "/";
    } else if (t === "r18") {
      url = p <= 1 ? BASE + "/sort/r18.html" : BASE + "/sort/r18.html/" + p + "/";
    } else {
      url = p <= 1 ? BASE + "/" : BASE + "/page/" + p + "/";
    }

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }

    const d = parseDetail(html);

    // 详情文本：第一行放标签 chips（App 渲染成「标签」行）
    const lines = [];
    if (d.tags.length) {
      lines.push(d.tags
        .slice(0, 12)
        .map((t) => '[a=cr:{"id":"tag:' + t.slug + '"}/]' + t.name + "[/a]")
        .join(" · "));
    }
    if (d.count) lines.push("共 " + d.count + " 张");

    // 相关推荐：同标签的其他内容（排除自己）
    const rel = await this.relatedByTag((d.tags.length ? d.tags[0].name : ""), url, 8);

    return {
      list: [{
        vod_id: url,
        vod_name: d.title || url,
        vod_pic: d.cover,
        vod_content: lines.join("\n"),
        vod_remarks: d.count ? d.count + "P" : "",
        gallery: true,
        vod_play_from: "绅士会所",
        vod_play_url: "图集$" + url,
      }, ...rel],
    };
  }

  /** 图集站没有视频流；万一 App 走到播放，交给内置浏览器 */
  /** 同标签的相关推荐（排除自己） */
  async relatedByTag(tag, selfUrl, limit) {
    const out = [];
    if (!tag) return out;
    try {
      const r = await this.tagList(tag, 1);
      const cards = (r && r.list) ? r.list : [];
      for (const c of cards) {
        if (!c.vod_id || c.vod_id === selfUrl) continue;
        if (out.some((x) => x.vod_id === c.vod_id)) continue;
        out.push({
          vod_id: c.vod_id,
          vod_name: c.vod_name,
          vod_pic: c.vod_pic,
          vod_remarks: c.vod_remarks,
        });
        if (out.length >= limit) break;
      }
    } catch (e) { }
    return out;
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    return { parse: 0, url: "web://" + url, header: {} };
  }

  /** 全部标签（从 /tagshow.html 一次性抓取，进程内缓存） */
  async allTags() {
    if (this.tagCache) return this.tagCache;
    let html = "";
    try {
      const r = await this.net.req(BASE + "/tagshow.html", { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return [];

    // 只在 .post-tags 区块里找，避免把导航链接混进来
    let start = html.indexOf("post-tags");
    if (start < 0) start = 0;
    const seg = html.substring(start);

    const out = [];
    const seen = {};
    const re = /<a[^>]*href="[^"]*\/tag\/([^"\/]+)\/"[^>]*>\s*([^<]{1,40})/g;
    let m;
    while ((m = re.exec(seg)) !== null) {
      let slug = m[1];
      try { slug = decodeURIComponent(slug); } catch (e) { }
      slug = decode(slug).trim();
      const name = clean(m[2]) || slug;
      if (!slug || seen[slug]) continue;
      seen[slug] = 1;
      out.push({ id: slug, name: name });
    }
    this.tagCache = out;
    return out;
  }

  /** 图集站：点击卡片直接进图集浏览。App 通过 action("gal|<url>") 取图片 */
  async action(op) {
    if (!op) return {};

    // 标签模糊搜索：App 的「标签」搜索框走这里
    if (op.indexOf("facet|tags|") === 0) {
      const rest = op.substring("facet|tags|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim();
      const tags = await this.allTags();
      if (!tags.length) return { items: [] };
      const low = kw.toLowerCase();
      const hit = [];
      for (const t of tags) {
        if (!kw || t.name.toLowerCase().indexOf(low) >= 0 || t.id.toLowerCase().indexOf(low) >= 0) {
          hit.push({ id: t.id, name: t.name, count: "" });
          if (hit.length >= 60) break;
        }
      }
      return { items: hit };
    }

    if (op.indexOf("gal|") === 0) {
      const url = pageUrlOf(op.substring(4));
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }
      const d = parseDetail(html);
      // 图集页顶部标签栏：App 读 tags:[{name,id}]
      return {
        list: d.imgs.map((u) => ({ url: u })),
        tags: d.tags.map((t) => ({ name: t.name, id: "tag:" + t.slug })),
      };
    }
    return {};
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    // 站点搜索：/?s=<kw>（服务端渲染，能出卡片）
    const url = BASE + "/?s=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
