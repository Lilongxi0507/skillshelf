---
name: skillshelf-media-generation
description: 在本机直接调用服务商生成或编辑图片、生成视频，完整携带执行脚本和协议适配；本地保存任务与成品，运行不依赖云面板。
metadata:
  skillshelf:
    display_name: 本地图片与视频生成
    use_when: 生成图片、参考图编辑、文生视频、首尾帧和参考媒体生成，按本地模型能力选择参数。
    examples:
      - 生成一张横版海报并保存到本地。
      - 用参考图生成一段视频，保存本地任务号和成品。
    requirements:
      - 已用 skillshelf providers 配置服务，账号具有所选模型权限及额度
      - 本机能直接访问服务商；生成可能计费
---

# 本地图片与视频生成

本技能完整包含 Python 标准库执行代码、图片参数和视频协议适配，没有额外 pip 依赖。
安装后由本机直接调用服务商，不调用云面板的生成、任务、历史或下载接口。
配置由 `skillshelf providers add/list/remove` 在本机管理，推荐 `api_key_env` 环境变量引用。
CLI 用 `SKILLSHELF_RUNTIME_CONFIG` 传入本次私有配置，用 `SKILLSHELF_OUTPUTS` 指定独立输出目录。
任务与成品必须在只读 store 外；`--output` 也不得指向技能或 store 内。不要打印密钥，
不要把配置加入项目或技能包。没有远端配置同步，不需要面板账号或共享连接。

先运行 `skillshelf run skillshelf-media-generation resources`，**离线**列出模型 ID、能力和参数。
按用户需求选择模型，优先能满足需求的默认资源。清单仅证明本地已有配置，不证明账号授权
及余额；生成遇到服务商拒绝时如实说明。用户要求生成作品即是该任务的生成授权；未请求
生成时不要创建计费任务以测试连通。

- [图片生成与编辑](references/images.md)
- [视频提交、恢复和本地交付](references/videos.md)

Agent 读取本地技能即可执行，无需先调用云面板发现接口。没有 CLI 时使用
`python scripts/run.py --config /本地/providers.json <子命令>`。只读本次用户提供的参考媒体，
先检查图片再上传；未提供图片时不能虚构路径。未知结果不重复创建，不自动切换模型生成。

只有本地已有实际成品才报告完成，使用 Agent 支持的图片／视频预览或本地文件链接交付。
返回任务号和 processing 只能说已提交。停止等待不会取消服务商任务，也不会在本回合结束
后自动继续；下次通过本地 job.json 恢复。图片与视频是外部云服务，不是本地模型权重，
因此仍需互联网，但云面板可以离线。
