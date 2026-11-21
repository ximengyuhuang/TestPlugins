// Hanime1（hanime1.me）—— BiliTV / catvod QuickJS 插件
//
// 站类型：纯视频（H 動漫）
//   ⚠️ 站点对桌面 UA / curl 指纹做 Cloudflare 挑战（Cf-Mitigated: challenge），
//      但**安卓 Chrome UA 直接放行**（实测 200），所以 UA 必须是手机 Chrome。
//
//   列表  /search?query=&type=&genre=<类型>&sort=<排序>&date=<时间>&duration=<时长>&tags[]=<标签>&page=N
//   详情  /watch?v=<id>          og:title / og:image / og:video:duration
//   作者  <a id="video-artist-name" href="?query=xxx">
//   分类  <a href="?genre=xxx">（作者旁）
//   标签  <div class="video-tags-wrapper"> 里的 ?tags[]=xxx
//   播放  https://vdownload.hembed.com/<id>-1080p.mp4?secure=...（1080p/720p/480p）
//
// 筛选：类型(10) / 标签(7 组 240 个) / 排序(9) / 时间(7) / 时长(8)

import { Spider, openWeb } from "catvod";

const BASE = "https://hanime1.me";
// 手机 Chrome 指纹：过 Cloudflare 的关键
const UA = "Mozilla/5.0 (Linux; Android 14; ELI-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PAGE_SIZE = 60;

// ---------------- 站点筛选值（与站点表单一致） ----------------
const GENRES = ["全部", "裏番", "泡麵番", "Motion Anime", "3DCG", "2.5D", "2D動畫", "AI生成", "MMD", "Cosplay", "新番預告"];

const SORTS = ["最新上市", "最新上傳", "本日排行", "本週排行", "本月排行", "觀看次數", "讚好比例", "時長最長", "他們在看"];

const DATES = ["全部", "過去 24 小時", "過去 2 天", "過去 1 週", "過去 1 個月", "過去 3 個月", "過去 1 年"];

const DURS = ["全部", "1 分鐘 +", "5 分鐘 +", "10 分鐘 +", "20 分鐘 +", "30 分鐘 +", "60 分鐘 +", "0 - 10 分鐘"];

