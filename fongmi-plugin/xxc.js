// xxcosplay（xxcosplay.com）—— BiliTV / catvod QuickJS 插件
//
// 站类型：混合站（相册里可能同时有图集和视频）
//   全部   /page/N/                  411 页 × 24
//   博主   /artists?page=N           4 页 × 59（约 200+）
//          某博主 /artists/<slug>?page=N
//   标签   /tags?page=N              22 页 × 48（约 1000+，英文标签）
//          某标签 /tags/<tag>?page=N
//   详情   /albums/<slug>
//   搜索   /search?q=<词>
//
// 卡片：<a href="/albums/<slug>"><img src="https://media.xxcosplay.com/…[68P-1.31G]…/0001.webp" alt="标题">
//   图片目录名里带现成数量信息：
//     [68P-1.31G]     → 68 张图
//     [4V 1.73GB]     → 4 个视频
//     [17P1V-59MB]    → 17 图 + 1 视频
//
// 视频：<div data-video-player-src-value="https://media.xxcosplay.com/…/video_0002/playlist.m3u8">
//   → HLS，parse: 1
//
// 设计：4 tab（全部 / 博主 / 标签 / 网页）；博主与标签用页内搜索面板，选中后就地筛选。

import { Spider, openWeb } from "catvod";

const BASE = "https://xxcosplay.com";
const MEDIA = "https://media.xxcosplay.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;
const FACET_PAGE = 100;   // 每页 100 个，博主 164 → 两页，能看到「加载更多」

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

/** 从 media 路径里解出「68P」「4V」「17P·1V」这种角标 */
function countBadge(url) {
  let u = String(url || "");
  try { u = decodeURIComponent(u); } catch (e) { }
  const m = u.match(/\[([^\]]{1,40})\]/);
  if (!m) return "";
  const t = m[1];
  const p = t.match(/(\d+)\s*P/i);
  const v = t.match(/(\d+)\s*V/i);
  if (p && v) return p[1] + "P·" + v[1] + "V";
  if (p) return p[1] + "P";
  if (v) return v[1] + "V";
  return "";
}

/** 列表卡片：<a href="/albums/…"><img …> */
function parseCards(html) {
  const text = String(html || "");
  const marks = [];
  const re = /<a[^>]+href="\/albums\/[^"]+"[^>]*>/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : text.length;
    const b = text.substring(from, to);

    const link = b.match(/href="(\/albums\/[^"]+)"/);
    if (!link) continue;
    const url = BASE + link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const img = b.match(/<img[^>]*src="([^"]+)"/);
    const alt = b.match(/<img[^>]*alt="([^"]*)"/);

    out.push({
      vod_id: url,
      vod_name: clean(alt ? alt[1] : "") || link[1].replace("/albums/", ""),
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: img ? countBadge(img[1]) : "",
    });
  }
  return out;
}

/** 相册详情：图片（按序号去重）+ 视频 m3u8 */
function parseAlbum(html) {
  const text = String(html || "");

  const imgs = [];
  const seen = {};
  const re = /<img[^>]*src="(https:\/\/media\.[^"]+\.(?:webp|jpg|jpeg|png|gif))"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = decode(m[1]);
    if (!seen[u]) { seen[u] = 1; imgs.push(u); }
  }
  // 同一张图会出现多次（缩略图+大图），按「目录+文件名」再去一次重
  const uniq = [];
  const seenKey = {};
  for (const u of imgs) {
    const key = u.replace(/^.*\//, "");
    if (seenKey[key]) continue;
    seenKey[key] = 1;
    uniq.push(u);
  }

  const vids = [];
  const seenV = {};
  const vre = /data-video-player-src-value="([^"]+\.m3u8[^"]*)"/g;
  while ((m = vre.exec(text)) !== null) {
    const u = decode(m[1]);
    if (!seenV[u]) { seenV[u] = 1; vids.push(u); }
  }

  const t = text.match(/property="og:title"\s+content="([^"]*)"/) ||
    text.match(/<title>([^<]*)<\/title>/);
  let title = clean(t ? t[1] : "").replace(/\s*\|\s*xxcosplay\s*$/i, "").trim();

  const cov = text.match(/property="og:image"\s+content="([^"]*)"/);

  // 博主（相册页里的 /artists/ 链接）
  let artistSlug = "";
  let artistName = "";
  const am = text.match(/href="\/artists\/([a-z0-9\-]+)"[^>]*>\s*([^<]{1,40})/);
  if (am) {
    artistSlug = am[1];
    artistName = clean(am[2]);
  }

  // 标签
  const tags = [];
  const seenT = {};
  const tre = /href="\/tags\/([a-z0-9\-]+)"[^>]*>\s*([^<]{1,40})/g;
  while ((m = tre.exec(text)) !== null) {
    const slug = m[1];
    if (seenT[slug]) continue;
    seenT[slug] = 1;
    tags.push({ slug: slug, name: clean(m[2]) || slug });
  }

  return {
    title: title,
    imgs: uniq,
    vids: vids,
    cover: cov ? decode(cov[1]) : (uniq.length ? uniq[0] : ""),
    artistSlug: artistSlug,
    artistName: artistName,
    tags: tags,
  };
}

