// asmr.one —— BiliTV / catvod QuickJS 插件
//
// 站点：https://asmr.one
// 数据：https://api.asmr-200.com
//   列表  /api/works?page=&pageSize=&order=   （公开）
//   搜索  /api/search/<关键字>?page=          （公开）
//   封面  /api/cover/<id>.jpg?type=main       （公开）
//   详情  /api/works/<id>                     （401，需要登录）
//   音轨  /api/works/<id>/tracks              （401，需要登录）
// 所以：详情用「列表缓存 → 按 id 搜索」两段兜底，播放打开内置浏览器。

import { Spider, openWeb } from "catvod";

const SITE = "https://asmr.one";
const API = "https://api.asmr-200.com";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PAGE_SIZE = 20;

const ORDERS = [
  ["release", "最新发售"],
  ["create_date", "最新收录"],
  ["dl_count", "最多下载"],
  ["rate_average_2dp", "最高评分"],
  ["random", "随机"],
];

function headers() {
  return { "User-Agent": UA, "Accept": "application/json", "Referer": SITE + "/" };
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? h + " 小时 " + m + " 分" : m + " 分钟";
}

function fmtBadge(sec) {
  const s = Number(sec) || 0;
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? h + "h" + m : m + "分";
}

function toCard(w) {
  const circle = (w.circle && w.circle.name) || "";
  const remarks = fmtBadge(w.duration) || circle || String(w.release || "").substring(0, 10);
  return {
    vod_id: String(w.id),
    vod_name: (circle ? "[" + circle + "] " : "") + (w.title || w.name || String(w.id)),
    vod_pic: w.mainCoverUrl || w.samCoverUrl || "",
    vod_remarks: remarks,
  };
}

function workContent(w) {
  const lines = [];
  if (w.release) lines.push("发售：" + String(w.release).substring(0, 10));
  const dur = fmtDuration(w.duration);
  if (dur) lines.push("时长：" + dur);
  if (w.rate_average_2dp) lines.push("评分：" + w.rate_average_2dp + "（" + (w.rate_count || 0) + " 人）");
  if (w.dl_count) lines.push("下载：" + w.dl_count);
  const vas = (w.vas || []).map((v) => v.name || v).filter(Boolean);
  if (vas.length) lines.push("声优：" + vas.join(" / "));
  const tags = (w.tags || []).map((t) => t.name || t).filter(Boolean);
  if (tags.length) lines.push("标签：" + tags.join(" / "));
  if (w.circle && w.circle.name) lines.push("社团：" + w.circle.name);
  lines.push("※ 音轨需要登录，点「网页播放」在内置浏览器里收听");
  return lines.join("\n");
}

// @bili-helpers BEGIN v2026-11-26（由 tools/inject.mjs 注入，可安全整块替换）
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

// @bili-helpers END

export default class AsmrOne extends Spider {
  init() {
    this.cache = this.cache || {};
  }

  async homeContent() {
    const classes = [];
    const sorts = [];
    for (const [v, n] of ORDERS) {
      classes.push({ type_id: "o:" + v, type_name: n });
      sorts.push({ n: n, v: v });
    }
    classes.push({ type_id: "web", type_name: "网页" });

    // order 组会被 App 抽到「排序」按钮里
    const filters = {};
    for (const c of classes) {
      if (c.type_id === "web") continue;
      filters[c.type_id] = [{ key: "order", name: "排序", value: sorts }];
    }
    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;
    if (tid === "web") {
      try {
        openWeb({ url: SITE + "/works" });
      } catch (e) {
      }
      return this.page([], p, PAGE_SIZE, 0);
    }

    const order = (extend && extend.order) || (tid.indexOf("o:") === 0 ? tid.substring(2) : "release");
    let data = null;
    try {
      const r = await this.net.req(
        API + "/api/works?page=" + p + "&pageSize=" + PAGE_SIZE + "&order=" + encodeURIComponent(order),
        { headers: headers() });
      if (r && r.code === 200) data = JSON.parse(r.content);
    } catch (e) {
      data = null;
    }
    if (!data) return this.page([], p, PAGE_SIZE, 0);

    this.cache = this.cache || {};
    const cards = [];
    for (const w of data.works || []) {
      this.cache[w.id] = w;
      cards.push(toCard(w));
    }
    const total = (data.pagination && data.pagination.totalCount) || 0;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async detailContent(ids) {
    const id = String(ids[0] || "").replace(/^.*\//, "");
    this.cache = this.cache || {};
    let w = this.cache[id] || null;

    // 缓存没有（收藏/历史直接打开）→ 按 id 搜索兜底
    if (!w) {
      try {
        const r = await this.net.req(API + "/api/search/" + encodeURIComponent(id) + "?page=1&pageSize=3",
          { headers: headers() });
        if (r && r.code === 200) {
          const d = JSON.parse(r.content);
          const works = (d && d.works) || [];
          for (const item of works) {
            if (String(item.id) === id) {
              w = item;
              break;
            }
          }
          if (!w && works.length) w = works[0];
          if (w) this.cache[id] = w;
        }
      } catch (e) {
      }
    }

    const circle = (w && w.circle && w.circle.name) || "";
    const title = w ? ((circle ? "[" + circle + "] " : "") + (w.title || w.name || id)) : ("作品 " + id);
    const pic = (w && (w.mainCoverUrl || w.samCoverUrl)) || "";

    const item = {
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_content: w ? workContent(w) : "※ 音轨需要登录，点「网页播放」在内置浏览器里收听",
      vod_remarks: w ? (fmtDuration(w.duration) || circle) : "",
      gallery: false,
      vod_play_from: "asmr.one",
      vod_play_url: "网页播放$web://" + SITE + "/work/" + id,
    };

    // 同社团其它作品作推荐
    const list = [item];
    if (w && w.circle_id) {
      try {
        const r2 = await this.net.req(
          API + "/api/works?page=1&pageSize=6&order=release&circle=" + w.circle_id,
          { headers: headers() });
        if (r2 && r2.code === 200) {
          const d2 = JSON.parse(r2.content);
          for (const more of (d2 && d2.works) || []) {
            if (list.length >= 7) break;
            if (String(more.id) === id) continue;
            const c = toCard(more);
            list.push({ vod_id: c.vod_id, vod_name: c.vod_name, vod_pic: c.vod_pic, vod_remarks: c.vod_remarks });
          }
        }
      } catch (e) {
      }
    }
    return { list: list };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    let data = null;
    try {
      const r = await this.net.req(
        API + "/api/search/" + encodeURIComponent(key) + "?page=" + p + "&pageSize=" + PAGE_SIZE,
        { headers: headers() });
      if (r && r.code === 200) data = JSON.parse(r.content);
    } catch (e) {
      data = null;
    }
    if (!data) return this.page([], p, PAGE_SIZE, 0);

    this.cache = this.cache || {};
    const cards = [];
    for (const w of data.works || []) {
      this.cache[w.id] = w;
      cards.push(toCard(w));
    }
    const total = (data.pagination && data.pagination.totalCount) || 0;
    return this.page(cards, p, PAGE_SIZE, total);
  }

  async playerContent(flag, id) {
    // 音轨需要登录，交给 App 用内置浏览器打开（web:// 协议）
    const raw = String(id || "");
    if (raw.indexOf("web://") === 0) return { parse: 0, url: raw, header: "{}" };
    const wid = raw.replace(/^.*\//, "");
    return { parse: 0, url: "web://" + SITE + "/work/" + wid, header: "{}" };
  }

  async action(op) {
    // 站点没有公开的标签/社团列表接口（401），不提供额外入口
    return [];
  }
}
