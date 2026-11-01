// CloudStream 插件模块配置（照官方 TestPlugins 模板的 ExampleProvider 写）

dependencies {
    // 用不到 material / recyclerview 就不必加，这里保持默认即可
    implementation("org.jsoup:jsoup:1.18.3")
}

// 整数版本号，改一次代码就 +1，方便 App 端识别更新
version = 1

cloudstream {
    description = "nsfwr34.com provider"
    authors = listOf("you")

    /**
     * 状态码：
     *  0: Down   1: Ok   2: Slow   3: Beta-only
     **/
    status = 1

    tvTypes = listOf("Movie")
    language = "en"
}

android {
    // 覆盖根 build.gradle.kts 里的 com.example，避免多插件同 namespace
    namespace = "com.nsfwr34"
}
