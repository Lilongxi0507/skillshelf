# 图片生成与编辑

示例：`skillshelf run skillshelf-media-generation image "横版山水海报" --resource <模型ID> --size <合法尺寸>`。
用 resources 中的 sizes、ratios、qualities、output_formats 选择参数。可选 `--ratio`、`--quality`、
`--output-format`、`--background`；无支持的选项会拒绝，不会静默丢弃。

参考图使用 `--reference "本地图片路径"`，可重复；蒙版使用 `--mask "本地透明PNG路径"`，
用户应提供与首张参考图相同尺寸的透明 PNG。编辑只在模型 edit 能力允许时进行。
OpenAI/AI Hub 图片编辑使用 multipart /images/edits；Agnes 使用原生 extra_body.image。
默认根目录来自 CLI，可通过 `--output "成品根目录"` 指定，始终新建任务子目录以免覆盖文件。

请求超时后 job.json 为 submission_unknown；不要自动重新提交，先在服务商后台确认。
服务商返回图片 URL 时本机直接下载，下载不会携带服务商 Key，认证请求拒绝重定向。

- [AI Hub 图片接口](https://docs.codexzh.com/ai-hub-api/image-tutorial)
- [Agnes Image](https://agnes-ai.com/en/docs/agnes-image-25-flash)
