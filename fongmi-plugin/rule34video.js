// Rule34Video（rule34video.com）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯视频（单画质 360p mp4 直链，带 acctoken）
//   列表  /                                    路径式分页 /N/   24 条/页
//   分类  /categories/<slug>/                  路径式分页 /<N>/
//   标签  /tags/<slug>/                        路径式分页 /<N>/
//   模型  /models/<slug>/                      路径式分页 /<N>/
//   详情  /video/<id>/<slug>/                  播放地址 video_url: '.../get_file/.../<id>_360.mp4/?v-acctoken=...'
//   搜索  /search/<kw>/                        路径式 /<N>/ ；带高级筛选时站点自己走 /search/?from_videos=N
//   补全  /tags_json.php /categories_json.php /models_json.php   （分面搜索数据源）
//
// 筛选参数（全部来自站点 custom.min.js 的 FILTER 模块，非猜测）：
//   sort_by            post_date|video_viewed|rating|duration|pseudo_rand
//   flag1              组 id（Type），逗号多值；站点首页 data-groups 给出全集
//   post_date_from     1..6 = 站点自己的相对天数码（1=24h 2=2天 3=周 4=月 5=3月 6=年），0=今天；也接受 ISO YYYY-MM-DD
//   post_date_to       ISO（自定义区间）
//   duration_from/_to  秒
//   is_hd              1=720p+ 2=1080p+ 3=4K（站点把 4 归一到 3）
//   flag2              1=认证上传者 2=未认证
//   tag_ids / category_ids / model_ids  逗号数字 id；前缀 "all," = 同时满足(AND)，否则 OR
//   temp_skip_items    排除项，形态 tag:<id>,cat:<id>,model:<id>
//   分页               普通列表 = 路径式 /N/；/search/ = ?from_videos=N

import { Spider, openWeb } from "catvod";

const BASE = "https://rule34video.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

// ---------- 站点常量表（来源：站点 custom.min.js / 首页 data-groups） ----------

const SORTS = [
  ["post_date", "最近发布"],
  ["video_viewed", "最多观看"],
  ["rating", "最高评分"],
  ["duration", "时长最长"],
  ["pseudo_rand", "随机"],
];

/** Type（flag1）：站点首页 data-groups="2109:type:Straight,192:type:Gay,..." */
const GROUPS = [
  ["", "全部类型"],
  ["2109", "Straight"],
  ["192", "Gay"],
  ["15", "Futa"],
  ["4747", "Music"],
  ["1821", "Iwara"],
];

/** Date added（post_date_from 的相对码，和网页端 7 项一致） */
const DATES = [
  ["", "不限时间"],
  ["0", "今天"],
  ["1", "近 24 小时"],
  ["2", "近 2 天"],
  ["3", "近一周"],
  ["4", "近一月"],
  ["5", "近三月"],
  ["6", "近一年"],
];

/** Duration（duration_from/duration_to，秒；站点原样 "300-1200" 拆分） */
const DURS = [
  ["", "不限时长"],
  ["0-60", "1 分钟内"],
  ["60-300", "1-5 分钟"],
  ["300-1200", "5-20 分钟"],
  ["1200-", "20 分钟以上"],
];

/** Quality（is_hd） */
const QUALS = [
  ["", "任意画质"],
  ["1", "HD 720p+"],
  ["2", "Full HD 1080p+"],
  ["3", "4K"],
];

/** Uploaders（flag2） */
const UPS = [
  ["", "全部上传者"],
  ["1", "认证上传者"],
  ["2", "未认证上传者"],
];

/** 分面三组 → 站点补全接口 */
const FACETS = {
  tags: { endpoint: "/tags_json.php", param: "tag_ids", token: "tag", matchKey: "tagMatch" },
  cats: { endpoint: "/categories_json.php", param: "category_ids", token: "cat", matchKey: "catMatch" },
  arts: { endpoint: "/models_json.php", param: "model_ids", token: "model", matchKey: "artMatch" },
};

const GROUP_IDS = {};
for (const [v] of GROUPS) if (v) GROUP_IDS[v] = 1;

// ---------------- 小工具 ----------------

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

