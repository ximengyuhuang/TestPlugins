package com.cosplaytele

import android.content.Context
import android.util.Base64
import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.plugins.CloudstreamPlugin
import com.lagradost.cloudstream3.plugins.Plugin
import com.lagradost.cloudstream3.utils.*
import org.jsoup.nodes.Element
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

class CosplayTeleProvider : MainAPI() {
    override var mainUrl = "https://cosplaytele.com"
    override var name = "CosplayTele"

    override val hasMainPage = true
    override val hasQuickSearch = false
    override val supportedTypes = setOf(TvType.Movie)
    override var lang = "en"

    override val mainPage = mainPageOf(
        "category/video-cosplayyy/" to "最新视频",
    )

    private fun Element.toSearchResponse(): SearchResponse? {
        val anchor = selectFirst(".post-title a")
            ?: selectFirst(".box-image a")
            ?: selectFirst("a[href]")
            ?: return null

        val href = fixUrlNull(anchor.attr("href"))?.takeIf { it.contains("cosplaytele.com") }
            ?: return null

        val title = selectFirst(".post-title")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: anchor.attr("aria-label").trim()
        if (title.isBlank()) return null

        val poster = selectFirst("img")?.attr("src")

        return newMovieSearchResponse(title, href, TvType.Movie) {
            this.posterUrl = fixUrlNull(poster)
        }
    }

    override suspend fun search(query: String): List<SearchResponse> {
        return runCatching {
            app.get("$mainUrl/", params = mapOf("s" to query)).document
                .select("div.post-item")
                .mapNotNull { it.toSearchResponse() }
                .distinctBy { it.url }
        }.getOrDefault(emptyList())
    }

    override suspend fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val suffix = if (page <= 1) "" else "page/$page/"
        val items = runCatching {
            app.get("$mainUrl/${request.data}$suffix").document
                .select("div.post-item")
                .mapNotNull { it.toSearchResponse() }
                .distinctBy { it.url }
        }.getOrDefault(emptyList())

        return newHomePageResponse(
            HomePageList(request.name, items, true),
            hasNext = items.isNotEmpty()
        )
    }

    override suspend fun load(url: String): LoadResponse {
        val doc = app.get(url).document

        val title = doc.selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: throw ErrorLoadingException("No title at $url")

        val poster = doc.selectFirst(".entry-content img")?.attr("src")
            ?: doc.selectFirst("img.wp-post-image")?.attr("src")

        val body = doc.selectFirst(".entry-content")?.text()?.trim()
        val embedCount = doc.select("iframe[src*='cossora.stream/embed/']").size

        val plot = body?.takeIf { it.isNotBlank() }
            ?: if (embedCount > 0) "含 $embedCount 个视频" else "该帖子没有视频（图集帖）"

        return newMovieLoadResponse(title, url, TvType.Movie, url) {
            this.posterUrl = fixUrlNull(poster)
            this.plot = plot
        }
    }

    override suspend fun loadLinks(
        data: String,
        isCasting: Boolean,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit,
    ): Boolean {
        val doc = app.get(data).document

        val embeds = doc.select("iframe[src*='cossora.stream/embed/']")
            .map { it.attr("src").trim() }
            .filter { it.isNotBlank() }
            .distinct()

        if (embeds.isEmpty()) return false

        var found = false
        embeds.forEachIndexed { index, embed ->
            val page = runCatching {
                app.get(embed, headers = mapOf("Referer" to data)).text
            }.getOrNull() ?: return@forEachIndexed

            val stream = extractM3u8(page) ?: return@forEachIndexed

            callback.invoke(
                newExtractorLink(name, "$name ${index + 1}", stream, ExtractorLinkType.M3U8) {
                    this.referer = "https://cossora.stream/"
                    this.quality = Qualities.Unknown.value
                }
            )
            found = true
        }

        return found
    }

    /** 从 embed 页里取出并解密 m3u8 地址（不用正则/转义，避免粘贴出错） */
    private fun extractM3u8(html: String): String? {
        val iVideo = html.indexOf("videoURL")
        if (iVideo < 0) return null

        val q1 = html.indexOf("'", iVideo)
        if (q1 < 0) return null
        val q2 = html.indexOf("'", q1 + 1)
        if (q2 < 0) return null
        val cipherText = html.substring(q1 + 1, q2)

        val iCall = html.indexOf("decryptLink(videoURL", iVideo)
        if (iCall < 0) return null
        val k1 = html.indexOf("'", iCall)
        if (k1 < 0) return null
        val k2 = html.indexOf("'", k1 + 1)
        if (k2 < 0) return null
        val key = html.substring(k1 + 1, k2)
        if (key.length != 32) return null

        val plain = aesDecrypt(cipherText, key) ?: return null

        val start = plain.indexOf("https://")
        if (start < 0) return null
        val rest = plain.substring(start)
        val m3u8 = rest.indexOf(".m3u8")
        if (m3u8 < 0) return null

        var end = m3u8 + 5
        val allowed = "-._~:/?#[]@!$&()*+,;=%"
        while (end < rest.length && (rest[end].isLetterOrDigit() || allowed.indexOf(rest[end]) >= 0)) {
            end++
        }
        return rest.substring(0, end)
    }

    private fun aesDecrypt(cipherTextB64: String, key: String): String? {
        return try {
            val cipher = Cipher.getInstance("AES/CBC/NoPadding
