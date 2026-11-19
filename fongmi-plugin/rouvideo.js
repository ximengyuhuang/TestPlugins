// rou.video (肉視頻) —— FongMi / TVBox QuickJS 源（重写版）
//
// 站点结构（2026-11 现状）：
//   /home                     首页，多区块
//   /v?order=createdAt&page=N 全部视频，order: createdAt / likeCount / viewCount
//   /t/<标签>?order=&page=N   标签页
//   /search?q=<关键词>&page=N 搜索（SSR，可直接抓）
//   /series?f=fresh           剧集列表
//   /v/<id>                   视频详情（SSR，$_TSR.router 中带完整对象）
//   /s/<id>                   剧集合集页（episodes 列表）
//   /cat                      全部标签
//
// 取流：详情页 ev:{d:"<base64>",k:NN} → base64 后每字节 -k → {"videoUrl":"/api/hls/<id>"}
//       GET /api/hls/<id>（Cookie: ob=1，不跟随 302）→ 签名 PNG 地址
//       PNG 自定义块 roUd 里是 m3u8；分片 PNG 的 roUd 里是裸 MPEG-TS
//       插件改写分片地址走本地代理，代理按 Range 剥出 TS 给播放器

import { Spider, openWeb } from "catvod";

const BASE = "https://rou.video";
const UA =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64ToBytes(s) {
  const out = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "=") break;
    const v = B64.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function bytesToUtf8(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xc0) continue;
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (c < 0xf0)
      out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const off = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
    }
  }
  return out;
}

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u0026/g, "&");
}

// ---------------------------------------------------------------- inflate

function inflateRaw(data) {
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;

  function bits(n) {
    while (bitcnt < n) {
      if (pos >= data.length) throw new Error("unexpected end");
      bitbuf |= data[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  }

  function build(lengths) {
    let maxLen = 0;
    for (const l of lengths) if (l > maxLen) maxLen = l;
    const count = new Array(maxLen + 1).fill(0);
    for (const l of lengths) if (l) count[l]++;
    const next = new Array(maxLen + 1).fill(0);
    let code = 0;
    for (let b = 1; b <= maxLen; b++) {
      code = (code + count[b - 1]) << 1;
      next[b] = code;
    }
    const map = new Map();
    for (let i = 0; i < lengths.length; i++) {
      const l = lengths[i];
      if (!l) continue;
      map.set(l * 65536 + next[l], i);
      next[l]++;
    }
    return { map, maxLen };
  }

  function sym(h) {
    let code = 0;
    for (let len = 1; len <= h.maxLen; len++) {
      code = (code << 1) | bits(1);
      const s = h.map.get(len * 65536 + code);
      if (s !== undefined) return s;
    }
    throw new Error("bad huffman");
  }

  const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  const out = [];
  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0;
      bitcnt = 0;
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      for (let i = 0; i < len; i++) out.push(data[pos++]);
      continue;
    }
    let lit;
    let dist;
    if (type === 1) {
      const l = new Array(288);
      for (let i = 0; i < 144; i++) l[i] = 8;
      for (let i = 144; i < 256; i++) l[i] = 9;
      for (let i = 256; i < 280; i++) l[i] = 7;
      for (let i = 280; i < 288; i++) l[i] = 8;
      lit = build(l);
      dist = build(new Array(30).fill(5));
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const cl = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) cl[order[i]] = bits(3);
      const clh = build(cl);
      const lens = [];
      while (lens.length < hlit + hdist) {
        const s = sym(clh);
        if (s < 16) lens.push(s);
        else if (s === 16) {
          const prev = lens[lens.length - 1];
          const rep = 3 + bits(2);
          for (let i = 0; i < rep; i++) lens.push(prev);
        } else if (s === 17) {
          const rep = 3 + bits(3);
          for (let i = 0; i < rep; i++) lens.push(0);
        } else {
          const rep = 11 + bits(7);
          for (let i = 0; i < rep; i++) lens.push(0);
        }
      }
      lit = build(lens.slice(0, hlit));
      dist = build(lens.slice(hlit));
    } else {
      throw new Error("bad block");
    }

    for (;;) {
      const s = sym(lit);
      if (s < 256) out.push(s);
      else if (s === 256) break;
      else {
        const li = s - 257;
        const len = LB[li] + bits(LE[li]);
        const ds = sym(dist);
        const d = DB[ds] + bits(DE[ds]);
        const start = out.length - d;
        for (let i = 0; i < len; i++) out.push(out[start + i]);
      }
    }
  }
  return out;
}

