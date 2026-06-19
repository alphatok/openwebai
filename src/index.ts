import { createApp } from './gateway/server.js'

const PORT = Number(process.env.PORT) || 3000

async function main() {
  console.log('[openwebai] 正在启动...')

  // 组装所有模块
  const { app, driver } = await createApp()

  // 启动浏览器驱动
  await driver.launch()

  // 启动 API 服务
  await app.listen({ host: '0.0.0.0', port: PORT })

  console.log(`[openwebai] 服务已启动: http://localhost:${PORT}`)
  console.log('[openwebai] OpenAI 兼容接口: POST /v1/chat/completions')
  console.log('[openwebai] 模型列表: GET /v1/models')
  console.log('[openwebai] 健康检查: GET /health')

  // 优雅关闭
  const shutdown = async (signal: string) => {
    console.log(`\n[openwebai] 收到 ${signal}，正在关闭...`)
    await app.close()
    await driver.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[openwebai] 启动失败:', err)
  process.exit(1)
})
