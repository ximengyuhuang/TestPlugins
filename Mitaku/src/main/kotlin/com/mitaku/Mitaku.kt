package com.mitaku

import android.util.Base64
import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.plugins.CloudstreamPlugin
import com.lagradost.cloudstream3.plugins.Plugin
import com.lagradost.cloudstream3.utils.*
import org.jsoup.nodes.Element
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * mitaku.net —— WordPress 图集/视频站，视频帖集中在 /category/online-video/。
 *
 * 取流链路（逆向后实测可用）：
 *   帖子页 iframe ──▶ bysesayeveum.com/e/<slug>
 *   真实 API：https://n1mwq.org/api/videos/<slug>/embed/
 *     1) POST captcha        → pow_nonce / pow_difficulty / pow_token
 *     2) 本地解 PoW          → solution（自定义哈希，见 powHash）
 *     3) POST captcha/verify → token
 *     4) POST playback(带 x-captcha-token, body {"fingerprint":{}})
 *        → AES-256-GCM 加密的 payload + key_parts + version
 *   密钥：key = b64url(key_parts[v-1]) + b64url(key_parts[31-v-1])   (v = version)
 */
class MitakuProvider : MainAPI() {
    override var mainUrl = "https://mitaku.net"
    override var name = "Mitaku"

    override val hasMainPage = true
    override val hasQuickSearch = false
    override val supportedTypes = setOf(TvType.Movie)
    override var lang = "ja"

    private val apiBase = "https://n1mwq.org"

    override val mainPage = mainPageOf(
        "category/online-video/" to "视频",
        "category/ero-cosplay/" to "Cosplay",
        "category/nude/" to "Nude",
    )

    // ---------------------------------------------------------------- 列表

    private fun Element.toSearchResponse(): SearchResponse? {
        val anchor = selectFirst(".entry-title a") ?: selectFirst("a[href]") ?: return null
        val href = fixUrlNull(anchor.attr("href"))?.takeIf { it.contains("mitaku.net") } ?: return null

        val title = selectFirst(".entry-title")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: anchor.attr("title").trim()
        if (title.isBlank()) return null

        val poster = selectFirst(".featured-image img")?.attr("src")
            ?: selectFirst("img[src]")?.attr("src")

        return newMovieSearchResponse(title, href, TvType.Movie) {
            this.posterUrl = fixUrlNull(poster)
        }
    }

    override suspend fun search(query: String): List<SearchResponse> {
        return runCatching {
            app.get("$mainUrl/", params = mapOf("s" to query)).document
                .select("article")
                .mapNotNull { it.toSearchResponse() }
                .distinctBy { it.url }
        }.getOrDefault(emptyList())
    }

    override suspend fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val suffix = if (page <= 1) "" else "page/$page/"
        val items = runCatching {
            app.get("$mainUrl/${request.data}$suffix").document
                .select("article")
                .mapNotNull { it.toSearchResponse() }
                .distinctBy { it.url }
        }.getOrDefault(emptyList())

