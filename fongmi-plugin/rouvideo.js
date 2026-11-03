// rou.video —— FongMi / TVBox QuickJS 源
//
// 取流机制（参照 CloudStream 插件 Kraptor123/Cs-GizliKeyif 的 RouVideo.kt）：
//   1. 详情页 HTML 里抓  ev:{d:"<base64>",k:41}
//   2. 解密：base64 → 每字节 -k → JSON {"videoUrl":"/api/hls/<id>"}
//   3. GET /api/hls/<id>  带 Cookie: ob=1 且【不跟随跳转】→ 302 → 签名地址 …/index.png?…&auth=…
//   4. GET 签名地址 → PNG，里面的自定义块 roUd 就是播放列表
//        flag&1 → zlib 压缩（需 inflate）；否则原始字节
//   5. 分片同样是 PNG 包裹，flag=0 → 裸 MPEG-TS，用 Range 精确切片后流式代理给播放器

import { Spider, openWeb } from "catvod";

const BASE = "https://rou.video";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// ---------------------------------------------------------------- 工具

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

// ---------------------------------------------------------------- 站点解析

function headers(ref) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ref || BASE + "/",
  };
}

// 列表页 SSR 数据：以 name 为锚点，向前找最近的 id（避开 sources 里的嵌套 id）
function parseList(html) {
  const out = [];
  const seen = {};
  const re = /name:"([^"]*)"[\s\S]{0,2000}?coverImageUrl:"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const before = html.substring(Math.max(0, m.index - 2500), m.index);
    const ids = before.match(/id:"(c[a-z0-9]{20,})"/g);
    if (!ids || !ids.length) continue;
    const id = ids[ids.length - 1].replace(/^id:"|"$/g, "");
    if (seen[id]) continue;
    seen[id] = 1;
    out.push({
      vod_id: id,
      vod_name: decodeEntities(m[1]),
      vod_pic: decodeEntities(m[2]),
      vod_remarks: "",
    });
  }
  return out;
}

function parseDetail(html, id) {
  const key = '{id:"' + id + '"';
  const at = html.indexOf(key);
  const block = at >= 0 ? html.substring(at, at + 4000) : html;

  let title = "";
  let pic = "";
  let desc = "";
  let duration = 0;
  const tags = [];

  const nm = block.match(/name:"([^"]*)"/);
  if (nm) title = decodeEntities(nm[1]);
  const cv = block.match(/coverImageUrl:"([^"]+)"/);
  if (cv) pic = decodeEntities(cv[1]);
  const ds = block.match(/description:"([^"]*)"/);
  if (ds) desc = decodeEntities(ds[1]);
  const du = block.match(/duration:([0-9.]+)/);
  if (du) duration = Math.round(Number(du[1]) / 60);

  const tg = block.match(/tags:\$R\[\d+\]=\[([^\]]*)\]/);
  if (tg) {
    for (const it of tg[1].split(",")) {
      const s = it.replace(/^"|"$/g, "").trim();
      if (s && tags.indexOf(s) < 0) tags.push(decodeEntities(s));
    }
  }

  return { title: title || id, pic, desc, duration, tags };
}

// ---------------------------------------------------------------- 主体

export default class RouVideo extends Spider {
  init(extend) {
    this.sess = {};
    this.log("rou.video ready");
  }

  async homeContent(filter) {
    const classes = [
      { type_id: "latest", type_name: "最新" },
      { type_id: "web", type_name: "网页" },
    ];
    return { class: classes };
  }

  async categoryContent(tid, pg, filter, extend) {
    if (tid === "web") {
      try {
        openWeb({ url: BASE + "/v" });
      } catch (e) {
        this.log("openWeb failed: " + e);
      }
      return this.page([], 1, 30, 0);
    }

    const p = Number(pg) || 1;
    const url = BASE + "/v?order=createdAt&page=" + p;
    const r = await this.net.req(url, { headers: headers() });
    if (!r || r.code !== 200) return this.page([], p, 30, 0);

    const cards = parseList(r.content);
    if (cards.length === 0) return this.page([], p, 30, (p - 1) * 30);
    return this.page(cards, p, 30, (p + 1) * 30);
  }