function inflateZlib(bytes) {
  if ((bytes[0] & 0x0f) === 8) return inflateRaw(bytes.slice(2));
  return inflateRaw(bytes);
}

// ---------------------------------------------------------------- PNG

// 只解析 PNG 块头找 roUd，返回 {offset, length(len含 flag 字节)}
// 不需要读到块数据本身，所以读几 KB 就能算出来
function readRoUdHeader(bytes) {
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = ((bytes[off] << 24) >>> 0) + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
    if (off + 4 <= bytes.length) {
      const t0 = bytes[off + 4];
      const t1 = bytes[off + 5];
      const t2 = bytes[off + 6];
      const t3 = bytes[off + 7];
      if (t0 === 0x72 && t1 === 0x6f && t2 === 0x55 && t3 === 0x64) {
        return { offset: off, length: len };
      }
    }
    if (len <= 0) break;
    off += 12 + len;
  }
  return null;
}

// 找 roUd 自定义块，返回 {flag, data}
function readRoUd(bytes) {
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    if (len < 0) return null;
    const t0 = bytes[off + 4];
    const t1 = bytes[off + 5];
    const t2 = bytes[off + 6];
    const t3 = bytes[off + 7];
    if (t0 === 0x72 && t1 === 0x6f && t2 === 0x55 && t3 === 0x64) {
      if (len < 1) return null;
      const payload = bytes.slice(off + 9, off + 8 + len);
      return { flag: bytes[off + 8], data: payload, offset: off };
    }
    off += 12 + len;
  }
  return null;
}

// 从 PNG 字节解出文本（播放列表）
function decodePngText(bytes) {
  const chunk = readRoUd(bytes);
  if (!chunk) return "";
  const raw = chunk.flag & 1 ? inflateZlib(chunk.data) : chunk.data;
  return bytesToUtf8(raw);
}


// ---------------------------------------------------------------- 通用

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

// 解析列表页的卡片（HTML 锚点，兼容 SSR 对象键顺序不一致的页面）
function parseCards(html, kind) {
  const out = [];
  const seen = {};
  const isSeriesPage = kind === "series";
  const re = isSeriesPage
    ? /<a href="\/s\/(c[a-z0-9]{20,})"[^>]*class="group block min-w-0"[^>]*>([\s\S]{0,1800}?)<\/a>/g
    : /<a href="\/v\/(c[a-z0-9]{20,})"[^>]*class="group block min-w-0"[^>]*>([\s\S]{0,1800}?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (seen[id]) continue;
    const seg = m[2];

    let pic = "";
    let title = "";
    const imgs = seg.match(/<img[^>]*>/g) || [];
    for (const tag of imgs) {
      const src = (tag.match(/src="([^"]+)"/) || [])[1] || "";
      const alt = (tag.match(/alt="([^"]*)"/) || [])[1] || "";
      if (!src) continue;
      if (!pic) pic = src;
      if (alt && !title) {
        pic = src;
        title = alt;
      }
    }
    if (!title) {
      const h3 = seg.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      if (h3) title = h3[1].replace(/<[^>]+>/g, "").trim();
    }
    if (!pic || !title) continue;

    seen[id] = 1;
    const dur = parseCnDur(seg);
    const eps = seg.match(/共\s*(\d+)\s*集/);
    out.push({
      vod_id: isSeriesPage ? "s:" + id : id,
      vod_name: decodeEntities(title),
      vod_pic: decodeEntities(pic),
      vod_remarks: eps ? "共 " + eps[1] + " 集" : dur,
    });
  }
  return out;
}