// 标签分 7 组，与站点「影片屬性/人物關係/角色設定/外貌身材/情境場所/故事劇情/性交體位」一致
const TAG_GROUPS = [
  ["影片屬性", ["無碼", "AI解碼", "中文字幕", "中文配音", "同人作品", "斷面圖", "ASMR", "1080p", "60FPS"]],
  ["人物關係", ["近親", "姐", "妹", "母", "女兒", "師生", "情侶", "青梅竹馬", "同事"]],
  ["角色設定", ["JK", "處女", "御姐", "熟女", "人妻", "女教師", "男教師", "女醫生", "女病人", "護士",
    "OL", "女警", "大小姐", "偶像", "女僕", "巫女", "魔女", "修女", "風俗娘", "公主",
    "女忍者", "女戰士", "女騎士", "魔法少女", "異種族", "天使", "妖精", "魔物娘", "魅魔", "吸血鬼",
    "女鬼", "獸娘", "福瑞", "乳牛", "機械娘", "碧池", "痴女", "雌小鬼", "不良少女", "傲嬌",
    "病嬌", "無口", "無表情", "眼神死", "正太", "偽娘", "扶他"]],
  ["外貌身材", ["短髮", "馬尾", "雙馬尾", "丸子頭", "巨乳", "乳環", "舌環", "貧乳", "黑皮膚", "曬痕",
    "眼鏡娘", "獸耳", "尖耳朵", "異色瞳", "美人痣", "肌肉女", "白虎", "陰毛", "腋毛", "大屌",
    "黑屌", "著衣", "水手服", "體操服", "泳裝", "比基尼", "死庫水", "和服", "兔女郎", "圍裙",
    "啦啦隊", "絲襪", "吊襪帶", "熱褲", "迷你裙", "性感內衣", "緊身衣", "丁字褲", "高跟鞋", "睡衣",
    "婚紗", "旗袍", "古裝", "哥德", "口罩", "刺青", "淫紋", "身體寫字"]],
  ["情境場所", ["校園", "教室", "圖書館", "保健室", "體育倉庫", "游泳池", "愛情賓館", "醫院", "辦公室", "浴室",
    "窗邊", "公共廁所", "公眾場合", "戶外野戰", "電車", "車震", "遊艇", "露營帳篷", "電影院", "健身房",
    "沙灘", "溫泉", "夜店", "監獄", "教堂"]],
  ["故事劇情", ["純愛", "戀愛喜劇", "後宮", "十指緊扣", "開大車", "NTR", "精神控制", "藥物", "痴漢", "阿嘿顏",
    "哭泣", "精神崩潰", "獵奇", "BDSM", "綑綁", "眼罩", "項圈", "調教", "異物插入", "尋歡洞",
    "肉便器", "性奴隸", "胃凸", "強制", "輪姦", "凌辱", "性暴力", "逆強制", "女王樣", "榨精",
    "母女丼", "姐妹丼", "出軌", "醉酒", "攝影", "睡眠姦", "機械姦", "蟲姦", "性轉換", "百合",
    "耽美", "時間停止", "異世界", "怪獸", "哥布林", "世界末日"]],
  ["性交體位", ["手交", "指交", "玩乳頭", "乳交", "乳頭交", "肛交", "雙洞齊下", "腳交", "素股", "拳交",
    "3P", "群交", "口交", "跪舔", "深喉嚨", "口爆", "吞精", "舔蛋蛋", "舔穴", "69",
    "自慰", "腋交", "舔腋下", "髮交", "舔耳朵", "舔腳", "內射", "外射", "顏射", "潮吹",
    "懷孕", "噴奶", "放尿", "排便", "騎乘位", "背後位", "側面位", "顏面騎乘", "火車便當", "一字馬",
    "性玩具", "飛機杯", "跳蛋", "毒龍鑽", "觸手", "獸交", "頸手枷", "扯頭髮", "掐脖子", "打屁股",
    "肉棒打臉", "陰道外翻", "男乳首責", "接吻", "舌吻", "POV"]],
];

// 标签 key → 组名（用于把选中的标签按组分到不同 extend 项）
const TAG_BY_GROUP = {};
for (const [gname, tags] of TAG_GROUPS) TAG_BY_GROUP[gname] = tags;

function hdrs(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium":"131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?1",
    "Sec-Ch-Ua-Platform": '"Android"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": ref ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Referer": ref || BASE + "/",
  };
}

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\\u0026/g, "&");
}

function clean(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function pageUrlOf(raw) {
  let u = String(raw || "").trim();
  u = u.replace(/^(v|mix)\|/, "");
  if (/^(t|a|c|q|g):/.test(u)) u = u.substring(2);
  const bar = u.lastIndexOf("|");
  if (bar > 0 && /^\d+$/.test(u.slice(bar + 1))) u = u.slice(0, bar);
  if (u.indexOf("http") === 0) return u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

// 站点两套卡片结构：首页 video-item-container / 分类页 home-rows-videos-div
// 统一按 watch?v= 链接切块
function parseCards(html) {
  const text = String(html || "");
  const marks = [];
  const re = /href="https:\/\/hanime1\.me\/watch\?v=\d+"/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const out = [];
  const seen = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : Math.min(text.length, from + 4000);
    const b = text.substring(from, to);

    const link = b.match(/href="(https:\/\/hanime1\.me\/watch\?v=\d+)"/);
    if (!link) continue;
    const url = link[1];
    if (seen[url]) continue;
    seen[url] = 1;

    const img = b.match(/<img[^>]*src="([^"]*\/image\/cover\/[^"]*)"/) ||
      b.match(/<img[^>]*src="([^"]*hembed[^"]*(?:thumbnail|cover)[^"]*)"/) ||
      b.match(/<img[^>]*class="[^"]*main-thumb[^"]*"[^>]*src="([^"]+)"/);

    const titleM = b.match(/<div class="home-rows-videos-title">\s*([\s\S]{0,400}?)<\/div>/) ||
      b.match(/<div class="title">\s*([\s\S]{0,400}?)<\/div>/);
    const dur = b.match(/<div class="duration">\s*([\d:]{2,10})\s*<\/div>/);

    out.push({
      vod_id: url,
      vod_name: clean(titleM ? titleM[1] : "") || url,
      vod_pic: img ? decode(img[1]) : "",
      vod_remarks: dur ? dur[1] : "",
    });
  }
  return out;
}

