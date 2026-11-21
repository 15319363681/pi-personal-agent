# 多模型配置独立审查

第一轮的部分提交凭据一致性问题已修复，第二轮 M2/V4 发现旧活动配置省略 settingId 时读取 default 凭据。已改为已解析配置的 credentialRef 或 id，并覆盖存在与缺少 default 密钥两种情况。

报告位于 D:/Temp/pi-images-20261121-8Ii9S4/review-joint-report.md。review-round2-red.log 复现缺陷，后续全量 216 项及专项测试覆盖修复。第三轮最终复审待完成。
