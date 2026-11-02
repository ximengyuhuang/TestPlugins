package com.supjav

import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.plugins.CloudstreamPlugin
import com.lagradost.cloudstream3.plugins.Plugin
import com.lagradost.cloudstream3.utils.ExtractorLink
import com.lagradost.cloudstream3.utils.SubtitleFile
import com.lagradost.cloudstream3.utils.loadExtractor
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/**
 * supjav.com
 *
 * 列表：div.post  →  a.img[href][title] + img.thumb[src]
 * 详情：h1 / #player-wrap 背景图 / a.btn-server[data-link]
 * 取流：data-link 反转 → GET lk1.supremejav.com/supjav.php?c=<rev>
 *        → 302 到 streamtape / dood / japopav，交给 CloudStream 内置提取器
 */
class SupJavProvider : MainAPI() {
    override var mainUrl = "https://supjav.com"
    override var name = "SupJav"

    override val hasMainPage = true
    override val hasQuickSearch = false
    override val supportedTypes = setOf(TvType.Movie)
    override var lang = "ja"

    private val apiHost = "https://lk1.supremejav.com"

    private val webHeaders = mapOf(
        "User-Agent" to "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept" to "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language" to "en-US,en;q=0.9",
        "Referer" to "https://supjav.com/",
    )

    // ---------------------------------------------------------------- 首页行

    override val mainPage = mainPageOf(
        "" to "最新",
        "popular?sort=day" to "热门·日榜",
        "popular?sort=week" to "热门·周榜",
        "popular?sort=month" to "热门·月榜",
        "category/censored-jav" to "有码",
        "category/uncensored-jav" to "无码",
        "category/amateur" to "素人",
        "category/chinese-subtitles" to "中文字幕",
        "category/reducing-mosaic" to "薄码",
        "category/english-subtitles" to "英文字幕",
        "@tags" to "标签（292）",
        "@makers" to "制作商",
        "@casts" to "演员",
    )

    // ---------------------------------------------------------------- 解析

    private data class Card(val name: String, val url: String, val poster: String?)

    private fun Element.toCard(): Card? {
        val a = selectFirst("a.img[href]") ?: selectFirst("h3 a[href]") ?: return null
        val href = fixUrlNull(a.attr("href")) ?: return null
        val title = a.attr("title").trim().ifBlank {
            selectFirst("h3")?.text()?.trim() ?: ""
        }
        if (title.isBlank()) return null
        val img = selectFirst("img.thumb")?.attr("src")
            ?: selectFirst("img[src]")?.attr("src")
        // 缩略图是 xxx.jpg!320x216.jpg，去掉 ! 后缀取原图
        val poster = img?.substringBefore("!")
        return Card(title, href, poster?.takeIf { it.isNotBlank() })
    }

    private fun Document.cards(): List<Card> =
        select("div.post").mapNotNull { it.toCard() }.distinctBy { it.url }

    /** 分类/标签/制作商/演员 的列表页 → 视频卡片 */
    private suspend fun listCards(url: String): List<Card> = runCatching {
        app.get(url, headers = webHeaders).document.cards()
    }.getOrDefault(emptyList())

    /** /tag、/maker、/cast 这类索引页 → 入口列表 */
    private suspend fun indexEntries(path: String, pages: Int): List<Card> {
        val out = LinkedHashMap<String, Card>()
        for (p in 1..pages) {
            val url = if (p == 1) "$mainUrl$path" else "$mainUrl$path/page/$p"
            val doc = runCatching { app.get(url, headers = webHeaders).document }.getOrNull() ?: continue
            doc.select("div.categorys div.child a[href]").forEach { a ->
                val href = fixUrlNull(a.attr("href")) ?: return@forEach
                // 文本形如 "3P&4P (31493)"，去掉末尾数量
                val rawName = a.text().trim()
                val n = rawName.replace(Regex("\\s*\\(\\d+\\)\\s*$"), "").trim()
                if (n.isNotBlank() && !out.containsKey(href)) {
                    out[href] = Card(n, href, null)
                }
            }
        }
        return out.values.toList()
    }

    /** 拼分页 URL；data 可能带查询串（如 popular?sort=day） */
    private fun pageUrl(data: String, page: Int): String {
        val q = data.indexOf('?')
        val path = (if (q >= 0) data.substring(0, q) else data).trim('/')
        val query = if (q >= 0) data.substring(q) else ""
        return when {
            page <= 1 -> if (path.isEmpty()) "$mainUrl/$query" else "$mainUrl/$path$query"
            path.isEmpty() -> "$mainUrl/page/$page$query"
            else -> "$mainUrl/$path/page/$page$query"
        }
    }

    // ---------------------------------------------------------------- 列表

