// asmr.one —— BiliTV / catvod QuickJS 插件
//
// 站点：https://asmr.one
// 数据：https://api.asmr-200.com（列表 / 搜索 / 封面公开；作品详情与音轨需登录）
// 因此：浏览 + 搜索走 API，详情用「缓存 → 按 id 搜索」两段兜底，播放打开内置浏览器。

var SITE = "https://asmr.one";
var API = "https://api.asmr-200.com";
var UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
var PAGE_SIZE = 20;

var ORDERS = [
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
  var s = Number(sec) || 0;
  if (!s) return "";
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  return h ? h + " 小时 " + m + " 分" : m + " 分钟";
}

function toCard(w) {
  var circle = (w.circle && w.circle.name) || "";
  var remarks = fmtDuration(w.duration) || circle || String(w.release || "").substring(0, 10);
  return {
    vod_id: String(w.id),
    vod_name: (circle ? "[" + circle + "] " : "") + (w.title || w.name || String(w.id)),
    vod_pic: w.mainCoverUrl || w.samCoverUrl || "",
    vod_remarks: remarks,
    vod_tag: "video",
  };
}

function parseWork(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
}

function workContent(w) {
  var lines = [];
  if (w.release) lines.push("发售：" + String(w.release).substring(0, 10));
  var dur = fmtDuration(w.duration);
  if (dur) lines.push("时长：" + dur);
  if (w.rate_average_2dp) lines.push("评分：" + w.rate_average_2dp + "（" + (w.rate_count || 0) + " 人）");
  if (w.dl_count) lines.push("下载：" + w.dl_count);
  var vas = (w.vas || []).map(function (v) { return v.name || v; }).filter(Boolean);
  if (vas.length) lines.push("声优：" + vas.join(" / "));
  var tags = (w.tags || []).map(function (t) { return t.name || t; }).filter(Boolean);
  if (tags.length) lines.push("标签：" + tags.join(" / "));
  if (w.circle && w.circle.name) lines.push("社团：" + w.circle.name);
  lines.push("※ 音轨需要登录，点「网页播放」在内置浏览器里收听");
  return lines.join("\n");
}

var spider = {
  init() {
    this.cache = {};
  },

  homeContent() {
    var classes = [];
    var sorts = [];
    for (var i = 0; i < ORDERS.length; i++) {
      classes.push({ type_id: "o:" + ORDERS[i][0], type_name: ORDERS[i][1] });
      sorts.push({ n: ORDERS[i][1], v: ORDERS[i][0] });
    }
    classes.push({ type_id: "web", type_name: "网页" });

    // order 组会被 App 抽到「排序」按钮里
    var filters = {};
    for (var j = 0; j < classes.length; j++) {
      if (classes[j].type_id === "web") continue;
      filters[classes[j].type_id] = [{ key: "order", name: "排序", value: sorts }];
    }
    return { class: classes, filters: filters };
  },

  categoryContent(tid, pg, filter, extend) {
    var p = parseInt(pg) || 1;
    if (tid === "web") {
      try {
        openWeb({ url: SITE + "/works" });
      } catch (e) {
      }
      return this.page([], p, PAGE_SIZE, 0);
    }

    var order = (extend && extend.order) || (tid.indexOf("o:") === 0 ? tid.substring(2) : "release");
    var url = API + "/api/works?page=" + p + "&pageSize=" + PAGE_SIZE + "&order=" + encodeURIComponent(order);
    var data = null;
    try {
      var r = this.net.req(url, { headers: headers(), timeout: 20000 });
      data = parseWork(r && r.content);
    } catch (e) {
      data = null;
    }
    if (!data) return this.page([], p, PAGE_SIZE, 0);

    var works = data.works || [];
    var cards = [];
    for (var i = 0; i < works.length; i++) {
      this.cache[works[i].id] = works[i];
      cards.push(toCard(works[i]));
    }
    var total = (data.pagination && data.pagination.totalCount) || 0;
    return this.page(cards, p, PAGE_SIZE, total);
  },

  detailContent(ids) {
    var id = String(ids[0] || "").replace(/^.*\//, "");
    var w = (this.cache && this.cache[id]) || null;

    // 缓存没有（收藏/历史直接打开）→ 用搜索接口按 id 兜底
    if (!w) {
      try {
        var r = this.net.req(API + "/api/search/" + encodeURIComponent(id) + "?page=1&pageSize=1",
          { headers: headers(), timeout: 20000 });
        var data = parseWork(r && r.content);
        var works = (data && data.works) || [];
        for (var i = 0; i < works.length; i++) {
          if (String(works[i].id) === id) {
            w = works[i];
            break;
          }
        }
        if (!w && works.length) w = works[0];
        if (w && this.cache) this.cache[id] = w;
      } catch (e) {
      }
    }

    var circle = (w && w.circle && w.circle.name) || "";
    var title = w ? ((circle ? "[" + circle + "] " : "") + (w.title || w.name || id)) : ("作品 " + id);
    var pic = (w && (w.mainCoverUrl || w.samCoverUrl)) || "";

    var item = {
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_content: w ? workContent(w) : "※ 音轨需要登录，点「网页播放」在内置浏览器里收听",
      vod_remarks: w ? (fmtDuration(w.duration) || circle) : "",
      gallery: false,
      vod_play_from: "asmr.one",
      vod_play_url: "网页播放$" + id,
    };

    // 同社团其它作品作推荐
    var list = [item];
    if (w && w.circle_id) {
      try {
        var r2 = this.net.req(API + "/api/works?page=1&pageSize=6&order=release&circle=" + w.circle_id,
          { headers: headers(), timeout: 20000 });
        var d2 = parseWork(r2 && r2.content);
        var more = (d2 && d2.works) || [];
        for (var k = 0; k < more.length && list.length < 7; k++) {
          if (String(more[k].id) === id) continue;
          var c = toCard(more[k]);
          list.push({ vod_id: c.vod_id, vod_name: c.vod_name, vod_pic: c.vod_pic, vod_remarks: c.vod_remarks });
        }
      } catch (e) {
      }
    }
    return { list: list };
  },

  searchContent(key, quick, pg) {
    var p = parseInt(pg) || 1;
    var url = API + "/api/search/" + encodeURIComponent(key) + "?page=" + p + "&pageSize=" + PAGE_SIZE;
    var data = null;
    try {
      var r = this.net.req(url, { headers: headers(), timeout: 20000 });
      data = parseWork(r && r.content);
    } catch (e) {
      data = null;
    }
    if (!data) return this.page([], p, PAGE_SIZE, 0);

    var works = data.works || [];
    var cards = [];
    for (var i = 0; i < works.length; i++) {
      this.cache[works[i].id] = works[i];
      cards.push(toCard(works[i]));
    }
    var total = (data.pagination && data.pagination.totalCount) || 0;
    return this.page(cards, p, PAGE_SIZE, total);
  },

  playerContent(flag, id) {
    var wid = String(id).replace(/^.*\//, "");
    try {
      openWeb({ url: SITE + "/work/" + wid });
    } catch (e) {
    }
    throw new Error("ASMR.one 音轨需登录，已打开网页播放");
  },

  action(op) {
    // 站点没有公开的标签/社团列表接口（401），这里不提供额外入口
    return [];
  },
};
