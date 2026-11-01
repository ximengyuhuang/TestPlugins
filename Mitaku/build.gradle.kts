dependencies {
    implementation("org.jsoup:jsoup:1.18.3")
}

version = 1

cloudstream {
    description = "mitaku.net 视频帖（PoW + AES-GCM 取流）"
    authors = listOf("you")
    status = 1
    tvTypes = listOf("Movie")
    language = "ja"
}

android {
    namespace = "com.mitaku"
}
