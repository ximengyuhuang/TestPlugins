dependencies {
    implementation("org.jsoup:jsoup:1.18.3")
}

version = 1

cloudstream {
    description = "cosplaytele.com video posts"
    authors = listOf("you")
    status = 1
    tvTypes = listOf("Movie")
    language = "en"
}

android {
    namespace = "com.cosplaytele"

    // 源码实际在 CosplayTele/src/main/ 下（多套了一层），这里显式指过去
    sourceSets["main"].manifest.srcFile("CosplayTele/src/main/AndroidManifest.xml")
    sourceSets["main"].java.srcDirs("CosplayTele/src/main/kotlin")
}