function jsonHdrs(ref) {
  const h = hdrs(ref);
  h["Accept"] = "application/json, text/javascript, */*; q=0.01";
  h["X-Requested-With"] = "XMLHttpRequest";
  return h;
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

/** JSON 字段用这个：只解实体、不收标签（标题里真可能出现尖括号） */
function plain(s) {
  return decode(String(s || "")).replace(/\s+/g, " ").trim();
}

function absolute(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|mix)\|/, "");
  if (u.indexOf("t:") === 0 || u.indexOf("a:") === 0 || u.indexOf("c:") === 0) u = u.substring(2);
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  return absolute(u);
}

/** slug 转可读名：3d → 3D、asa-mitaka-chainsaw-man → Asa Mitaka Chainsaw Man */
function slugName(slug) {
  const s = String(slug || "").replace(/\/$/, "");
  if (!s) return "";
  if (/^[0-9]+$/.test(s)) return s;
  return s.split("-").map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

/** "1,2" / ["1","2"] → 去空去重的字符串数组 */
function toList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? "" : v).split(",");
  const out = [];
  const seen = {};
  for (let i = 0; i < arr.length; i++) {
    const s = String(arr[i] == null ? "" : arr[i]).trim();
    if (!s || seen[s]) continue;
    seen[s] = 1;
    out.push(s);
  }
  return out;
}

/** 分面 id：接受 "123" 或 "tag:123" / "cat:123" / "art:123"，只留数字，站点上限 20 */
function numericIds(v, limit) {
  const out = toList(v)
    .map((s) => String(s).replace(/^(tag|cat|art|model|artist)s?:/i, ""))
    .filter((s) => /^[0-9]+$/.test(s) && s !== "0");
  const max = limit || 20;
  return out.slice(0, max);
}

/** 把 tag_ids 的 "all," 前缀规则封起来：match=all → 前缀 all, */
function idsParam(state, kind, list) {
  if (!list.length) return "";
  const match = state[kind === "tags" ? "tagMatch" : kind === "cats" ? "catMatch" : "artMatch"] || "all";
  return (match === "all" ? "all," : "") + list.join(",");
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  return y + "-" + m + "-" + day;
}

// ---------------- 筛选状态 → query ----------------

/**
 * extend → 站点 query 片段数组。
 * allowDate=false 时丢掉 post_date_*（站点的分类页/作者页/搜索页不支持日期筛选，带了会请求失败）。
 */
function filterQuery(extend, allowDate) {
  const ex = extend || {};
  const q = [];
  const push = (k, v) => { if (v !== "" && v != null) q.push([k, String(v)]); };

  const sort = String(ex.order || ex.sort || "");
  if (SORTS.some((s) => s[0] === sort)) push("sort_by", sort);

  // Type（flag1）：已知 id 才发，未知数字也放行（站点自己会校验）
  const types = toList(ex.type).filter((s) => /^\d+$/.test(s) && (GROUP_IDS[s] || s.length <= 6));
  if (types.length) push("flag1", types.join(","));

  // Date：相对码或 ISO 区间
  const date = String(ex.date || ex.time || "");
  if (allowDate && date) {
    const m = /^(\d{4}-\d{2}-\d{2})[-~:]?(\d{4}-\d{2}-\d{2})?$/.exec(date);
    if (/^[0-6]$/.test(date)) push("post_date_from", date);
    else if (m) {
      push("post_date_from", m[1]);
      push("post_date_to", m[2] || isoDate(new Date()));
    }
  }

  // Duration
  const dur = String(ex.dur || "");
  if (/^\d+-\d*$/.test(dur)) {
    const parts = dur.split("-");
    if (parts[0] && parts[0] !== "0") push("duration_from", parts[0]);
    if (parts[1]) push("duration_to", parts[1]);
  } else if (/^\d+-\d+$/.test(dur)) {
    push("duration_from", dur.split("-")[0]);
  }

  // Quality / Uploaders
  const hd = String(ex.hd || "");
  if (/^[1234]$/.test(hd)) push("is_hd", hd === "4" ? "3" : hd);
  const up = String(ex.up || "");
  if (/^[12]$/.test(up)) push("flag2", up);

  // 分面三组（含 / 排除）
  // tags 组的值可能是 "dir:<slug>"（站点 tags_json 不给数字 id），这类走标签页路径
  const tagDirs = toList(ex.tags)
    .map((v) => String(v))
    .filter((v) => v.indexOf("dir:") === 0)
    .map((v) => v.substring(4))
    .filter((v) => v)
    .slice(0, 1);            // 站点一次只走一个标签路径

  const inc = {
    tags: numericIds(toList(ex.tags).filter((v) => String(v).indexOf("dir:") !== 0)),
    cats: numericIds(ex.cats),
    arts: numericIds(ex.arts),
  };
  for (const k in FACETS) push(FACETS[k].param, idsParam({
    tagMatch: ex.tagMatch || "all",
    catMatch: ex.catMatch || "all",
    artMatch: ex.artMatch || "any",
  }, k, inc[k]));

  const excl = [];
  toList(ex.excl).forEach((tk) => {
    const m = /^(tag|cat|model|artist)s?:?([0-9]+)$/i.exec(tk.trim());
    if (!m) return;
    const head = m[1].toLowerCase();
    const kind = /^cat/.test(head) ? "cat" : /^(model|artist)/.test(head) ? "model" : "tag";
    excl.push(kind + ":" + m[2]);
  });
  if (excl.length) push("temp_skip_items", excl.join(","));

  return { q, hasFacet: !!(inc.tags.length || inc.cats.length || inc.arts.length), tagDirs: tagDirs };
}

