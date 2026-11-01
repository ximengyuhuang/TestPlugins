package com.nsfwr34

import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.utils.*
import org.jsoup.nodes.Element

/**
 * nsfwr34.com —— WordPress + KVS 播放器
 *
 * 站点结构（已实测）：
 *  - 列表/搜索/相关推荐 都是 <article data-embed-url="..."> 卡片
 *  - 详情页 .post-body.single-body 内含 h1 / .post-content / .post-meta__date
 *  - 播放器是 <video-js data-settings="{...sources...}">，m3u8 明文写在属性里
 *  - m3u8 为 master playlist（480p / 1080p / 2160p），CDN 不校验 Referer
 */
class NSFWR34Provider : MainAPI() {
    override var mainUrl = "https://nsfwr34.com"
    override var name = "NSFWR34"

    override val hasMainPage = true
    override val hasQuickSearch = false
    override val supportedTypes = setOf(TvType.Movie)
    override var lang = "en"

    // data 是分类路径（以 / 结尾），配合 page/N/ 做无限滚动
    override val mainPage = mainPageOf(
        "video/" to "Latest",
        "categories/4k/" to "4K",
        "categories/3d-porn/" to "3D Rule 34",
        "categories/2d-rule-34/" to "2D Rule 34",
        "categories/vertical-videos/" to "Vertical",
    )

    companion object {
        // 同时兼容 https:// 和 JSON 转义后的 https:\/\/ 两种写法
        private val M3U8_REGEX = Regex("""https?:\\?/\\?/[^"'\s]+?\.m3u8""")
    }

    // ---------------------------------------------------------------- 搜索

    override suspend fun search(query: String): List<SearchResponse> {
        return runCatching {
            app.get("$mainUrl/", params = mapOf("s" to query)).document
                .select("article[data-embed-url]")
                .mapNotNull { it.toSearchResponse() }
                .distinctBy { it.url }
        }.getOrDefault(emptyList())
    }

    // ---------------------------------------------------------------- 首页

    override suspend fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val suffix = if (page <= 1) "" else "page/$page/"
        // 越界页站点直接返回 404，捕获后当作「没有下一页」
        val items = runCatching {
            app.get("$mainUrl/${request.data}$suffix").document
                .select("article[data-embed-url]")
                .mapNotNull { it.toSearchResponse() }
                .distinctBy { it.url }
        }.getOrDefault(emptyList())

