package com.nsfwr34

import android.content.Context
import com.lagradost.cloudstream3.plugins.CloudstreamPlugin
import com.lagradost.cloudstream3.plugins.Plugin

@CloudstreamPlugin
class NSFWR34Plugin : Plugin() {
    override fun load(context: Context) {
        // 每个 Provider 都要在这里注册一次
        registerMainAPI(NSFWR34Provider())
    }
}