/** 排除项里同 id 的 inc 要剔掉（站点 parseState 就是这个语义） */
function filterQueryForPage(ex, allowDate) {
  const r = filterQuery(ex, allowDate);
  const drop = {};
  toList(ex && ex.excl).forEach((tk) => {
    const m = /^(tag|cat|model)s?:?([0-9]+)$/i.exec(String(tk).trim());
    if (m) drop[m[1].toLowerCase() + ":" + m[2]] = 1;
  });
  if (!Object.keys(drop).length) return r;
  r.q = r.q.filter((p) => {
    if (p[0] !== "tag_ids" && p[0] !== "category_ids" && p[0] !== "model_ids") return true;
    const kind = p[0] === "tag_ids" ? "tag" : p[0] === "category_ids" ? "cat" : "model";
    const ids = p[1].replace(/^all,/, "").split(",").filter((s) => !drop[kind + ":" + s]);
    p[1] = (p[1].indexOf("all,") === 0 ? "all," : "") + ids.join(",");
    return ids.length > 0;
  });
  return r;
}

/** 站点分页：/search/ 用 ?from_videos=N；其余用路径式 /N/ */
function buildListUrl(path, p, pairs, searchMode) {
  let base = path || "/";
  base = base.replace(/\/(\d+)\/$/, "/");
  if (!base) base = "/";
  if (base.charAt(base.length - 1) !== "/") base += "/";

  const query = pairs.map((kv) => kv[0] + "=" + encodeURIComponent(kv[1]));
  if (searchMode) {
    if (p > 1) query.push("from_videos=" + p);
    return BASE + base + (query.length ? "?" + query.join("&") : "");
  }
  if (base === "/") return BASE + (p > 1 ? "/" + p + "/" : "/") + (query.length ? "?" + query.join("&") : "");
  return BASE + (p > 1 ? base + p + "/" : base) + (query.length ? "?" + query.join("&") : "");
}

function hasNextPage(html, p) {
  const next = p + 1;
  return String(html).indexOf("page=" + next + "\"") >= 0 ||
    String(html).indexOf("page=" + next + "&") >= 0 ||
    String(html).indexOf("page=" + next + "'") >= 0 ||
    String(html).indexOf("/" + next + "/\"") >= 0;
}

/** 站点列表块自带 data-total / data-pages，能拿到就精确分页 */
function listMeta(html) {
  const m = /data-total="(\d+)"[\s\S]{0,400}?data-pages="(\d+)"/.exec(String(html)) ||
    /data-pages="(\d+)"[\s\S]{0,400}?data-total="(\d+)"/.exec(String(html));
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const totalFirst = /data-total=/.test(String(html).slice(m.index, m.index + 40));
  const total = totalFirst ? a : b;
  const pages = totalFirst ? b : a;
  if (!pages || pages < 1) return null;
  return { total: total || pages * PAGE_SIZE, pages: pages };
}

/** page() 第 4 参要的是「总条数」= 总页数 × 每页；拿不到 meta 就退回满页推定 */
function totalFor(html, cards, p) {
  const meta = listMeta(html);
  if (meta && meta.pages >= p) return meta.pages * PAGE_SIZE;
  const more = hasNextPage(html, p) || cards.length >= PAGE_SIZE - 1;
  return more ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
}