// 卡片上的时长：2分59秒 / 1小時1分14秒
function parseCnDur(seg) {
  let m = seg.match(/(\d+)\s*小時\s*(\d+)\s*分\s*(\d+)\s*秒/);
  if (m) return m[1] + ":" + pad2(m[2]) + ":" + pad2(m[3]);
  m = seg.match(/(\d+)\s*分\s*(\d+)\s*秒/);
  if (m) return m[1] + ":" + pad2(m[2]);
  m = seg.match(/(\d+)\s*秒/);
  if (m) return "0:" + pad2(m[1]);
  return "";
}

function pad2(n) {
  const v = String(n);
  return v.length < 2 ? "0" + v : v;
}

function fmtDur(sec) {
  if (!sec || sec < 1) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  if (h > 0) return h + ":" + pad(m) + ":" + pad(ss);
  return m + ":" + pad(ss);
}

function totalPages(html) {
  let max = 0;
  const re = /(?:[?&]|&amp;)page=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const v = Number(m[1]);
    if (v > max) max = v;
  }
  return max;
}

function videoObject(html, id) {
  let at = html.indexOf('{id:"' + id + '"');
  if (at < 0) at = html.indexOf('id:"' + id + '"');
  if (at < 0) return null;
  const seg = html.substring(Math.max(0, at - 600), at + 4000);
  const nm = seg.match(/name:"([^"]*)"/);
  const cv = seg.match(/coverImageUrl:"([^"]+)"/);
  const ds = seg.match(/description:"([^"]*)"/);
  const du = seg.match(/duration:([0-9.]+)/);
  const ec = seg.match(/episodeCount:(\d+)/);
  const tags = [];
  const tg = seg.match(/tags:\$R\[\d+\]=\[([^\]]*)\]/);
  if (tg) {
    for (const it of tg[1].split(",")) {
      const s = it.replace(/^"|"$/g, "").trim();
      if (s && tags.indexOf(s) < 0) tags.push(decodeEntities(s));
    }
  }
  return {
    name: nm ? decodeEntities(nm[1]) : id,
    pic: cv ? decodeEntities(cv[1]) : "",
    desc: ds ? decodeEntities(ds[1]) : "",
    duration: du ? Number(du[1]) : 0,
    episodeCount: ec ? Number(ec[1]) : 0,
    tags: tags,
  };
}

function episodesOf(html) {
  const at = html.indexOf("episodes:$R[");
  if (at < 0) return [];
  const end = html.indexOf(",moreSeries", at);
  const seg = html.substring(at, end > at ? end : at + 16000);
  const out = [];
  const seen = {};
  const re = /\{id:"(c[a-z0-9]{20,})",name:"([^"]*)",episode:(\d+)/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = 1;
    out.push({ id: m[1], name: decodeEntities(m[2]), ep: Number(m[3]) });
  }
  out.sort((a, b) => a.ep - b.ep);
  return out;
}

// ---------------------------------------------------------------- 主体

export default class RouVideo extends Spider {
  init(extend) {
    void extend;
    this.sess = {};
    this.log("rou.video ready");
  }