/** 部分相册的图片路径没有 [68P] 标记 —— 对这些卡片补抓详情页拿准确数量（最多 10 个，并发） */
async function fillBadges(spider, cards) {
  const todo = [];
  for (const c of cards) {
    if (!c.vod_remarks && todo.length < 10) todo.push(c);
  }
  if (!todo.length) return cards;
  await Promise.all(todo.map(async (c) => {
    try {
      const r = await spider.net.req(c.vod_id, { headers: hdrs(c.vod_id) });
      if (!r || r.code !== 200) return;
      const a = parseAlbum(r.content);
      const p = a.imgs.length, v = a.vids.length;
      if (!p && !v) return;
      c.vod_remarks = (p ? p + "P" : "") + (v ? (p ? "·" : "") + v + "V" : "");
    } catch (e) { }
  }));
  return cards;
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|p):/, "");
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

export default class XxCosplay extends Spider {
  init() { }

  async homeContent() {
    const classes = [
      { type_id: "all", type_name: "全部" },
      { type_id: "artistsearch", type_name: "博主" },
      { type_id: "tagsearch", type_name: "标签" },
      { type_id: "web", type_name: "网页" },
    ];
    return { class: classes, filters: {}, subFromTab: true };
  }

  /** 博主 / 标签列表（extend.sub = "artist:<slug>" 或 "tag:<tag>"） */
  async listBySub(sub, p) {
    let path = "";
    if (sub.indexOf("artist:") === 0) path = "/artists/" + encodeURIComponent(sub.substring(7));
    else if (sub.indexOf("tag:") === 0) path = "/tags/" + encodeURIComponent(sub.substring(4));
    if (!path) return null;

    const url = BASE + path + (p <= 1 ? "" : "?page=" + p);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    const cards = html ? await fillBadges(this, parseCards(html)) : [];
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    const t = String(tid || "all");
    const sub = (extend && extend.sub) ? String(extend.sub) : "";

    if (t === "web") {
      try { openWeb({ url: BASE + "/" }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 博主 / 标签：选中后就地筛选
    if (t === "artistsearch" || t === "tagsearch") {
      if (!sub) {
        return this.page([{
          vod_id: "",
          vod_name: t === "artistsearch" ? "在上方选一个博主，或搜索后点选" : "在上方选一个标签，或搜索后点选",
          vod_pic: "", vod_remarks: "提示",
        }], 1, PAGE_SIZE, 1);
      }
      const r = await this.listBySub(sub, p);
      if (r) return r;
    }

    // 全部
    const url = BASE + "/" + (p <= 1 ? "" : "?page=" + p);
    let html = "";
    try {
      const rr = await this.net.req(url, { headers: hdrs() });
      if (rr && rr.code === 200) html = rr.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = await fillBadges(this, parseCards(html));
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

    const a = parseAlbum(html);

    const lines = [];
    if (a.artistSlug) {
      lines.push('[a=cr:{"id":"artist:' + a.artistSlug + '"}/]' + (a.artistName || a.artistSlug) + "[/a]");
    }
    if (a.tags.length) {
      lines.push(a.tags.slice(0, 12)
        .map((t) => '[a=cr:{"id":"tag:' + t.slug + '"}/]' + t.name + "[/a]")
        .join(" · "));
    }
    const parts = [];
    if (a.imgs.length) parts.push(a.imgs.length + " 张图");
    if (a.vids.length) parts.push(a.vids.length + " 个视频");
    if (parts.length) lines.push(parts.join(" · "));

    const badge = (a.imgs.length ? a.imgs.length + "P" : "") +
      (a.vids.length ? (a.imgs.length ? "·" : "") + a.vids.length + "V" : "");

    // 播放列表：有视频就列出来，没有就走图集
    let playFrom = "图集";
    let playUrl = "图集$" + url;
    if (a.vids.length) {
      playFrom = "视频";
      playUrl = a.vids.map((u, i) => ("视频" + (i + 1)) + "$" + u).join("#");
    }

    return {
      list: [{
        vod_id: url,
        vod_name: a.title || url,
        vod_pic: a.cover,
        vod_content: lines.join("\n"),
        vod_remarks: badge,
        gallery: true,
        vod_play_from: playFrom,
        vod_play_url: playUrl,
      }],
    };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    if (/\.m3u8/.test(url)) {
      return { parse: 1, url: url, header: { "User-Agent": UA, "Referer": BASE + "/" } };
    }
    // 兜底：从相册页取第一个 m3u8
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    const a = parseAlbum(html);
    if (!a.vids.length) throw new Error("这个相册没有视频");
    return { parse: 1, url: a.vids[0], header: { "User-Agent": UA, "Referer": BASE + "/" } };
  }

  /** 博主索引（/artists 共 4 页） */
  async allArtists() {
    if (this.artistCache) return this.artistCache;
    const out = [];
    const seen = {};
    for (let pg = 1; pg <= 8; pg++) {
      let html = "";
      try {
        const r = await this.net.req(BASE + "/artists" + (pg <= 1 ? "" : "?page=" + pg), { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }
      if (!html) break;

      // 先把本页所有 slug 抓出来（不依赖名字结构）
      const slugs = [];
      const reSlug = /href="\/artists\/([a-z0-9\-]+)"/g;
      let m;
      while ((m = reSlug.exec(html)) !== null) {
        if (slugs.indexOf(m[1]) < 0) slugs.push(m[1]);
      }

      let added = 0;
      for (const slug of slugs) {
        if (seen[slug]) continue;
        seen[slug] = 1;
        // 再单独找这个名字（找不到就用 slug 兜底）
        let name = "";
        const nm = html.match(new RegExp('href="/artists/' + slug + '"[^>]*>\\s*([^<]{1,40})'));
        if (nm) name = clean(nm[1]);
        out.push({ name: name || slug.replace(/-/g, " "), id: "artist:" + slug });
        added++;
      }
      if (!added) break;
    }
    this.artistCache = out;
    return out;
  }

  /** 标签索引（/tags 共 22 页，并发抓） */
  async allTags() {
    if (this.tagCache) return this.tagCache;
    const pages = [];
    for (let pg = 1; pg <= 24; pg++) pages.push(pg);

    const fetchPage = async (pg) => {
      try {
        const r = await this.net.req(BASE + "/tags" + (pg <= 1 ? "" : "?page=" + pg), { headers: hdrs() });
        return r && r.code === 200 ? r.content : "";
      } catch (e) {
        return "";
      }
    };

    for (let i = 0; i < pages.length; i += 6) {
      const batch = pages.slice(i, i + 6).map(fetchPage);
      await Promise.all(batch);
    }
    // 上面并发只是热身（拿不到结果也没关系），逐页取一次确保稳定
    const out = [];
    let seen = {};   // 全局去重，跨页也生效
    for (const pg of pages) {
      const html = await fetchPage(pg);
      if (!html) break;
      const re = /<a[^>]+href="\/tags\/([a-z0-9\-]+)"[^>]*>([\s\S]{0,300}?)<\/a>/g;
      let m;
      let found = 0;
      while ((m = re.exec(html)) !== null) {
        const slug = m[1];
        if (seen[slug]) continue;
        seen[slug] = 1;
        // 名字里常带「4611 albums」这种计数，去掉
        let name = clean(m[2]).replace(/\s*\d+\s*albums?\s*$/i, "").trim();
        out.push({ name: name || slug.replace(/-/g, " "), id: "tag:" + slug });
        found++;
      }
      if (!found) break;
    }
    this.tagCache = out;
    return out;
  }

  async action(op) {
    if (!op) return [];

    // 页内搜索面板：博主
    if (op.indexOf("facet|artistsearch|") === 0) {
      const rest = op.substring("facet|artistsearch|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const pg = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

      const all = await this.allArtists();
      const hit = kw ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0 || x.id.toLowerCase().indexOf(kw) >= 0) : all;
      const from = (pg - 1) * FACET_PAGE;
      return { items: hit.slice(from, from + FACET_PAGE).map((x) => ({ id: x.id, name: x.name, count: "" })) };
    }

    // 页内搜索面板：标签
    if (op.indexOf("facet|tags|") === 0) {
      const rest = op.substring("facet|tags|".length);
      const bar = rest.lastIndexOf("|");
      const kw = (bar >= 0 ? rest.substring(0, bar) : rest).trim().toLowerCase();
      const pg = Math.max(1, Number(bar >= 0 ? rest.substring(bar + 1) : "1") || 1);

      const all = await this.allTags();
      const hit = kw ? all.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0 || x.id.toLowerCase().indexOf(kw) >= 0) : all;
      const from = (pg - 1) * FACET_PAGE;
      return { items: hit.slice(from, from + FACET_PAGE).map((x) => ({ id: x.id, name: x.name, count: "" })) };
    }

    // 二级 chips 不用
    if (op.indexOf("sub|") === 0) return [];

    // 图集页
    if (op.indexOf("gal|") === 0) {
      const url = pageUrlOf(op.substring(4));
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs() });
        if (r && r.code === 200) html = r.content;
      } catch (e) { html = ""; }
      const a = parseAlbum(html);
      const tags = [];
      if (a.artistSlug) tags.push({ name: a.artistName || a.artistSlug, id: "artist:" + a.artistSlug });
      for (const t of a.tags) tags.push({ name: t.name, id: "tag:" + t.slug });
      return { list: a.imgs.map((u) => ({ url: u })), tags: tags };
    }

    return [];
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/search?q=" + encodeURIComponent(key) + (p > 1 ? "&page=" + p : "");
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) { html = ""; }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = await fillBadges(this, parseCards(html));
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