// 卡片：<div class="item thumb video_N" data-video-card-id="ID"> … <a class="th …" href="/video/…" title="…"> <img class="thumb" src="…336x189/1.jpg">
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = String(html).split(/class="item thumb video_\d+/);
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i].substring(0, 2500);
    const link = b.match(/href="(https:\/\/rule34video\.com\/video\/[^"]+)"/);
    if (!link) continue;                       // 广告位没有 /video/ 链接
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const img = b.match(/<img[^>]*class="thumb"[^>]*src="([^"]+)"/) || b.match(/<img[^>]*src="([^"]+videos_screenshots[^"]*)"/);
    const title = b.match(/<a[^>]*class="th[^"]*"[^>]*title="([^"]*)"/) || b.match(/<img[^>]*alt="([^"]*)"/);
    const dur = b.match(/class="duration"[^>]*>\s*([\d:]{4,10})\s*</);

    out.push({
      vod_id: url,
      vod_name: clean(title ? title[1] : "") || url,
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: dur ? dur[1] : "",
    });
  }
  return out;
}

// ---------------- filters 声明 ----------------

function mapOpts(table) {
  return table.map((x) => ({ n: x[1], v: x[0] }));
}

/**
 * 分面组：tags / cats / arts
 * 站点约定：
 *   cats  → category_ids 用数字 id（categories_json.php 的 items[].id 就是数字）
 *   arts  → model_ids 用数字 id（models_json.php 同理）
 *   tags  → tag_ids 用数字 id，但 tags_json.php 返回的 items[].id 是**标签名**！
 *           真正的数字 id 只在页面元素 data-tag-id 上，所以 tags 组用
 *           `dir`（slug）当选项值，发送时再换成数字（见 tagIdCache）。
 */
function facetGroup(key, name) {
  return { key: key, name: name, multi: true, type: "facet", value: facetOptions(key) };
}

/** 内置一组常用分面选项（离线可用；App 点开就能选）
 *  ⚠️ 第一项必须是空值「不限」——App 会把每组第一项当默认选中，
 *     若第一项带了真实值，主页一进来就会带上 tag_ids/category_ids/model_ids，导致 0 条。
 */
function facetOptions(key) {
  if (key === "tags") return [
    { n: "不限", v: "" },
    { n: "Genshin Impact", v: "tag:1942" },
    { n: "Honkai Star Rail", v: "tag:2890" },
    { n: "Futanari", v: "tag:22" },
    { n: "3D", v: "tag:4688" },
    { n: "Blender", v: "tag:4687" },
  ];
  if (key === "cats") return [
    { n: "不限", v: "" },
    { n: "Genshin Impact", v: "cat:269" },
  ];
  if (key === "arts") return [
    { n: "不限", v: "" },
    { n: "Jackerman", v: "art:639" },
  ];
  return [];
}