  async homeContent(filter) {
    void filter;
    const classes = [
      { type_id: "home", type_name: "推荐", type_flag: "0" },
      { type_id: "latest", type_name: "最新", type_flag: "0" },
      { type_id: "like", type_name: "最多赞", type_flag: "0" },
      { type_id: "hot", type_name: "最多播放", type_flag: "0" },
      { type_id: "series", type_name: "剧集", type_flag: "0" },
      { type_id: "t:國產AV", type_name: "国产AV", type_flag: "0" },
      { type_id: "t:探花", type_name: "探花", type_flag: "0" },
      { type_id: "t:自拍流出", type_name: "自拍流出", type_flag: "0" },
      { type_id: "t:OnlyFans", type_name: "OnlyFans", type_flag: "0" },
      { type_id: "t:日本", type_name: "日本", type_flag: "0" },
      { type_id: "tagf", type_name: "标签", type_flag: "1" },
      { type_id: "web", type_name: "网页", type_flag: "1" },
    ];

    const orders = [
      { n: "最新", v: "createdAt" },
      { n: "最多赞", v: "likeCount" },
      { n: "最多播放", v: "viewCount" },
    ];
    const filters = {};
    for (const tid of ["latest", "like", "hot"]) {
      filters[tid] = [{ key: "order", name: "排序", value: orders }];
    }
    for (const c of classes) {
      if (c.type_id.indexOf("t:") === 0) filters[c.type_id] = [{ key: "order", name: "排序", value: orders }];
    }
    return { class: classes, filters: filters };
  }

