package com.rule34video

import android.net.Uri
import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.plugins.CloudstreamPlugin
import com.lagradost.cloudstream3.plugins.Plugin
import com.lagradost.cloudstream3.utils.ExtractorLink
import com.lagradost.cloudstream3.utils.ExtractorLinkType
import com.lagradost.cloudstream3.utils.Qualities
import com.lagradost.cloudstream3.utils.newExtractorLink
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/**
 * rule34video.com —— KVS 架构
 *
 * 列表：div.item.thumb → a.th[href][title] + img[src]
 * 详情：h1 标题；播放地址在页内 var flashvars = {...} 里：
 *        video_url / video_alt_url / video_alt_url2 / video_alt_url3
 *        + *_text 给出 360p/480p/720p/1080p
 * 直链是 MP4，带 v-acctoken（绑 IP，随页面实时生成），实测可直接播。
 */
class Rule34VideoProvider : MainAPI() {
    override var mainUrl = "https://rule34video.com"
    override var name = "Rule34Video"

    override val hasMainPage = true
    override val hasQuickSearch = false
    override val supportedTypes = setOf(TvType.Movie, TvType.TvSeries, TvType.Anime)
    override var lang = "en"

    private val webHeaders = mapOf(
        "User-Agent" to "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept" to "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language" to "en-US,en;q=0.9",
    )

    // ---------------------------------------------------------------- 首页行

    override val mainPage = mainPageOf(
        "latest-updates/" to "最新",
        "latest-updates/?sort_by=video_viewed" to "最热",
        "latest-updates/?sort_by=rating" to "评分最高",
        "latest-updates/?sort_by=duration" to "时长最长",
        "@categories" to "分类",
        "@tags" to "标签",
    )

    // ---------------------------------------------------------------- 解析

    private fun Element.toCard(): SearchResponse? {
        val a = selectFirst("a.th[href]") ?: selectFirst("a[href*=/video/]") ?: return null
        val href = fixUrlNull(a.attr("href")) ?: return null
        if (!href.contains("/video/")) return null

        val title = a.attr("title").trim().ifBlank {
            selectFirst("img")?.attr("alt")?.trim() ?: ""
        }
        if (title.isBlank()) return null

        val poster = listOfNotNull(
            selectFirst("img[data-original]")?.attr("data-original"),
            selectFirst("img[data-src]")?.attr("data-src"),
            selectFirst("img")?.attr("src")
        ).firstOrNull { it.startsWith("http") }

        return newMovieSearchResponse(title, href, TvType.Movie) {
            this.posterUrl = fixUrlNull(poster)
        }
    }

    private fun Document.cards(): List<SearchResponse> =
        select("div.item.thumb").mapNotNull { it.toCard() }.distinctBy { it.url }

    /** 拼分页：KVS 用路径分页 /2/，查询串要保留在后面 */
    private fun pageUrl(data: String, page: Int): String {
        val q = data.indexOf('?')
        val path = (if (q >= 0) data.substring(0, q) else data).trimStart('/')
        val query = if (q >= 0) data.substring(q) else ""
        val withSlash = if (path.endsWith("/") || page <= 1) path else "$path/"
        return if (page <= 1) "$mainUrl/$withSlash$query"
        else "$mainUrl/${withSlash}$page/$query"
    }

    private suspend fun listCards(url: String): List<SearchResponse> = runCatching {
        app.get(url, headers = webHeaders).document.cards()
    }.getOrDefault(emptyList())

    // ---------------------------------------------------------------- 索引行

    /** /categories —— 带封面和数量 */
    private suspend fun categoryEntries(pages: Int): List<SearchResponse> {
        val out = LinkedHashMap<String, SearchResponse>()
        for (p in 1..pages) {
            val url = if (p == 1) "$mainUrl/categories/" else "$mainUrl/categories/$p/"
            val doc = runCatching { app.get(url, headers = webHeaders).document }.getOrNull() ?: continue
            var added = 0
            // 页面上有两个区块：顶部热门用 a.item，字母排序用 a.th + div.thumb_title
            doc.select("a[href*=/categories/]").forEach { a ->
                val href = fixUrlNull(a.attr("href")) ?: return@forEach
                if (!Regex("/categories/[^/]+/$").containsMatchIn(href)) return@forEach
                if (out.containsKey(href)) return@forEach

                val name = a.selectFirst("div.thumb_title")?.text()?.trim()?.takeIf { it.isNotBlank() }
                    ?: a.selectFirst("div.name")?.ownText()?.trim()?.takeIf { it.isNotBlank() }
                    ?: a.selectFirst("img")?.attr("alt")?.trim()?.takeIf { it.isNotBlank() }
                    ?: return@forEach

                val count = a.selectFirst("div.count span")?.text()?.trim() ?: ""
                val poster = a.selectFirst("img")?.attr("src")?.takeIf { it.startsWith("http") }
                val shown = if (count.isNotBlank()) "$name ($count)" else name

                out[href] = newMovieSearchResponse(shown, href, TvType.Movie) {
                    this.posterUrl = fixUrlNull(poster)
                }
                added++
            }
            if (added == 0) break
        }
        return out.values.toList()
    }