/** 列表页通用筛选组（不含日期：站点的分类/作者/搜索页不支持日期） */
function chipGroups(noDate) {
  const g = [
    { key: "order", name: "排序", value: mapOpts(SORTS) },
    { key: "type", name: "类型", multi: true, value: mapOpts(GROUPS) },
    { key: "dur", name: "时长", value: mapOpts(DURS) },
    { key: "hd", name: "画质", value: mapOpts(QUALS) },
    { key: "up", name: "上传者", value: mapOpts(UPS) },
    facetGroup("tags", "标签"),
    facetGroup("cats", "分类"),
    facetGroup("arts", "画师"),
  ];
  if (!noDate) g.splice(2, 0, { key: "date", name: "时间", value: mapOpts(DATES) });
  return g;
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

export default class Rule34Video extends Spider {
  init() {
    this.subCache = null;
  }

  async homeContent() {
    const classes = [
      { type_id: "p:/", type_name: "视频" },
      { type_id: "cats", type_name: "分类" },
      { type_id: "models", type_name: "模型" },
      { type_id: "web", type_name: "网页" },
    ];
    return {
      class: classes,
      filters: {
        // "*" = 所有列表页通用（App 的 SpiderManager.filtersOf 会退回通配组）
        "*": chipGroups(true),
        "p:/": chipGroups(false),
      },
    };
  }

  /** 网页侧解析：文件夹条目（分类 / 模型） */
  parseFolders(html, kind) {
    const text = String(html || "");
    const re = new RegExp('href="https:\\/\\/rule34video\\.com\\/' + kind + '\\/([^"/]+)\\/"', "g");
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      marks.push({ slug: m[1], start: m.index, end: m.index + m[0].length });
    }

    const out = [];
    const seen = {};
    for (let i = 0; i < marks.length; i++) {
      const cur = marks[i];
      if (seen[cur.slug]) continue;
      seen[cur.slug] = 1;

      const stop = i + 1 < marks.length ? marks[i + 1].start : Math.min(text.length, cur.end + 3000);
      const block = text.substring(cur.end, Math.min(stop, cur.end + 3000));

      const nameM = block.match(/<div class="name">\s*([\s\S]{0,120}?)\s*<div class="count">/);
      const name = clean(nameM ? nameM[1] : "") || slugName(cur.slug);
      const cntM = block.match(/<div class="count">([\s\S]{0,200}?)<\/div>/);
      const cnt = cntM ? (clean(cntM[1]).match(/\d+/) || [""])[0] : "";

      out.push({
        vod_id: "p:/" + kind + "/" + cur.slug + "/",
        vod_name: name,
        vod_pic: "",
        vod_remarks: cnt ? cnt + " 视频" : "",
        vod_tag: "folder",
      });
    }
    return out;
  }

  /** 发请求：筛选模式下站点更挑参数，失败就退回「只带排序」再试一次，避免整页空掉 */
  async fetchList(url, fallbackUrl) {
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200 && r.content) return r.content;
      if (r && (r.code === 403 || r.code === 404 || r.code >= 500) && fallbackUrl && fallbackUrl !== url) {
        const r2 = await this.net.req(fallbackUrl, { headers: hdrs(fallbackUrl) });
        if (r2 && r2.code === 200) return r2.content;
      }
      if (fallbackUrl && fallbackUrl !== url) {
        const r3 = await this.net.req(fallbackUrl, { headers: hdrs(fallbackUrl) });
        if (r3 && r3.code === 200) return r3.content;
      }
    } catch (e) {
      if (fallbackUrl && fallbackUrl !== url) {
        try {
          const r4 = await this.net.req(fallbackUrl, { headers: hdrs(fallbackUrl) });
          if (r4 && r4.code === 200) return r4.content;
        } catch (e2) { /* 忽略 */ }
      }
    }
    return "";
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
      }
      return this.page([], p, PAGE_SIZE, 0);
    }

    // 分类 / 模型：返回文件夹列表（App 渲染成文字行，点一下下钻）
    if (tid === "cats" || tid === "models") {
      const path = tid === "cats" ? "/categories/" : "/models/";
      const url = BASE + path + (p > 1 ? "?page=" + p : "");
      let html = "";
      try {
        const r = await this.net.req(url, { headers: hdrs(url) });
        if (r && r.code === 200) html = r.content;
      } catch (e) {
        html = "";
      }
      const folders = html ? this.parseFolders(html, tid === "cats" ? "categories" : "models") : [];
      return this.page(folders, p, folders.length || 1, folders.length);
    }

    // p:<路径> → 路径；t:/a: → 对应页
    let path = "/";
    const sid = String(tid);
    if (sid.indexOf("p:") === 0) path = sid.substring(2);
    else if (sid.indexOf("t:") === 0 || sid.indexOf("a:") === 0 || sid.indexOf("c:") === 0) {
      path = pageUrlOf(sid).replace(/^https?:\/\/[^/]+/, "");
    }

    // path 里可能自带查询（抽屉里预设的排序/筛选，如 "p:/?sort_by=rating"）
    let pathPart = path;
    let fixedQuery = "";
    const qi = path.indexOf("?");
    if (qi >= 0) {
      pathPart = path.substring(0, qi);
      fixedQuery = path.substring(qi + 1);
    }
    const isSearchPath = /^\/search\//.test(pathPart) || pathPart === "/search/";
    const isHome = pathPart === "/" || pathPart === "";
    const allowDate = isHome && !isSearchPath;         // 站点只有首页支持日期筛选

    const fixed = [];
    if (fixedQuery) {
      fixedQuery.split("&").forEach((kv) => {
        const i = kv.indexOf("=");
        if (i > 0) fixed.push([kv.substring(0, i), decodeURIComponent(kv.substring(i + 1))]);
      });
    }

    const built = filterQueryForPage(extend || {}, allowDate);

    // tags 组若是 dir:<slug>（站点不给数字 tag id），直接换成 /tags/<slug>/ 路径
    if (built.tagDirs && built.tagDirs.length && !isSearchPath) {
      pathPart = "/tags/" + encodeURIComponent(built.tagDirs[0]) + "/";
      built.tagDirs = [];
    }
    const hasFilter = built.q.length > 0;
    // 站点的规则：带分面（tag_ids/category_ids/model_ids）时统一走 /search/
    let basePath = pathPart;
    let searchMode = isSearchPath;
    if (built.hasFacet && !isSearchPath) {
      basePath = "/search/";
      searchMode = true;
    }

    const keys = {};
    for (const kv of fixed) keys[kv[0]] = 1;
    const pairs = fixed.slice();
    for (const kv of built.q) if (!keys[kv[0]]) pairs.push(kv);

    const url = buildListUrl(basePath, p, pairs, searchMode);
    // 退回地址：只保留 sort_by，保证列表至少能出内容
    const onlySort = fixed.filter((kv) => kv[0] === "sort_by");
    const fallbackUrl = hasFilter ? buildListUrl(pathPart || "/", p, onlySort, isSearchPath) : url;

    const html = await this.fetchList(url, fallbackUrl);
    if (!html) return this.page([], p, PAGE_SIZE, Math.max(0, (p - 1) * PAGE_SIZE));

    const cards = parseCards(html);
    return this.page(cards, p, PAGE_SIZE, totalFor(html, cards, p));
  }

  /** 解析详情页的 Categories / Artist / Tags 区块（按 vp-group 切，避开侧边栏） */
  detailGroups(html) {
    const text = String(html || "");
    const out = {};
    const re = /<div class="label vp-group__title">\s*([^<]{1,20}?)\s*<\/div>([\s\S]{0,6000}?)(?=<div class="label vp-group__title">|<\/div>\s*<\/div>\s*<div class="row|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const label = m[1].trim();
      const block = m[2];
      const items = [];
      const seen = {};
      // 每种区块里的链接形态：categories/ models/ tags/
      const rx = /href="https:\/\/rule34video\.com\/(categories|models|tags)\/([^"\/]+)\/"[^>]*>([\s\S]{0,300}?)<\/a>/g;
      let mm;
      while ((mm = rx.exec(block)) !== null) {
        const url = "https://rule34video.com/" + mm[1] + "/" + mm[2] + "/";
        if (seen[url]) continue;
        seen[url] = 1;
        // 名字：优先 img alt，其次链接文本
        const alt = mm[3].match(/alt="([^"]{1,60})"/);
        const txt = mm[3].replace(/<[^>]+>/g, " ");
        items.push({
          url: url,
          name: (alt ? decode(alt[1]) : clean(txt)) || slugName(mm[2]),
        });
      }
      if (items.length) out[label] = items;
    }
    return out;
  }

  /** 详情页的「Related Videos」区块（最多 8 个，站点 data-display-limit=8） */
  relatedVideos(html) {
    const out = [];
    if (!html) return out;
    const start = html.indexOf('id="custom_list_videos_related_videos_items"');
    if (start < 0) return out;
    // 只取到这个区块结束（下一个 headline 或 60000 字符）
    const seg = html.substring(start, start + 60000);

    const re = /<a class="th" href="(https:\/\/rule34video\.com\/video\/[^"]+)"\s+title="([^"]*)"/g;
    let m;
    while ((m = re.exec(seg)) !== null) {
      const url = decode(m[1]);
      if (out.some((x) => x.url === url)) continue;

      // 往后找这一项的封面和时长
      const tail = seg.substring(m.index, m.index + 2000);
      const pic = tail.match(/data-rd-jpg="([^"]+)"/) || tail.match(/data-rd-src="([^"]+)"/);
      const dur = tail.match(/<div class="time">([^<]+)<\/div>/);

      out.push({
        url: url,
        name: clean(m[2]) || url,
        pic: pic ? decode(pic[1]) : "",
        remarks: dur ? clean(dur[1]) : "",
      });
    }
    return out;
  }

  async detailContent(ids) {
    const url = pageUrlOf(ids[0]);
    let title = "";
    let pic = "";
    let html = "";

    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }

    if (html) {
      const t = html.match(/<title>([^<]+)<\/title>/);
      if (t) title = clean(t[1]).replace(/\s*[-|]\s*Rule34Video.*$/i, "").trim();
      const shot = html.match(/content="(https:\/\/rule34video\.com\/contents\/videos_screenshots\/[^"]+)"/) ||
        html.match(/src="(https:\/\/rule34video\.com\/contents\/videos_screenshots\/[^"]+)"/);
      if (shot) pic = decode(shot[1]);
    }

    // 站点详情页把「Categories / Artist / Tags」放在 <div class="vp-group"> 里，
    // 每个区块由 <div class="label vp-group__title">XXX</div> 开头。
    // 注意：页面开头的 models 链接是侧边栏 Top Artists，不能用！必须按区块取。
    const groups = this.detailGroups(html);

    const lines = [];

    // 作者行：Artist 区块的第一个（App 会把它显示成作者并可点）
    const artists = groups.Artist || [];
    let authorRemarks = "";
    if (artists.length) {
      authorRemarks = "[a=cr:{\"id\":\"a:" + artists[0].url + "\"}/]" + artists[0].name + "[/a]";
    }

    // 分类 chips（用 c: 前缀，和标签区分）
    if ((groups.Categories || []).length) {
      lines.push((groups.Categories || []).map((x) => '[a=cr:{"id":"c:' + x.url + '"}/]' + x.name + "[/a]").join(" · "));
    }

    // 标签 chips
    if ((groups.Tags || []).length) {
      const tags = (groups.Tags || []).slice(0, 12)
        .map((x) => '[a=cr:{"id":"t:' + x.url + '"}/]' + x.name + "[/a]");
      lines.push(tags.join(" · "));
    }

    const list = [{
      vod_id: url,
      vod_name: title || url,
      vod_pic: pic,
      vod_content: lines.join("\n"),
      vod_remarks: authorRemarks,
      gallery: false,
      vod_play_from: "Rule34Video",
      vod_play_url: "正片$" + url,
    }];

    // 相关推荐：详情页自带的 Related Videos 区块（App 渲染成底部横向列表）
    for (const r of this.relatedVideos(html)) {
      list.push({
        vod_id: r.url,
        vod_name: r.name,
        vod_pic: r.pic,
        vod_remarks: r.remarks,
      });
    }

    return { list: list };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) throw new Error("详情页打不开");

    // video_url: 'https://…/<id>_360.mp4/?v-acctoken=…'
    const m = html.match(/video_url:\s*['"]([^'"]+\.mp4[^'"]*)['"]/) ||
      html.match(/(https:\/\/rule34video\.com\/get_file\/[^'"\s]+\.mp4[^'"\s]*)/);
    if (!m) throw new Error("没找到播放地址");

    return {
      parse: 0,
      url: decode(m[1]),
      header: { "User-Agent": UA, "Referer": url },
    };
  }

  // ---------------- 侧边栏（App 左侧抽屉） ----------------
  // App 调 action("side|") 期望 { groups:[{name, items:[{name, id}]}] }
  // App 调 action("facet|<tags|cats|arts>|<关键字>[|<页码>]") 期望 { items:[{id,name,count}] }
  async action(op) {
    const s = String(op || "");

    if (s.indexOf("facet|") === 0) {
      const seg = s.substring(6).split("|");
      const kind = FACETS[seg[0]] ? seg[0] : "tags";
      const kw = seg[1] || "";
      const pg = Number(seg[2]) || 1;
      return this.facet(kind, kw, pg);
    }

    if (s.indexOf("side|") !== 0) return {};

    const groups = [];

    // ② 热门角色：站点 /top-characters/ 是前端渲染，暂留占位
    groups.push({
      name: "热门角色",
      disabled: true,
      hint: "站点这一页由前端渲染，暂未支持",
      items: [],
    });

    // ③ 热门搜索：首页侧边栏 Trending searches（标签云）
    let html = "";
    try {
      const r = await this.net.req(BASE + "/", { headers: hdrs(BASE + "/") });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }

    const trending = html ? this.sideTrending(html) : [];
    if (trending.length) groups.push({ name: "热门搜索", items: trending });

    // ④ 热门分类（带视频数）
    const cats = html ? this.parseAside(html, "categories", 10) : [];
    if (cats.length) groups.push({ name: "热门分类", items: cats });

    // ⑤ 热门画师（带视频数）
    const artists = html ? this.parseAside(html, "models", 10) : [];
    if (artists.length) groups.push({ name: "热门画师", items: artists });

    return { groups: groups };
  }

  /** 热门搜索：首页侧边栏 Trending searches 区块（也是标签云） */
  sideTrending(html) {
    const text = String(html || "");
    const at = text.indexOf("Trending searches");
    if (at < 0) return [];
    const next = text.indexOf('<div class="box', at + 10);
    const seg = text.substring(at, next > at ? next : at + 6000);

    const out = [];
    const seen = {};
    const re = /href="https:\/\/rule34video\.com\/tags\/([^"/]+)\/"[^>]*>([^<]{0,60})<\/a>/g;
    let m;
    while ((m = re.exec(seg)) !== null) {
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      out.push({ name: clean(m[2]) || slugName(slug), id: "p:/tags/" + slug + "/" });
      if (out.length >= 30) break;
    }
    return out;
  }

  /** 分面搜索：代理站点自己的三个 *_json.php 自动补全接口 */
  async facet(kind, kw, pg) {
    const def = FACETS[kind] || FACETS.tags;
    const q = String(kw || "").trim();
    if (!q) return { items: [] };
    let u = BASE + def.endpoint + "?q=" + encodeURIComponent(q) + "&advanced_search=true";
    if (kind === "tags") u += "&id=true";
    if (pg > 1) u += "&page=" + pg;

    let html = "";
    try {
      const r = await this.net.req(u, { headers: jsonHdrs(BASE + "/") });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return { items: [] };

    let obj = null;
    try {
      obj = JSON.parse(html);
    } catch (e) {
      obj = null;
    }
    const raw = obj && Array.isArray(obj.items) ? obj.items : [];
    const items = [];
    for (let i = 0; i < raw.length; i++) {
      const it = raw[i] || {};
      const id = String(it.id == null ? "" : it.id);
      const dir = String(it.dir || "");
      const name = plain(it.title || it.name || dir || "") || id;

      // categories / models：id 就是数字，直接用
      // tags：tags_json 的 id 是**标签名**，站点 tag_ids 只认数字。
      //       但 /tags/<dir>/ 这条页面本身就能当标签筛选，所以 tags 项用 dir 走搜索路径。
      if (kind === "tags") {
        if (!dir && !id) continue;
        items.push({
          id: "dir:" + (dir || id),
          name: name,
          count: String(it.total == null ? "" : it.total),
          slug: dir || id,
        });
        continue;
      }

      if (!/^[0-9]+$/.test(id) || id === "0") continue;
      items.push({
        id: id,
        name: name,
        count: String(it.total == null ? "" : it.total),
        slug: dir,
      });
    }
    return { kind: kind, page: pg || 1, total: Number(obj && obj.total_count) || 0, items: items };
  }

  /** 从首页「侧边栏区域」解析某类条目（categories / models） */
  parseAside(html, kind, limit) {
    const text = String(html || "");
    const at = text.indexOf('class="aside');
    if (at < 0) return [];
    const seg = text.substring(at, at + 20000);   // 侧边栏两块（热门分类 + 热门画师）都在里面

    const out = [];
    const seen = {};
    const re = new RegExp('href="https:\\/\\/rule34video\\.com\\/' + kind + '\\/([^"/]+)\\/"', "g");
    const marks = [];
    let m;
    while ((m = re.exec(seg)) !== null) {
      marks.push({ slug: m[1], idx: m.index, end: m.index + m[0].length });
    }
    for (let i = 0; i < marks.length; i++) {
      const cur = marks[i];
      if (seen[cur.slug]) continue;
      seen[cur.slug] = 1;
      const stop = i + 1 < marks.length ? marks[i + 1].idx : Math.min(seg.length, cur.end + 1500);
      const block = seg.substring(cur.end, Math.min(stop, cur.end + 1500));

      const nm = block.match(/<div class="name">\s*([\s\S]{0,120}?)\s*(?:<div|$)/);
      const alt = block.match(/alt="([^"]{1,60})"/);
      const name = clean(nm ? nm[1] : "") || (alt ? decode(alt[1]) : "") || slugName(cur.slug);

      out.push({ name: name, id: "p:/" + kind + "/" + cur.slug + "/" });
      if (out.length >= limit) break;
    }
    return out;
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = buildListUrl("/search/" + encodeURIComponent(key) + "/", p, [], false);

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs(url) });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    return this.page(cards, p, PAGE_SIZE, totalFor(html, cards, p));
  }
}
