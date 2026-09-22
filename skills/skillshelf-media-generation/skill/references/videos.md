# 视频与本地任务恢复

文生视频：`skillshelf run skillshelf-media-generation video "日出延时摄影" --resource <模型ID> --seconds <支持时长>`。
首尾帧加 `--mode keyframe --first-frame "本地图片"`，支持尾帧的模型可加 `--last-frame`。
参考模式加 `--mode reference --reference "图片"`，支持音频参考时可重复加 `--audio "音频"`。
其他参数 `--size`、`--ratio`、`--fps`、`--quality`、`--with-audio`、`--seed` 以资源能力为准。

当前包含 CogVideoX、Agnes Video 和 OpenAI Videos 兼容协议。Sora 兼容适配仅支持文生视频。
默认等待 600 秒，`--wait 0` 提交并查询一次后返回。任务号写入本机 job.json；恢复用
`skillshelf run skillshelf-media-generation video-resume "完整路径/job.json" --wait 600`。
恢复只查询同一任务，不重复提交；完成后 MP4 保存于任务目录。进程或电脑重启后也可继续。

401/403/429、连接中断或失败状态均不自动创建新任务。尚未取得服务商任务号时结果未知，
需到服务商后台核实，不能把重新提交当成恢复。服务商 Key 由用户在本地 providers 管理；
删除本地配置不会撤销服务商凭据，如需撤销请到服务商后台操作。本技能不使用共享连接。

- [Agnes Video](https://agnes-ai.com/en/docs/agnes-video-25-flash)
- [CogVideoX](https://docs.bigmodel.cn/cn/guide/models/free/cogvideox-flash)