    override suspend fun search(query: String): List<SearchResponse> {
        return runCatching {
            app.get("$mainUrl/", params = mapOf("s" to query), headers = webHeaders)
                .document.cards().map { it.toSearchResponse() }
        }.getOrDefault(emptyList())
    }

    private fun Card.toSearchResponse(): SearchResponse =
        newMovieSearchResponse(name, url, TvType.Movie) {
            this.posterUrl = poster
        }

    override suspend fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val data = request.data

        // 索引行：一次性给全，不再翻页
        if (data.startsWith("@")) {
            val (path, pages) = when (data) {
                "@tags" -> "/tag" to 3
                "@makers" -> "/maker" to 2
                "@casts" -> "/cast" to 2
                else -> return newHomePageResponse(HomePageList(request.name, emptyList(), true), false)
            }
            val entries = indexEntries(path, pages).map { it.toSearchResponse() }
            return newHomePageResponse(
                HomePageList(request.name, entries, true),
                hasNext = false
            )
        }

        val cards = listCards(pageUrl(data, page))
        return newHomePageResponse(
            HomePageList(request.name, cards.map { it.toSearchResponse() }, true),
            hasNext = cards.isNotEmpty()
        )
    }

    // ---------------------------------------------------------------- 详情

    private fun isDetail(url: String) = Regex("\\d+\\.html").containsMatchIn(url)

    override suspend fun load(url: String): LoadResponse {
        val doc = app.get(url, headers = webHeaders).document

        if (isDetail(url)) {
            val title = doc.selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotBlank() }
                ?: throw ErrorLoadingException("No title at $url")

            val bg = doc.selectFirst("#player-wrap")?.attr("style") ?: ""
            val poster = Regex("url\\(([^)]+)\\)").find(bg)?.groupValues?.get(1)
                ?: doc.selectFirst("img.thumb")?.attr("src")?.substringBefore("!")

            val serverCount = doc.select("a.btn-server[data-link]").size
            val cats = doc.select("a[href*='/category/']").map { it.text().trim() }
                .filter { it.isNotBlank() }.distinct().take(6).joinToString(" / ")
            val tags = doc.select("a[href*='/tag/']").map { it.text().trim() }
                .filter { it.isNotBlank() }.distinct().take(8).joinToString(", ")

            val plot = buildString {
                if (cats.isNotBlank()) append(cats)
                if (tags.isNotBlank()) { if (isNotEmpty()) append("\n"); append(tags) }
                if (serverCount > 0) { if (isNotEmpty()) append("\n"); append("$serverCount 个播放源") }
            }.ifBlank { null }

            return newMovieLoadResponse(title, url, TvType.Movie, url) {
                this.posterUrl = fixUrlNull(poster)
                this.plot = plot
            }
        }

        // 分类 / 标签 / 制作商 / 演员 的列表页 → 剧集形式
        val listName = doc.selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotBlank() }
            ?: url.trimEnd('/').substringAfterLast('/')

        val episodes = doc.cards().mapIndexed { _, c ->
            newEpisode(c.url) {
                this.name = c.name
                this.posterUrl = c.poster
            }
        }
        if (episodes.isEmpty()) throw ErrorLoadingException("No items at $url")

        return newTvSeriesLoadResponse(listName, url, TvType.Movie, episodes) {
            this.posterUrl = episodes.firstOrNull()?.posterUrl
        }
    }

    // ---------------------------------------------------------------- 取流

    override suspend fun loadLinks(
        data: String,
        isCasting: Boolean,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit,
    ): Boolean {
        val doc = runCatching { app.get(data, headers = webHeaders).document }.getOrNull() ?: return false
        val buttons = doc.select("a.btn-server[data-link]")
        if (buttons.isEmpty()) return false

        var found = false
        val seen = mutableSetOf<String>()

        for (btn in buttons) {
            val token = btn.attr("data-link").trim()
            if (token.isBlank()) continue

            // 站点把 token 反转存着
            val phpUrl = "$apiHost/supjav.php?c=${token.reversed()}"
            val target = runCatching {
                val resp = app.get(phpUrl, headers = webHeaders)
                resp.url.ifBlank { resp.headers["Location"] ?: "" }
            }.getOrNull().orEmpty()

            if (target.isBlank() || !seen.add(target)) continue

            // streamtape / dood 都有内置提取器，japopav 可能没有
            if (loadExtractor(target, "$mainUrl/", subtitleCallback, callback)) {
                found = true
            }
        }
        return found
    }
}

@CloudstreamPlugin
class SupJavPlugin : Plugin() {
    override fun load(context: android.content.Context) {
        registerMainAPI(SupJavProvider())
    }
}