    /** /tags —— 纯文字按钮 */
    private suspend fun tagEntries(pages: Int): List<SearchResponse> {
        val out = LinkedHashMap<String, SearchResponse>()
        for (p in 1..pages) {
            val url = if (p == 1) "$mainUrl/tags/" else "$mainUrl/tags/$p/"
            val doc = runCatching { app.get(url, headers = webHeaders).document }.getOrNull() ?: continue
            doc.select("a.button[href]").forEach { a ->
                val href = fixUrlNull(a.attr("href")) ?: return@forEach
                if (!href.contains("/tags/")) return@forEach
                val nm = a.text().trim()
                if (nm.isBlank() || out.containsKey(href)) return@forEach
                out[href] = newMovieSearchResponse(nm, href, TvType.Movie)
            }
        }
        return out.values.toList()
    }

    // ---------------------------------------------------------------- 列表

    override suspend fun search(query: String): List<SearchResponse> =
        listCards("$mainUrl/search/${Uri.encode(query)}/")

    override suspend fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val data = request.data

        if (data.startsWith("@")) {
            val items = when (data) {
                "@categories" -> categoryEntries(5)
                "@tags" -> tagEntries(5)
                else -> emptyList()
            }
            return newHomePageResponse(
                HomePageList(request.name, items, true),
                hasNext = false
            )
        }

        val cards = listCards(pageUrl(data, page))
        return newHomePageResponse(
            HomePageList(request.name, cards, true),
            hasNext = cards.isNotEmpty()
        )
    }

    // ---------------------------------------------------------------- 详情

    private fun isVideoPage(url: String) = url.contains("/video/")

    private fun flashvars(html: String): String =
        Regex("var\\s+flashvars\\s*=\\s*\\{(.*?)\\};", RegexOption.DOT_MATCHES_ALL)
            .find(html)?.groupValues?.get(1) ?: ""

    private fun pick(fv: String, key: String): String? =
        Regex("$key\\s*:\\s*'([^']*)'").find(fv)?.groupValues?.get(1)?.takeIf { it.isNotBlank() }

    override suspend fun load(url: String): LoadResponse {
        val html = app.get(url, headers = webHeaders).text
        val doc = org.jsoup.Jsoup.parse(html)

        if (isVideoPage(url)) {
            val title = doc.selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotBlank() }
                ?: throw ErrorLoadingException("No title at $url")

            val fv = flashvars(html)
            val poster = pick(fv, "preview_url")
                ?: doc.selectFirst("meta[property=og:image]")?.attr("content")
                ?: doc.selectFirst("img")?.attr("src")

            val cat = pick(fv, "video_categories").orEmpty()
            val tags = pick(fv, "video_tags").orEmpty()
            val duration = pick(fv, "video_duration")

            val plot = buildString {
                if (cat.isNotBlank()) append(cat)
                if (tags.isNotBlank()) { if (isNotEmpty()) append("\n"); append(tags) }
            }.ifBlank { null }

            return newMovieLoadResponse(title, url, TvType.Movie, url) {
                this.posterUrl = fixUrlNull(poster)
                this.plot = plot
                duration?.toIntOrNull()?.let { this.duration = it / 60 }
            }
        }

        // 列表页（分类、标签、最新、搜索）→ 剧集形式
        val listName = doc.selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: url.trimEnd('/').substringAfterLast('/')

        // 多抓几页，避免每个分类只有 23 个
        val merged = LinkedHashMap<String, SearchResponse>()
        for (p in 1..3) {
            val pageDoc = if (p == 1) doc else runCatching {
                app.get(url.trimEnd('/') + "/$p/", headers = webHeaders).document
            }.getOrNull() ?: break

            val pageCards = pageDoc.cards()
            if (pageCards.isEmpty()) break

            var added = 0
            for (c in pageCards) {
                if (merged.put(c.url, c) == null) added++
            }
            if (added == 0) break
        }

        if (merged.isEmpty()) throw ErrorLoadingException("No items at $url")

        // 必须给显式编号，否则 CloudStream 会把它们当成同一集
        val episodes = merged.values.mapIndexed { index, c ->
            newEpisode(c.url) {
                this.name = c.name
                this.posterUrl = c.posterUrl
                this.season = 1
                this.episode = index + 1
            }
        }
        return newTvSeriesLoadResponse(listName, url, TvType.TvSeries, episodes) {
            this.posterUrl = episodes.firstOrNull()?.posterUrl
            this.plot = "共 ${episodes.size} 个视频"
        }
    }

    // ---------------------------------------------------------------- 取流

    override suspend fun loadLinks(
        data: String,
        isCasting: Boolean,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit,
    ): Boolean {
        val html = runCatching { app.get(data, headers = webHeaders).text }.getOrNull() ?: return false
        val fv = flashvars(html)
        if (fv.isEmpty()) return false

        val qualities = listOf(
            "video_url" to "video_url_text",
            "video_alt_url" to "video_alt_url_text",
            "video_alt_url2" to "video_alt_url2_text",
            "video_alt_url3" to "video_alt_url3_text",
        )

        var found = false
        val seen = mutableSetOf<String>()

        for ((ukey, tkey) in qualities) {
            val link = pick(fv, ukey) ?: continue
            if (!link.contains(".mp4") || !seen.add(link)) continue

            val label = pick(fv, tkey) ?: "视频"
            val q = Regex("(\\d+)p").find(label)?.groupValues?.get(1)?.toIntOrNull()
                ?: Qualities.Unknown.value

            callback.invoke(
                newExtractorLink(name, "$name $label", link, ExtractorLinkType.VIDEO) {
                    this.referer = "$mainUrl/"
                    this.quality = q
                }
            )
            found = true
        }

        return found
    }
}

@CloudstreamPlugin
class Rule34VideoPlugin : Plugin() {
    override fun load(context: android.content.Context) {
        registerMainAPI(Rule34VideoProvider())
    }
}