  async detailContent(ids) {
    const list = [];
    for (const id of ids) {
      const vid = String(id).replace(/^.*\/v\//, "").replace(/[?#].*$/, "");
      const pageUrl = BASE + "/v/" + vid;
      let info = { title: vid, pic: "", desc: "", duration: 0, tags: [] };
      try {
        const r = await this.net.req(pageUrl, { headers: headers() });
        if (r && r.code === 200) info = parseDetail(r.content, vid);
      } catch (e) {
        this.log("detail failed: " + e);
      }

      const parts = [];
      if (info.duration) parts.push("时长: " + info.duration + " 分钟");
      if (info.tags.length) parts.push("标签: " + info.tags.join(" / "));
      const content = [parts.join(" | "), info.desc].filter(Boolean).join("\n");

      list.push({
        vod_id: vid,
        vod_name: info.title,
        vod_pic: info.pic,
        vod_content: content,
        vod_remarks: info.duration ? info.duration + " 分钟" : "",
        vod_play_from: "rou.video",
        vod_play_url: "正片$" + vid,
      });
    }
    return { list: list };
  }

  // 读流全部字节
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

  async playerContent(flag, id, vipFlags) {
    const vid = String(id).replace(/^.*\/v\//, "").replace(/[?#].*$/, "");
    const pageUrl = BASE + "/v/" + vid;

    // 1. 详情页 → ev
    const r = await this.net.req(pageUrl, { headers: headers() });
    if (!r || r.code !== 200) throw new Error("无法打开详情页");
    const m = r.content.match(/ev:(?:\$\w+\[\d+\]=)?\{d:"([^"]+)",k:(-?\d+)\}/);
    if (!m) throw new Error("找不到播放数据");

    // 2. 解密
    const raw = b64ToBytes(m[1]);
    const key = Number(m[2]);
    let plain = "";
    for (let i = 0; i < raw.length; i++) plain += String.fromCharCode((raw[i] - key) & 0xff);
    const vu = plain.match(/"videoUrl":"([^"]+)"/);
    if (!vu) throw new Error("解密失败");
    const videoPath = vu[1];

    // 3. 拿 302 签名地址（不跟随跳转，必须带 Cookie: ob=1）
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
    if (!loc && r2 && r2.code && r2.code >= 300 && r2.code < 400) loc = "";
    if (!loc) throw new Error("没有拿到签名地址（状态 " + (r2 ? r2.code : "?") + "）");
    if (loc.indexOf("http") !== 0) loc = BASE + loc;

    // 4. 取 PNG 并解出播放列表
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

    // 5. 重写分片地址，走本地代理
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

  // 本地代理：m=1 返回播放列表；否则返回分片（剥掉 PNG 壳）
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

    // 先取头部，算出 roUd 数据偏移
    const headStream = await this.net.openStream(remote, {
      headers: Object.assign({}, baseHeaders, { "Range": "bytes=0-4095" }),
    });
    const head = await this.readAll(headStream);
    const chunk = readRoUd(head);
    if (!chunk) return [404, "text/plain", "no roUd"];
    const start = chunk.offset + 9;
    const length = chunk.data.length;
    const end = start + length - 1;

    // 再按精确范围流式取 TS
    const s2 = await this.net.stream(remote, {
      headers: Object.assign({}, baseHeaders, { "Range": "bytes=" + start + "-" + end }),
    });
    if (!s2 || !s2.stream) {
      try {
        s2.close && s2.close();
      } catch (e) {}
      return [404, "text/plain", "stream failed"];
    }
    return [200, "video/mp2t", s2.stream];
  }

  async searchContent(key, quick, pg = "1") {
    // 站点搜索是纯客户端渲染，SSR 拿不到结果
    return this.page([], Number(pg) || 1, 30, 0);
  }
}
