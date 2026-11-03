// asmr.one —— FongMi / TVBox QuickJS 源
//
// asmr.one 的音轨接口需要登录（/api/works/<id>/tracks → 401），
// 但作品列表是公开 API，所以这里做「浏览 + 跳网页播放」：
//   列表/搜索  → https://api.asmr-200.com/api/works?order=…&page=…
//   详情       → 用列表时缓存的作品信息（详情接口要登录）
//   播放       → 用内置浏览器打开 https://asmr.one/work/<id>

import { Spider, openWeb } from "catvod";

const API = "https://api.asmr-200.com";
const SITE = "https://asmr.one";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const ORDERS = [
  ["release", "最新发售"],
  ["create_date", "最新收录"],
  ["dl_count", "最多下载"],
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

function toCard(w) {
  const circle = (w.circle && w.circle.name) || "";
  const dur = fmtDuration(w.duration);
  let remarks = dur || circle;
  if (!remarks && w.release) remarks = w.release;
  return {
    vod_id: String(w.id),
    vod_name: (circle ? "[" + circle + "] " : "") + (w.title || w.name || String(w.id)),
    vod_pic: w.mainCoverUrl || w.samCoverUrl || "",
    vod_remarks: remarks,
  };
}

export default class AsmrOne extends Spider {
  init(extend) {
    this.cache = {};
    this.log("asmr.one ready");
  }

  async homeContent(filter) {
    const classes = [];
    for (const [v, n] of ORDERS) classes.push({ type_id: "o:" + v, type_name: n });
    classes.push({ type_id: "web", type_name: "网页" });

    // 排序筛选器
    const sorts = ORDERS.map(([v, n]) => ({ n: n, v: v }));
    const filters = {};
    for (const c of classes) filters[c.type_id] = [{ key: "order", name: "排序", value: sorts }];

    return { class: classes, filters: filters };
  }

  async categoryContent(tid, pg, filter, extend) {
    if (tid === "web") {
      try {
        openWeb({ url: SITE + "/works" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 20, 0);
    }

    let order = (extend && extend.order) || "";
    if (!order) {
      const o = tid.indexOf("o:") === 0 ? tid.substring(2) : "release";
      order = o;
    }

    const p = Number(pg) || 1;
    const url = API + "/api/works?page=" + p + "&pageSize=20&order=" + encodeURIComponent(order);

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 20, 0);

    let data;
    try {
      data = JSON.parse(r.content);
    } catch (e) {
      return this.page([], p, 20, 0);
    }

    const works = data.works || [];
    const cards = [];
    for (const w of works) {
      this.cache[w.id] = w;
      cards.push(toCard(w));
    }

    const total = (data.pagination && data.pagination.totalCount) || 0;
    if (cards.length === 0) return this.page([], p, 20, (p - 1) * 20);
    return this.page(cards, p, 20, total || (p + 1) * 20);
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const wid = String(id).replace(/^.*\//, "");
      const w = this.cache[wid] || null;

      let title = wid;
      let pic = "";
      let content = "";

      if (w) {
        const circle = (w.circle && w.circle.name) || "";
        title = (circle ? "[" + circle + "] " : "") + (w.title || w.name || wid);
        pic = w.mainCoverUrl || w.samCoverUrl || "";

        const lines = [];
        if (w.release) lines.push("发售: " + String(w.release).substring(0, 10));
        const dur = fmtDuration(w.duration);
        if (dur) lines.push("时长: " + dur);
        if (w.rate_average_2dp) lines.push("评分: " + w.rate_average_2dp);
        if (w.dl_count) lines.push("下载: " + w.dl_count);
        if (w.vas && w.vas.length) lines.push("声优: " + w.vas.map((v) => v.name || v).join(" / "));
        if (w.tags && w.tags.length) lines.push("标签: " + w.tags.map((t) => t.name || t).join(" / "));
        content = lines.join("\n");
      }

      list.push({
        vod_id: wid,
        vod_name: title,
        vod_pic: pic,
        vod_content: content + (content ? "\n" : "") + "※ 音轨需登录，播放会打开网页",
        vod_play_from: "asmr.one",
        vod_play_url: "网页播放$" + wid,
      });
    }
    return { list: list };
  }

  // 播放：直接打开作品网页（浏览器里可登录后收听）
  async playerContent(flag, id, vipFlags) {
    const wid = String(id).replace(/^.*\//, "");
    try {
      openWeb({ url: SITE + "/work/" + wid });
    } catch (e) {
      this.log("openWeb failed: " + e);
    }
    throw new Error("已用内置浏览器打开作品页，请在网页里登录后播放");
  }

  async searchContent(key, quick, pg = "1") {
    const p = Number(pg) || 1;
    const url = API + "/api/search/" + encodeURIComponent(key) + "?page=" + p + "&pageSize=20";

    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 20, 0);

    let data;
    try {
      data = JSON.parse(r.content);
    } catch (e) {
      return this.page([], p, 20, 0);
    }

    const works = data.works || [];
    const cards = [];
    for (const w of works) {
      this.cache[w.id] = w;
      cards.push(toCard(w));
    }
    if (cards.length === 0) return this.page([], p, 20, (p - 1) * 20);
    return this.page(cards, p, 20, (p + 1) * 20);
  }
}