        return newHomePageResponse(request.name, items, hasNext = items.isNotEmpty())
    }

    // ---------------------------------------------------------------- 详情

    override suspend fun load(url: String): LoadResponse {
        val doc = app.get(url).document
        val root = doc.selectFirst(".post-body.single-body") ?: doc

        val title = root.selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: doc.selectFirst("meta[property='og:title']")?.attr("content")?.trim()
            ?: throw ErrorLoadingException("No title at $url")

        val posterUrl = doc.selectFirst("meta[property='og:image']")?.attr("content")
            ?: root.selectFirst("img")?.attr("src")

        val plot = root.selectFirst(".post-content")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: doc.selectFirst("meta[property='og:description']")?.attr("content")

        val year = root.selectFirst(".post-meta__date time")?.attr("datetime")
            ?.take(4)?.toIntOrNull()

        // 标签既可能挂在 video_tag 下，也可能是 categories
        val tags = (root.select("a[href*='/video_tag/']") + root.select("a[href*='/categories/']"))
            .map { it.text().trim() }
            .filter { it.isNotBlank() }
            .distinct()

        val duration = doc.selectFirst("script[type='application/ld+json']")?.data()
            ?.let { ld ->
                Regex("\"duration\"\\s*:\\s*\"([^\"]+)\"").find(ld)?.groupValues?.get(1)
            }
            ?.let { formatIsoDuration(it) }

        val recommendations = doc.select("article[data-embed-url]")
            .mapNotNull { it.toSearchResponse() }
            .filter { it.url != url }
            .distinctBy { it.url }

        // 播放器在 /embed/ 子页（体积约 23KB，比详情页 250KB 轻得多）
        val embedUrl = url.trimEnd('/') + "/embed/"

        return newMovieLoadResponse(title, url, TvType.Movie, embedUrl) {
            this.posterUrl = fixUrlNull(posterUrl)
            this.plot = plot
            this.year = year
            this.tags = tags
            this.recommendations = recommendations
            addDuration(duration)
        }
    }

    // ---------------------------------------------------------------- 取流

    override suspend fun loadLinks(
        data: String,
        isCasting: Boolean,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit,
    ): Boolean {
        // 容错：data 可能是 /embed/ 地址，也可能是详情页地址
        val embedUrl = when {
            data.contains("/embed/") -> data
            data.contains("/video/") -> data.trimEnd('/') + "/embed/"
            else -> data
        }

        val doc = app.get(embedUrl).document
        // m3u8 在 <video-js data-settings> 的 JSON 里；取不到就退回整页 HTML 再扫一遍
        val haystack = doc.selectFirst("video-js")
            ?.attr("data-settings")
            ?.takeIf { it.isNotBlank() }
            ?: doc.html()

        val urls = M3U8_REGEX.findAll(haystack)
            .map { it.value.replace("\\/", "/") }
            .distinct()
            .toList()

        if (urls.isEmpty()) return false

        urls.forEach { addM3u8(it, callback) }
        return true
    }

    private suspend fun addM3u8(masterUrl: String, callback: (ExtractorLink) -> Unit) {
        // master playlist 里通常有 480p/1080p/2160p 三档，拆成独立链接让用户能选
        val variants = runCatching {
            parseVariants(masterUrl, app.get(masterUrl).text)
        }.getOrNull().orEmpty()

        if (variants.isEmpty()) {
            callback.invoke(
                newExtractorLink(name, name, masterUrl, ExtractorLinkType.M3U8) {
                    this.referer = "$mainUrl/"
                    this.quality = Qualities.Unknown.value
                }
            )
            return
        }

        variants.forEach { (quality, link) ->
            callback.invoke(
                newExtractorLink(name, "$name ${quality}p", link, ExtractorLinkType.M3U8) {
                    this.referer = "$mainUrl/"
                    this.quality = quality
                }
            )
        }
    }

    private fun parseVariants(masterUrl: String, body: String): List<Pair<Int, String>> {
        val lines = body.lines()
        val base = masterUrl.substringBeforeLast('/', "")
        val out = mutableListOf<Pair<Int, String>>()

        lines.forEachIndexed { index, line ->
            if (!line.startsWith("#EXT-X-STREAM-INF")) return@forEachIndexed
            val height = Regex("""RESOLUTION=\d+x(\d+)""")
                .find(line)?.groupValues?.get(1)?.toIntOrNull() ?: return@forEachIndexed
            val next = lines.getOrNull(index + 1)?.trim().orEmpty()
            if (next.isBlank() || next.startsWith("#")) return@forEachIndexed
            out += height to (if (next.startsWith("http")) next else "$base/$next")
        }

        return out.sortedByDescending { it.first }
    }

    // ---------------------------------------------------------------- 工具

    /** 卡片 -> SearchResponse；首页、搜索、相关推荐三处复用 */
    private fun Element.toSearchResponse(): SearchResponse? {
        val anchor = selectFirst("a.post-permalink")
            ?: selectFirst("a[href*='/video/']")
            ?: return null

        val href = fixUrlNull(anchor.attr("href"))?.takeIf { it.contains("/video/") } ?: return null

        val title = anchor.attr("title").trim().ifBlank {
            selectFirst(".post-meta__title")?.text()?.trim().orEmpty()
        }
        if (title.isBlank()) return null

        // 列表页给的是缩略图 src，卡片属性里还有 CDN 上的高清预览图
        val posterUrl = selectFirst("img")?.attr("src")?.takeIf { it.isNotBlank() }
            ?: attr("data-thumbnail-image-2").takeIf { it.isNotBlank() }

        return newMovieSearchResponse(title, href, TvType.Movie) {
            this.posterUrl = fixUrlNull(posterUrl)
        }
    }

    /** PT1M21S -> 1m 21s */
    private fun formatIsoDuration(iso: String): String? {
        val m = Regex("""P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?""").matchEntire(iso)
            ?: return null
        val (_, h, min, s) = m.destructured
        val hours = h.toIntOrNull() ?: 0
        val minutes = min.toIntOrNull() ?: 0
        val seconds = s.toIntOrNull() ?: 0

        return when {
            hours > 0 -> "${hours}h ${minutes}m"
            minutes > 0 -> if (seconds > 0) "${minutes}m ${seconds}s" else "${minutes}m"
            seconds > 0 -> "${seconds}s"
            else -> null
        }
    }
}
