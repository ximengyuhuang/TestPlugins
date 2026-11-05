import { Spider, openWeb } from "catvod";

const BASE = "https://91porn.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 首页主分类（category 参数为空表示最近更新）
const CATS = [
  ["new", "", "最新"],
  ["hot", "hot", "当前最热"],
  ["top", "top", "本月最热"],
];

// 专题
const TOPICS = [
  ["ori", "91原创"],
  ["hd", "高清"],
  ["mf", "收藏最多"],
  ["tf", "本月收藏"],
  ["md", "本月讨论"],
  ["mr", "本月评价"],
];

// 时长
const DURATIONS = [
  ["long", "10分钟以上"],
  ["longer", "20分钟以上"],
];

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

// 去掉零宽字符（站点用来干扰抓取）
function clean(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\u200b-\u200f\u2060\ufeff\ufe00-\ufe0f]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absolute(u) {
  if (!u) return "";
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? u : "/" + u);
}

// 列表卡片
function parseCards(html) {
  const out = [];
  const seen = {};
  const parts = html.split(/<div class="well well-sm videos-text-align">/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].substring(0, 2600);
    const vk = block.match(/view_video\.php\?viewkey=([a-f0-9]+)/);
    if (!vk) continue;
    const id = vk[1];
    if (seen[id]) continue;
    seen[id] = 1;

    const img = block.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"/);
    const dur = block.match(/<span class="duration">\s*([^<]*?)\s*<\/span>/);
    const title = block.match(/<span class="video-title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const author = block.match(/作者:\s*<\/(?:span|strong|b)>\s*(?:<a[^>]*>([^<]*)<\/a>|([^<]{1,40}))/)
      || block.match(/作者:\s*(?:<a[^>]*>([^<]*)<\/a>|([^<]{1,40}))/);

    out.push({
      vod_id: BASE + "/view_video.php?viewkey=" + id,
      vod_name: clean(title ? title[1] : "") || id,
      vod_pic: img ? absolute(img[1]) : "",
      vod_remarks: clean(dur ? dur[1] : ""),
      vod_author: author ? clean(author[1] || author[2] || "") : "",
    });
    if (out.length >= 30) break;
  }
  return out;
}

export default class P91 extends Spider {
  init(extend) {}

  async homeContent(filter) {
    const classes = [];
    for (const [tid, , name] of CATS) classes.push({ type_id: tid, type_name: name });
    classes.push({ type_id: "web", type_name: "网页" });
    classes.push({ type_id: "topf", type_name: "专题 (" + TOPICS.length + ")", type_flag: "1" });
    classes.push({ type_id: "durf", type_name: "时长 (" + DURATIONS.length + ")", type_flag: "1" });

    const sorts = CATS.map(([tid, , name]) => ({ n: name, v: tid }));
    const filters = {};
    for (const c of classes) filters[c.type_id] = [{ key: "sort", name: "排序", value: sorts }];

    return { class: classes, filters: filters };
  }

  // 文件夹：专题 / 时长
  folderList(kind) {
    const src = kind === "topf" ? TOPICS : DURATIONS;
    return src.map(([code, name]) => ({
      vod_id: "c:" + code,
      vod_name: name,
      vod_pic: "",
      vod_remarks: kind === "topf" ? "专题" : "时长",
      vod_tag: "folder",
    }));
  }

  async categoryContent(tid, pg, filter, extend) {
    const p = Number(pg) || 1;

    if (tid === "topf" || tid === "durf") {
      const list = this.folderList(tid);
      return this.page(list, 1, list.length, list.length);
    }

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 24, 0);
    }

    // 排序筛选覆盖
    let code = "";
    if (tid.indexOf("c:") === 0) {
      code = tid.substring(2);
    } else {
      for (const [key, c] of CATS) {
        if (key === tid) {
          code = c;
          break;
        }
      }
      const s = (extend && extend.sort) || "";
      if (s) {
        for (const [key, c] of CATS) {
          if (key === s) {
            code = c;
            break;
          }
        }
      }
    }

    let url = BASE + "/v.php?page=" + p;
    if (code) url += "&category=" + code;

    const r = await this.net.req(url, { headers: headers(BASE + "/v.php?page=1") });
    if (!r || r.code !== 200) return this.page([], p, 24, 0);

    const cards = parseCards(r.content);
    if (cards.length === 0) return this.page([], p, 24, (p - 1) * 24);
    return this.page(cards, p, 24, (p + 1) * 24);
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const pageUrl = absolute(id);
      let title = "";
      let pic = "";
      let content = "";
      let duration = "";
      let author = "";

      try {
        const r = await this.net.req(pageUrl, { headers: headers(BASE + "/v.php?page=1") });
        if (r && r.code === 200) {
          const html = r.content;

          const t = html.match(/<title>([^<]+)<\/title>/);
          if (t) title = clean(t[1]).replace(/\s*-\s*91porn\s*$/i, "");

          const og = html.match(/property="og:image"[^>]*content="([^"]+)"/);
          if (og) pic = absolute(og[1]);

          const dur = html.match(/时长:\s*([0-9:]{4,10})/);
          if (dur) duration = dur[1];

          const au = html.match(/作者:\s*<\/(?:span|strong|b)>\s*(?:<a[^>]*>([^<]*)<\/a>|([^<]{1,40}))/)
            || html.match(/作者:\s*(?:<a[^>]*>([^<]*)<\/a>|([^<]{1,40}))/);
          if (au) author = clean(au[1] || au[2] || "");

          const add = html.match(/添加时间:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
          const views = html.match(/热度:\s*([0-9,]{1,12})/);

          const lines = [];
          if (add) lines.push("添加: " + add[1]);
          if (duration) lines.push("时长: " + duration);
          if (views) lines.push("热度: " + views[1]);
          content = lines.join("\n");
        }
      } catch (e) {
        this.log("detail failed: " + e);
      }

      list.push({
        vod_id: pageUrl,
        vod_name: title || pageUrl,
        vod_pic: pic,
        vod_content: content,
        vod_remarks: duration,
        vod_actor: author,
      });
    }
    return { list: list };
  }

  async playerContent(flag, id, vipFlags) {
    const pageUrl = absolute(id);

    const r = await this.net.req(pageUrl, { headers: headers(BASE + "/v.php?page=1") });
    if (!r || r.code !== 200) throw new Error("详情页打不开");

    const html = r.content;
    let url = "";
    const s1 = html.match(/<source[^>]+src="([^"]+\.mp4[^"]*)"/);
    if (s1) url = clean(s1[1]);
    if (!url) {
      const s2 = html.match(/(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/);
      if (s2) url = clean(s2[1]);
    }
    if (!url) throw new Error("没有找到视频地址（可能是 VIP 内容）");

    return {
      parse: 0,
      url: url,
      header: {
        "User-Agent": UA,
        "Referer": pageUrl,
      },
    };
  }

  async searchContent(key, quick, pg = "1") {
    return this.page([], Number(pg) || 1, 24, 0);
  }
}
