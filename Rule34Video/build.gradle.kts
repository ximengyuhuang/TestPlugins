dependencies {
    implementation("org.jsoup:jsoup:1.18.3")
}

version = 1

cloudstream {
    description = "rule34video.com（最新 / 最热 / 评分 / 分类 / 标签）"
    authors = listOf("you")
    status = 1
    tvTypes = listOf("Movie")
    language = "en"
}

android {
    namespace = "com.rule34video"
}
