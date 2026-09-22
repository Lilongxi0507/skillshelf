# 直连接口与恢复

脚本直接请求 Tavily `POST https://api.tavily.com/search`，使用 Bearer Key、basic 深度、
max_results 和 include_answer；Brave 使用 `GET https://api.search.brave.com/res/v1/web/search`，
使用 X-Subscription-Token、q 与 count。配置和 Key 分开于发布包保存。

未指定引擎时只对明确的 502/503/504 换另一个已配置引擎一次。401/403/429 停止，不换身份
绕过限制；其他错误、连接中断和超时不自动重试。提示配置错误时不输出密钥或服务商响应体。
缺少依赖、无结果或无权限应如实报告，不能把安装成功当作服务商账号可用证明。

- [Tavily 官方 Search 参数](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Brave 官方 Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search)