  // 全站标签（/cat 页面里 /t/<name> 链接）
  async loadTags() {
    if (this.tagCache) return this.tagCache;
    const out = [];
    const seen = {};
    try {
      const r = await this.net.req(BASE + "/cat", { headers: headers() });
      if (r && r.code === 200) {
        const re = /\/t\/([^"?#\/]+)/g;
        let m;
        while ((m = re.exec(r.content)) !== null) {
          let t = m[1];
          try {
            t = decodeURIComponent(t);
          } catch (e) {}
          if (!t || seen[t]) continue;
          seen[t] = 1;
          out.push(t);
        }
      }
    } catch (e) {
      this.log("loadTags failed: " + e);
    }
    this.tagCache = out;
    return out;
  }

  letterKey(name) {
    const ch = String(name || "").trim().charAt(0).toUpperCase();
    return ch >= "A" && ch <= "Z" ? ch : "#";
  }

  async tagLetters() {
    const tags = await this.loadTags();
    const map = {};
    for (const t of tags) {
      const k = this.letterKey(t);
      (map[k] = map[k] || []).push(t);
    }
    return Object.keys(map)
      .sort()
      .map((k) => ({ key: k, items: map[k] }));
  }

  async categoryContent(tid, pg, filter, extend) {
    void filter;
    const p = Number(pg) || 1;

    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/v" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 26, 0);
    }

    if (tid === "tagf") {
      const tags = await this.loadTags();
      const list = tags.map((t) => ({
        vod_id: "t:" + t,
        vod_name: t,
        vod_pic: "",
        vod_remarks: "标签",
        vod_tag: "folder",
      }));
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    if (tid.indexOf("seg:") === 0) {
      const key = tid.substring(4);
      const groups = await this.tagLetters();
      const g = groups.find((x) => x.key === key);
      const list = (g ? g.items : []).map((t) => ({
        vod_id: "t:" + t,
        vod_name: t,
        vod_pic: "",
        vod_remarks: "标签",
        vod_tag: "folder",
      }));
      if (!list.length) {
        const tags = await this.loadTags();
        return this.page(
          [{ vod_id: "diag", vod_name: "「" + key + "」没有标签（索引共 " + tags.length + " 个）", vod_pic: "", vod_remarks: "", vod_tag: "folder" }],
          1, 1, 1
        );
      }
      return this.page(list, 1, Math.max(list.length, 1), Math.max(list.length, 1));
    }

    const order = (extend && extend.order) || "createdAt";
    let url = "";
    let kind = "video";
    if (tid === "home") {
      url = BASE + "/home";
    } else if (tid === "latest" || tid === "like" || tid === "hot") {
      url = BASE + "/v?order=" + order + "&page=" + p;
    } else if (tid === "series") {
      url = BASE + "/series?f=fresh&page=" + p;
      kind = "series";
    } else if (tid.indexOf("t:") === 0) {
      url = BASE + "/t/" + encodeURIComponent(tid.substring(2)) + "?order=" + order + "&page=" + p;
    } else {
      return this.page([], p, 26, 0);
    }

    let html = "";
    try {
      const r = await this.net.req(url, { headers: headers() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      this.log("category failed: " + e);
    }

    const cards = parseCards(html, kind);
    const pages = tid === "home" ? 1 : Math.max(totalPages(html), p);
    return this.page(cards, p, 26, pages);
  }

  async detailContent(ids) {
    const list = [];
    for (const raw of ids) {
      const key = String(raw).trim();
      const isSeries = key.indexOf("s:") === 0;
      const id = isSeries ? key.substring(2) : key.replace(/^.*\/v\//, "").replace(/[?#].*$/, "");
      const url = BASE + (isSeries ? "/s/" : "/v/") + id;

      let html = "";
      try {
        const r = await this.net.req(url, { headers: headers() });
        if (r && r.code === 200) html = r.content;
      } catch (e) {
        this.log("detail failed: " + e);
      }

      const info = videoObject(html, id) || { name: id, pic: "", desc: "", duration: 0, episodeCount: 0, tags: [] };
      const episodes = episodesOf(html);

      const parts = [];
      if (info.duration) parts.push("时长 " + fmtDur(info.duration));
      if (episodes.length) parts.push("共 " + episodes.length + " 集");
      const content = [parts.join(" · "), info.tags.length ? "标签：" + info.tags.join(" / ") : "", info.desc]
        .filter(Boolean)
        .join("\n");

      let playUrl;
      if (episodes.length > 0) {
        playUrl = episodes
          .map((e) => "第" + e.ep + "集$" + e.id)
          .join("#");
      } else {
        playUrl = "正片$" + id;
      }

      list.push({
        vod_id: key,
        vod_name: info.name,
        vod_pic: info.pic,
        vod_content: content,
        vod_remarks: episodes.length ? "共 " + episodes.length + " 集" : fmtDur(info.duration),
        vod_play_from: "rou.video",
        vod_play_url: playUrl,
      });
    }
    return { list: list };
  }

  async action(op, value) {
    void value;
    const s = String(op === undefined || op === null ? "" : op);
    if (s.indexOf("tags|") === 0) {
      const tags = await this.loadTags();
      const groups = {};
      for (const t of tags) {
        const k = this.letterKey(t);
        (groups[k] = groups[k] || []).push({ name: t, id: "t:" + t, count: 0 });
      }
      const list = Object.keys(groups)
        .sort()
        .map((k) => ({ letter: k, items: groups[k] }));
      return { groups: list };
    }
    if (s.indexOf("side|") === 0) {
      const tags = await this.loadTags();
      return {
        groups: [
          { name: "热门标签", items: tags.slice(0, 20).map((t) => ({ name: t, id: "t:" + t })) },
        ],
      };
    }
    return {};
  }

  async searchContent(key, quick, pg) {
    void quick;
    const p = Number(pg) || 1;
    const url = BASE + "/search?q=" + encodeURIComponent(String(key || "")) + "&page=" + p;
    let html = "";
    try {
      const r = await this.net.req(url, { headers: headers() });
      if (r && r.code === 200) html = r.content;
    } catch (e) {
      this.log("search failed: " + e);
    }
    const cards = parseCards(html, "video");
    return this.page(cards, p, 26, Math.max(totalPages(html), p));
  }

  // ---------------------------------------------------------------- 取流

  async readAll(stream) {
    const out = [];
    for (;;) {
      const buf = await stream.read(65536);
      if (!buf) break;
      const arr = new Uint8Array(buf);
      for (let i = 0; i < arr.length; i++) out.push(arr[i]);
    }
    try {
      stream.close();
    } catch (e) {}
    return out;
  }

  async readUntilRoUd(stream, limit) {
    const out = [];
    while (out.length < limit) {
      let buf;
      try {
        buf = await stream.read(4096);
      } catch (e) {
        break;
      }
      if (!buf) break;
      const arr = new Uint8Array(buf);
      for (let i = 0; i < arr.length; i++) out.push(arr[i]);
      const h = readRoUdHeader(out);
      if (h) {
        try {
          stream.close();
        } catch (e) {}
        return h;
      }
    }
    try {
      stream.close();
    } catch (e) {}
    return readRoUdHeader(out);
  }

  async playerContent(flag, id, vipFlags) {
    void flag;
    void vipFlags;
    const vid = String(id).replace(/^.*\/v\//, "").replace(/[?#].*$/, "");
    const pageUrl = BASE + "/v/" + vid;

    const r = await this.net.req(pageUrl, { headers: headers() });
    if (!r || r.code !== 200) throw new Error("无法打开详情页");

    const m = r.content.match(/ev:(?:\$\w+\[\d+\]=)?\{d:"([^"]+)",k:(-?\d+)\}/);
    if (!m) throw new Error("找不到播放数据");

    const raw = b64ToBytes(m[1]);
    const key = Number(m[2]);
    let plain = "";
    for (let i = 0; i < raw.length; i++) plain += String.fromCharCode((raw[i] - key) & 0xff);
    const vu = plain.match(/"videoUrl":"([^"]+)"/);
    if (!vu) throw new Error("播放数据解密失败");
    const videoPath = vu[1];

    const r2 = await this.net.req(BASE + videoPath, {
      headers: {
        "User-Agent": UA,
        "Origin": BASE,
        "Referer": pageUrl,
        "Cookie": "ob=1",
      },
      redirect: 0,
    });
    const hd = (r2 && r2.headers) || {};
    let loc = hd.location || hd.Location || "";
    if (!loc) throw new Error("没有拿到签名地址（状态 " + (r2 ? r2.code : "?") + "）");
    if (loc.indexOf("http") !== 0) loc = BASE + loc;

    const st = await this.net.openStream(loc, {
      headers: {
        "User-Agent": UA,
        "Origin": BASE,
        "Referer": BASE + "/",
        "Accept-Encoding": "identity",
      },
    });
    const pngBytes = await this.readAll(st);
    const playlist = decodePngText(pngBytes);
    if (!playlist || playlist.indexOf("#EXTM3U") < 0) throw new Error("播放列表解析失败");

    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const segs = [];
    const lines = playlist.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      if (l.charAt(0) === "#") {
        out.push(l);
        continue;
      }
      segs.push(l);
      out.push(this.proxyUrl({ s: token, i: String(segs.length - 1) }));
    }
    this.sess[token] = { segs: segs, playlist: out.join("\n") };

    return {
      parse: 0,
      url: this.proxyUrl({ s: token, m: "1" }),
      header: { "User-Agent": UA, "Referer": BASE + "/" },
    };
  }

  async proxy(params) {
    const sess = this.sess[params.s];
    if (!sess) return [404, "text/plain", "no session"];

    if (params.m === "1") {
      return [200, "application/vnd.apple.mpegurl", sess.playlist];
    }

    const idx = Number(params.i);
    const remote = sess.segs[idx];
    if (!remote) return [404, "text/plain", "no segment"];

    const baseHeaders = {
      "User-Agent": UA,
      "Origin": BASE,
      "Referer": BASE + "/",
      "Accept-Encoding": "identity",
    };

    const headStream = await this.net.openStream(remote, {
      headers: Object.assign({}, baseHeaders, { "Range": "bytes=0-65535" }),
    });
    const h = await this.readUntilRoUd(headStream, 65536);
    if (!h) return [404, "text/plain", "no roUd"];
    const start = h.offset + 9;
    const end = h.offset + 8 + h.length - 1;

    const s2 = await this.net.stream(remote, {
      headers: Object.assign({}, baseHeaders, { "Range": "bytes=" + start + "-" + end }),
    });
    if (!s2 || !s2.stream) {
      try {
        s2 && s2.close && s2.close();
      } catch (e) {}
      return [404, "text/plain", "stream failed"];
    }
    return [200, "video/mp2t", s2.stream];
  }
}