        return newHomePageResponse(
            HomePageList(request.name, items, true),
            hasNext = items.isNotEmpty()
        )
    }

    // ---------------------------------------------------------------- 详情

    override suspend fun load(url: String): LoadResponse {
        val doc = app.get(url).document

        val title = doc.selectFirst(".entry-title")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: doc.selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: throw ErrorLoadingException("No title at $url")

        val poster = doc.selectFirst(".featured-image img")?.attr("src")
            ?: doc.selectFirst(".entry-content img")?.attr("src")

        val plot = doc.selectFirst(".entry-content")?.text()?.trim()?.takeIf { it.isNotBlank() }
        val hasVideo = doc.select("iframe[src*='/e/']").isNotEmpty()

        return newMovieLoadResponse(title, url, TvType.Movie, url) {
            this.posterUrl = fixUrlNull(poster)
            this.plot = plot ?: if (hasVideo) "含视频" else "该帖子没有视频（图集帖）"
        }
    }

    // ---------------------------------------------------------------- 取流

    override suspend fun loadLinks(
        data: String,
        isCasting: Boolean,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit,
    ): Boolean {
        val doc = app.get(data).document
        val iframe = doc.selectFirst("iframe[src*='/e/']")?.attr("src") ?: return false
        val slug = iframe.trimEnd('/').substringAfterLast('/')
        if (slug.isBlank()) return false

        val streams = resolveStreams(slug)
        if (streams.isEmpty()) return false

        streams.distinct().forEachIndexed { i, link ->
            callback.invoke(
                newExtractorLink(name, "$name ${i + 1}", link, ExtractorLinkType.M3U8) {
                    this.referer = "$apiBase/"
                    this.quality = Qualities.Unknown.value
                }
            )
        }
        return true
    }

    private suspend fun resolveStreams(slug: String): List<String> {
        val headers = mapOf(
            "Accept" to "*/*",
            "Origin" to apiBase,
            "Referer" to "$apiBase/75iia/$slug",
            "X-Embed-Parent" to "https://bysesayeveum.com/e/$slug",
        )
        val embedApi = "$apiBase/api/videos/$slug/embed"

        val captcha = runCatching {
            app.post("$embedApi/captcha", headers = headers, json = emptyMap<String, Any>()).text
        }.getOrNull() ?: return emptyList()

        val nonce = Regex("\"pow_nonce\"\\s*:\\s*\"([^\"]+)\"").find(captcha)?.groupValues?.get(1)
            ?: return emptyList()
        val difficulty = Regex("\"pow_difficulty\"\\s*:\\s*(\\d+)").find(captcha)
            ?.groupValues?.get(1)?.toIntOrNull() ?: 16
        val powToken = Regex("\"pow_token\"\\s*:\\s*\"([^\"]+)\"").find(captcha)?.groupValues?.get(1)
            ?: return emptyList()

        val solution = solvePow(nonce, difficulty) ?: return emptyList()

        val verify = runCatching {
            app.post(
                "$embedApi/captcha/verify",
                headers = headers,
                json = mapOf("pow_token" to powToken, "solution" to solution)
            ).text
        }.getOrNull() ?: return emptyList()

        val token = Regex("\"token\"\\s*:\\s*\"([^\"]+)\"").find(verify)?.groupValues?.get(1)
            ?: return emptyList()

        val playback = runCatching {
            app.post(
                "$embedApi/playback",
                headers = headers + mapOf("x-captcha-token" to token),
                json = mapOf("fingerprint" to emptyMap<String, Any>())
            ).text
        }.getOrNull() ?: return emptyList()

        val ivStr = Regex("\"iv\"\\s*:\\s*\"([^\"]+)\"").find(playback)?.groupValues?.get(1)
            ?: return emptyList()
        val payloadStr = Regex("\"payload\"\\s*:\\s*\"([^\"]+)\"").find(playback)?.groupValues?.get(1)
            ?: return emptyList()
        val version = Regex("\"version\"\\s*:\\s*\"?(\\d+)\"?").find(playback)
            ?.groupValues?.get(1)?.toIntOrNull() ?: return emptyList()

        val partsBlock = Regex("\"key_parts\"\\s*:\\s*\\[([^\\]]*)\\]").find(playback)
            ?.groupValues?.get(1) ?: return emptyList()
        val parts = Regex("\"([^\"]+)\"").findAll(partsBlock).map { it.groupValues[1] }.toList()

        val i1 = version - 1
        val i2 = 31 - version - 1
        if (i1 !in parts.indices || i2 !in parts.indices) return emptyList()

        val key = b64url(parts[i1]) + b64url(parts[i2])
        if (key.size != 32) return emptyList()

        val plain = aesGcmDecrypt(key, b64url(ivStr), b64url(payloadStr)) ?: return emptyList()

        val normalized = plain.replace("\\u0026", "&").replace("\\/", "/")
        return normalized.split('"')
            .filter { it.startsWith("http") && it.contains(".m3u8") }
            .distinct()
    }

    // ---------------------------------------------------------------- PoW

    /** 返回满足 difficulty 位前导零的最小计数器 */
    private fun solvePow(nonce: String, difficulty: Int): String? {
        val prefix = "$nonce:"
        var s = 0
        while (s < 5_000_000) {
            if (leadingZeroBits(powHash((prefix + s).toByteArray(Charsets.ISO_8859_1))) >= difficulty) {
                return s.toString()
            }
            s++
        }
        return null
    }

    private fun leadingZeroBits(words: IntArray): Int {
        var bits = 0
        for (w in words) {
            if (w == 0) {
                bits += 32
                continue
            }
            return bits + Integer.numberOfLeadingZeros(w)
        }
        return bits
    }

    private fun rotl(x: Int, n: Int): Int = (x shl n) or (x ushr (32 - n))

    private fun quarter(t: IntArray) {
        t[0] += t[1]
        t[3] = rotl(t[3] xor t[0], 16)
        t[2] += t[3]
        t[1] = rotl(t[1] xor t[2], 12)
        t[0] += t[1]
        t[3] = rotl(t[3] xor t[0], 8)
        t[2] += t[3]
        t[1] = rotl(t[1] xor t[2], 7)
    }

    /** 站点自定义哈希（512 字状态 + 2 轮扩散 + 8 字输出） */
    private fun powHash(input: ByteArray): IntArray {
        val e = intArrayOf(
            1779033703,
            3144134277L.toInt(),
            1013904242,
            2773480762L.toInt()
        )
        for (b in input) {
            e[0] += (b.toInt() and 0xFF)
            e[0] = rotl(e[0], 7)
            quarter(e)
        }
        repeat(8) { quarter(e) }

        val r = IntArray(512)
        for (i in 0 until 512) {
            quarter(e)
            r[i] = e[0] xor e[2]
        }

        val lr = 2654435761L.toInt()
        val hr = 2246822519L.toInt()

        for (round in 0 until 2) {
            for (s in 0 until 512) {
                val a = r[s] and 511
                var c = r[s] + r[a]
                c = rotl(c, 13)
                c = c xor (r[(s + 1) and 511] * lr)
                r[s] = c
                e[0] = e[0] xor c
                quarter(e)
            }
        }

        val out = IntArray(8)
        for (i in 0 until 8) {
            quarter(e)
            var s = e[0]
            val base = i * 64
            for (c in 0 until 64) {
                val d = r[base + c]
                s += d
                s = rotl(s, 5)
                s = s xor (d * hr)
            }
            out[i] = s xor e[2]
        }
        return out
    }

    // ---------------------------------------------------------------- 工具

    private fun b64url(s: String): ByteArray {
        val t = s.replace('-', '+').replace('_', '/')
        val pad = (4 - t.length % 4) % 4
        return Base64.decode(t + "=".repeat(pad), Base64.DEFAULT)
    }

    private fun aesGcmDecrypt(key: ByteArray, iv: ByteArray, payload: ByteArray): String? {
        return try {
            if (payload.size < 17) return null
            val ct = payload.copyOfRange(0, payload.size - 16)
            val tag = payload.copyOfRange(payload.size - 16, payload.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(128, iv)
            )
            cipher.update(ct)
            String(cipher.doFinal(tag), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }
}

@CloudstreamPlugin
class MitakuPlugin : Plugin() {
    override fun load(context: android.content.Context) {
        registerMainAPI(MitakuProvider())
    }
}
