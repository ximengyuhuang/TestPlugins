// ─────────────────────────────────────────────────────────────
//  BiliTV 插件标准头部（2026-11-26）
//  新站从这里复制，改 BASE / 常量 / 各接口实现即可。
//  设计约束：catvod 插件是**单文件**、不能 import 本地模块，
//  所以「公共代码」只能靠这份模板复制 + tools\inject.mjs 注入。
//  带 @bili-helpers 标记的区块由 inject.mjs 维护，升级时整块替换。
// ─────────────────────────────────────────────────────────────

import { Spider, openWeb } from "catvod";

const BASE = "https://example.com";
const HOME_PATH = "/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;
const CACHE_MS = 180000;

// @bili-helpers BEGIN ─────────────────────────────────────────
// 这一段由 tools/inject.mjs 统一注入/升级，改这之前先看 inject.mjs。

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": ref || BASE + HOME_PATH,
  };
}

/** HTML 实体 + 常见转义 */
function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

/** 去标签 + 解实体 + 压空白 */
function strip(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 站内相对路径补全 */
function abs(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

/**
 * 从标题里取 P/V 数量（很多站把数量/时长直接写在标题里）。
 * 全角也认：Ｐ Ｖ １２。
 * 返回 {p, v}，取不到给 0。
 */
function titlePV(title) {
  const t = String(title || "");
  const both = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]\s*([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const toHalf = (x) => Number(String(x).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))) || 0;
  if (both) return { p: toHalf(both[1]), v: toHalf(both[2]) };
  const onlyV = t.match(/([0-9０-９]{1,2})\s*[VvＶｖ]/);
  const onlyP = t.match(/([0-9０-９]{1,3})\s*[PpＰｐ]/);
  return { p: onlyP ? toHalf(onlyP[1]) : 0, v: onlyV ? toHalf(onlyV[1]) : 0 };
}

/** 标题里的时长（12:34 / 01:47:35），取不到给空串 */
function titleDuration(title) {
  const m = String(title || "").match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return m ? m[1] : "";
}

/**
 * 角标：站点结构化字段 > 标题里的 P/V/时长 > 留空。
 * 用法：vod_remarks: badgeOf(title, { photos: 12, videos: 1, duration: "12:34" })
 * 返回形态只有三种合法：NP、NP·MV、时长；无效值（0P/1P 占位）自动忽略。
 */
function badgeOf(title, info) {
  const i = info || {};
  const pv = titlePV(title);
  let p = Number(i.photos) > 0 ? Number(i.photos) : pv.p;
  let v = Number(i.videos) > 0 ? Number(i.videos) : pv.v;
  if (p === 1 && v > 0) p = 0;              // 「1P·1V」里的 1P 多半是封面占位
  if (p > 0 && v > 0) return p + "P·" + v + "V";
  if (v > 0) return v + "V";
  if (p > 0) return p + "P";
  const dur = i.duration || titleDuration(title);
  return dur || "";
}
// @bili-helpers END ───────────────────────────────────────────

export default class Example extends Spider {
  init() {
    this.cache = {};
  }

  /** 带缓存 + 重试的网络取页（站点限流时很有用） */
  async getHtml(url, ref) {
    const c = this.cache[url];
    if (c && Date.now() - c.ts < CACHE_MS) return c.html;
    for (let i = 0; i < 2; i++) {
      try {
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
        { type_id: "web", type_name: "网页" },
      ],
    };
  }

  cardsToList(cards) {
    return cards.map((c) => ({
      vod_id: c.url,
      vod_name: c.title,
      vod_pic: c.pic,
      vod_remarks: c.remark || "",
    }));
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    if (String(tid) === "web") {
      try { openWeb({ url: BASE + HOME_PATH }); } catch (e) { }
      return this.page([], p, PAGE_SIZE, 0);
    }
    const html = await this.getHtml(BASE + HOME_PATH);
    const cards = [];
    void html;
    const more = false;
    const total = more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(this.cardsToList(cards), p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const url = String((ids && ids[0]) || "");
    const pageUrl = url.indexOf("http") === 0 ? url : BASE + url;
    const html = await this.getHtml(pageUrl);
    if (!html) return { list: [] };

    const title = "";
    const item = {
      vod_id: pageUrl,
      vod_name: title || "未命名",
      vod_pic: "",
      vod_content: "",
      vod_remarks: badgeOf(title, {}),
      vod_play_from: "站点",
      vod_play_url: "正片$" + pageUrl,
    };
    return { list: [item] };
  }

  async playerContent(flag, id) {
    const raw = String(id || "");
    if (/\.(?:m3u8|mp4)(?:$|\?)/i.test(raw)) {
      return { parse: 0, url: raw, header: { "User-Agent": UA, "Referer": BASE + "/" } };
    }
    throw new Error("未实现 playerContent");
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    void key;
    return this.page([], p, PAGE_SIZE, 0);
  }

  async action(op) {
    const s = String(op || "");
    if (!s) return [];
    // action("sub|<tid>") 必须返回数组 [{name, value}]
    if (s.indexOf("sub|") === 0) return [];
    if (s.indexOf("gal|") === 0) return { list: [] };
    if (s === "side|") return { groups: [] };
    if (s.indexOf("facet|") === 0) return { items: [] };
    return [];
  }
}