export default class Hanime1 extends Spider {
  init() {}

  async homeContent() {
    // 主页只留一个入口（分类/筛选都在筛选面板里）
    const classes = [
      { type_id: "all", type_name: "视频" },
      { type_id: "web", type_name: "网页" },
    ];

    // 筛选：类型 / 标签(7组) / 排序 / 时间 / 时长
    const filters = {
      all: [
        { key: "order", name: "排序", value: SORTS.map((s) => ({ n: s, v: s })) },
        { key: "genre", name: "类型", value: GENRES.map((s) => ({ n: s, v: s })) },
        { key: "date", name: "时间", value: DATES.map((s) => ({ n: s, v: s })) },
        { key: "dur", name: "时长", value: DURS.map((s) => ({ n: s, v: s })) },
        // 7 组标签：多选 + 可搜索（分面）
        ...TAG_GROUPS.map(([gname, tags]) => ({
          key: "tag_" + gname,
          name: gname,
          multi: true,
          value: tags.map((t) => ({ n: t, v: t })),
        })),
      ],
    };

    return { class: classes, filters: filters };
  }

  /** 按 extend 拼查询串 */
  buildQuery(extend) {
    const ex = extend || {};
    const parts = [];
    parts.push("query=");
    parts.push("type=");
    parts.push("genre=" + encodeURIComponent(ex.genre || "全部"));
    parts.push("sort=" + encodeURIComponent(ex.order || ex.sort || ""));
    parts.push("date=" + encodeURIComponent(ex.date || ""));
    parts.push("dur=" + encodeURIComponent(ex.dur || ""));

    // 站点参数名是 duration，不是 dur
    const idx = parts.length - 1;
    parts[idx] = "duration=" + encodeURIComponent(ex.dur || "");

    // 标签：7 组任选（可多选）
    for (const [gname] of TAG_GROUPS) {
      const v = ex["tag_" + gname];
      if (!v) continue;
      String(v).split(",").forEach((t) => {
        const name = t.trim();
        if (name) parts.push("tags%5B%5D=" + encodeURIComponent(name));
      });
    }
    return parts.join("&");
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

    const url = BASE + "/search?" + this.buildQuery(extend) + "&page=" + p;

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
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
    } catch (e) {
      html = "";
    }

    let title = "";
    let pic = "";
    let duration = "";

    if (html) {
      const t = html.match(/property="og:title"[^>]*content="([^"]*)"/);
      if (t) title = clean(t[1]).replace(/\s*-\s*Hanime1\.me.*$/i, "").trim();
      if (!title) {
        const t2 = html.match(/<title>([^<]*)<\/title>/);
        if (t2) title = clean(t2[1]).split(" - H動漫")[0].trim();
      }
      const img = html.match(/property="og:image"[^>]*content="([^"]*)"/);
      if (img) pic = decode(img[1]);
      const d = html.match(/property="og:video:duration"[^>]*content="(\d+)"/);
      if (d) {
        const sec = Number(d[1]);
        duration = Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
      }
    }

    const lines = [];
    if (duration) lines.push("时长：" + duration);

    // 作者
    let artistName = "";
    let artistId = "";
    const am = html.match(/id="video-artist-name"[^>]*href="([^"]+)"[^>]*>\s*([^<]{1,40})/);
    if (am) {
      artistName = clean(am[2]);
      const qm = am[1].match(/query=([^&"]+)/);
      if (qm) {
        let kw = decode(qm[1]).replace(/\+/g, " ");
        try { kw = decodeURIComponent(kw); } catch (e) { }
        const ai = kw.indexOf("&");
        if (ai > 0) kw = kw.substring(0, ai);
        artistId = "q:" + kw.trim();
      }
    }

    // 分类（作者旁的 genre 链接）
    const genres = [];
    const gm = html.match(/id="video-artist-name"[\s\S]{0,600}?search\?genre=([^"]+)"[^>]*>\s*([^<]{1,30})/);
    if (gm) {
      let g = decode(gm[1]);
      try { g = decodeURIComponent(g); } catch (e) { }
      genres.push('[a=cr={"id":"g:' + g.trim() + '"}/]' + clean(gm[2]) + "[/a]");
    }

    // 标签（video-tags-wrapper 区块）
    const tags = [];
    const seenT = {};
    const tw = html.match(/class="video-details-wrapper video-tags-wrapper"[\s\S]{0,8000}/);
    if (tw) {
      const re = /href="[^"]*[?&]tags(?:%5B%5D|\[\])=([^"]+)"[^>]*>([\s\S]{0,80}?)<\/a>/g;
      let m;
      while ((m = re.exec(tw[0])) !== null) {
        let kw = decode(m[1]).replace(/\+/g, " ");
        try { kw = decodeURIComponent(kw); } catch (e) { }
        const ai = kw.indexOf("&");
        if (ai > 0) kw = kw.substring(0, ai);
        kw = kw.trim();
        if (!kw || seenT[kw]) continue;
        seenT[kw] = 1;
        const name = clean(m[2]).replace(/\(\d+\)$/, "").trim() || kw;
        tags.push('[a=cr={"id":"q:' + kw + '"}/]' + name + "[/a]");
        if (tags.length >= 12) break;
      }
    }

    if (genres.length) lines.push(genres.join(" · "));
    if (tags.length) lines.push(tags.join(" · "));

    let authorRemarks = "";
    if (artistName) {
      authorRemarks = artistId
        ? '[a=cr={"id":"' + artistId + '"}/]' + artistName + "[/a]"
        : artistName;
    }

    return {
      list: [{
        vod_id: url,
        vod_name: title || url,
        vod_pic: pic,
        vod_content: lines.join("\n"),
        vod_remarks: authorRemarks || duration,
        gallery: false,
        vod_play_from: "Hanime1",
        vod_play_url: "正片$" + url,
      }],
    };
  }

  async playerContent(flag, id) {
    const url = pageUrlOf(id);
    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) throw new Error("详情页打不开");

    const all = [];
    const re = /(https:\/\/vdownload\.hembed\.com\/\d+-(1080p|720p|480p)\.mp4[^"'\s]*)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (all.indexOf(m[1]) < 0) all.push(m[1]);
    }
    if (!all.length) throw new Error("没找到播放地址");

    const pick = (q) => all.find((u) => u.indexOf("-" + q + ".mp4") > 0);
    const target = pick("1080p") || pick("720p") || pick("480p") || all[0];

    return {
      parse: 0,
      url: target,
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async searchContent(key, quick, pg) {
    const p = Number(pg) || 1;
    const url = BASE + "/search?query=" + encodeURIComponent(key) + "&page=" + p;

    let html = "";
    try {
      const r = await this.net.req(url, { headers: hdrs() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      html = "";
    }
    if (!html) return this.page([], p, PAGE_SIZE, 0);

    const cards = parseCards(html);
    const total = cards.length >= PAGE_SIZE - 1 ? (p + 1) * PAGE_SIZE : (p - 1) * PAGE_SIZE + cards.length;
    return this.page(cards, p, PAGE_SIZE, total);
  }
}
