# Edge AI Translator

AI 驱动的整页/划词翻译扩展。支持 OpenAI 兼容接口与自定义 JSON Provider，内置全局调度（并发/RPS/抖动/临时降压）、批处理合并、省单缓存、可取消、工作流定制、动态内容背压，以及“随机噪声注入（可开关）”以降低高频调用的风控特征。

重要说明：本扩展默认直连你配置的 Provider。请保护好 API Key，建议自行搭建网关或使用限速安全的代理。


功能特性
- 整页翻译与划词翻译，带轻量 UI（气泡、横幅）。
- OpenAI 兼容 /v1/chat/completions 与自定义 JSON Provider 双路径。
- 全局调度：并发闸门、RPS 限速、突发控制、抖动、429/5xx 临时降压与指数退避重试。
- 批处理合并：独立段按 token/字符/条数预算切分，OpenAI 严格 JSON 数组输出验证，失败自动降级逐条。
- LRU+TTL 缓存：命中不再请求，减少费用与风控风险。
- 去重与回填：整页相同文段只请求一次，回填到多个节点。
- 动态内容背压：窗口化 flush、显式最大批量上限、短期监听新增节点。
- 可取消：整页翻译可中止，取消排队与进行中请求。
- 工作流：风格/语气/术语表/占位符保护/响应格式/最小长度阈值；自定义 promptTemplate。
- 随机噪声注入（可配置）：按概率在 system 或用户文本尾部追加“可忽略的噪声”，打散请求相似度。


运行环境
- Microsoft Edge（Chromium）最新版本（支持 MV3）。
- 无需构建，作为“已解压的扩展”直接加载即可。


安装（开发模式）
- 克隆或下载本仓库。
- Edge 地址栏打开 edge://extensions，开启“开发人员模式”。
- 选择“加载已解压的扩展”，指向 edge-translator-extension 目录。
- 推荐先在“选项页”完成 Provider 与工作流设置，再进行测试。


快速开始
1. 打开扩展“选项页”：设置 Provider
   - Provider 类型：openai-compatible
   - Endpoint：https://api.openai.com/v1/chat/completions
   - API Key：你的 key
   - Model：gpt-4o-mini（或其他）
2. Provider 高级（推荐默认）
   - 限速：maxConcurrent=1–2，rps≈1.0，burst=2，jitterMs=[50,200]
   - 重试：maxRetries=5，baseDelayMs=800，maxDelayMs=20000，retryOn=[429,500,502,503,504]，jitter=on
   - 批处理：enabled=on，mode=json-array，maxItems=20，maxChars=8000，tokenBudget=2000
3. Workflow 进阶
   - style=“简洁准确，保留格式与占位符”，tone=“中性”
   - protectPlaceholders=on，responseFormat=auto，minTextLength=2
4. 风控噪声（可选）
   - 启用 enabled=true，position=system，probability=0.5–0.8，minWords=3–5
5. 保存配置，在“保存与测试”面板输入一段文本，点击“测试”
6. 工具栏图标弹窗可快速触发“整页翻译/划词翻译”，或使用快捷键 Alt+Shift+T / Alt+Shift+S


使用方法
- 整页翻译：点击扩展图标“整页翻译”，或 Alt+Shift+T。顶部横幅可查看进度与取消。
- 划词翻译：选择页面文本，点击就近“翻译”按钮或 Alt+Shift+S 弹出气泡；可再次翻译与复制译文。
- 动态页面：扩展会在短时间监听新增节点，分批去重后合并翻译，减少突发并发。


工作流（Workflow）说明
- 目标：在“翻译”这一单步任务上，提供可控的风格/语气/术语/格式与安全跳过策略。
- 主要字段
  - sourceLang/targetLang：源/目标语言，source=auto 时按页面/文本启发式提示。
  - style/tone：注入到 system 提示中，约束整体风格与语气。
  - glossary：JSON 数组 [{ "src": "...", "dst": "..." }]，严格遵守；见“术语表”示例。
  - protectPlaceholders：保护 {{...}}、{0}、%s、:var、&nbsp;、HTML/Markdown/代码片段等占位与标记。
  - responseFormat：auto/json/text；批处理或 json 模式会启用“严格 JSON 数组输出”。
  - minTextLength：过短或符号噪声段落跳过。
  - promptTemplate：自定义系统提示模板，支持 {{sourceLang}} / {{targetLang}} / {{style}} / {{tone}} / {{glossary}} / {{jsonConstraint}}。
- 批处理
  - 根据条数/字符数/token 预算自动切片；每批要求严格 JSON 数组，解析失败降级逐条。
- 自定义 Provider（type=custom）
  - POST { inputs[], sourceLang, targetLang, model, workflow }，返回 { outputs[] } 或 { data[] }。


风控噪声（Noise injection）
- 作用：按一定概率附加“可忽略噪声”以打散请求相似度；在 system 提示中会明确要求“忽略噪声”。
- 批处理路径：始终在 system 注入，保证 user JSON 负载不被破坏。
- 单条路径：可选择 position=user_suffix，将噪声追加在用户文本尾部；或 position=system。
- 可配置项
  - enabled（默认 false）
  - position（system | user_suffix；批处理强制 system）
  - probability（0–1，默认 0.6）
  - minWords/maxWords（默认 3–8，范围 0–100）
  - template（默认 "--- NOISE --- {{noise}}"，可替换 {{noise}}）
  - dictionary（自定义词典数组；为空则使用随机短 token）
- 成本提示：会略增 token 与时延；默认关闭，按需开启。


推荐默认与安全建议
- 限速：maxConcurrent=1–2，rps≈1.0，burst=2，jitter=[50,200]
- 重试：maxRetries=5，baseDelayMs=800，maxDelayMs=20000，retryOn=[429,500,502,503,504]
- 批处理：enabled=on，maxItems=20，maxChars=8000，tokenBudget=2000
- 工作流：protectPlaceholders=on，minTextLength=2
- 噪声：enabled=true（可选），position=system，probability=0.5–0.8，minWords=3–5
- 建议自建代理网关，进行额外的限速与审计；避免在公共环境中直接暴露 Key。


隐私与数据
- 配置存储在 chrome.storage.sync（账户同步）。
- 除你配置的 Provider 外，扩展不向第三方发送数据；不包含遥测与日志上报。
- 详见 PRIVACY.md。


快捷键
- 整页翻译：Alt+Shift+T
- 划词翻译：Alt+Shift+S
- 可在 Edge 的“扩展 → 键盘快捷方式”中自定义。


目录结构
- manifest.json：MV3 清单
- src/background.js：Service Worker，调度/缓存/提供商集成/消息路由
- src/content.js：内容脚本，整页与划词 UI、节点采集与回填、动态背压
- src/scheduler.js：全局调度与重试
- src/cache.js：LRU+TTL 缓存
- src/prompt.js：系统提示构造、预算估算与切分、跳过判断
- options/options.html|js：选项页（完整配置与测试）
- popup/popup.html|js：工具栏弹窗（快速设置与触发）
- src/overlay.css：UI 样式


API 兼容说明
- openai-compatible：/v1/chat/completions；需要设置 apiKey；messages 中使用 system + user。
- custom：POST JSON { inputs[], sourceLang, targetLang, model, workflow }；返回 outputs[] 或 data[]（字符串或包含 text 字段的对象）。


术语表示例（glossary）
[
  { "src": "Neural Network", "dst": "神经网络" },
  { "src": "Transformer", "dst": "Transformer" },
  { "src": "Latency", "dst": "时延" }
]


自定义 promptTemplate 示例
你是专业的翻译引擎。将 {{sourceLang}} 翻译为 {{targetLang}}。
风格：{{style}}；语气：{{tone}}。
术语表（严格遵守）：
{{glossary}}
{{jsonConstraint}}


测试清单（发布前）
- 小页面：几十段文本，确认批处理+缓存命中与 UI 正常
- 大页面：上千段，确认限速/批处理/背压稳定，无突发超量
- 重复文本：确认去重回填 OK
- 动态内容：滚动加载页面，确认短期监听与批量上限生效
- 429/5xx/网络错误：观察退避重试与临时降压是否触发
- 批处理解析失败：模拟输出非 JSON，检查降级逐条
- 取消：整页中途取消，排队与在途请求能中止
- 噪声：开启后验证译文不受影响，且请求具备差异性


已知限制
- 多密钥池轮转、错误率驱动的自适应降速/熔断、每域配额与随机启动延迟：未来版本提供。
- 图标与商店素材未打包：请自行准备 PNG 图标并在 manifest 中声明 icons 字段（见下文）。


打包与发布
- 升级 manifest.json 的 version。
- Edge 中“打包扩展程序”或直接 zip edge-translator-extension 目录。
- GitHub：提交代码与文档，创建 release 与 tag（如 v0.1.0）。
- 商店发布：准备图标（16/48/128 PNG），在 manifest 增加
  "icons": { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
  并将对应 PNG 放入 icons/ 目录。


安全提示
- 不要在公共场所或共享电脑保存 API Key。
- 建议代理/网关统一限速、鉴权与审计；严格限制来源域名。
- 适度开启噪声与抖动，提高抗风控能力。


开发与调试
- 控制台观察后台与内容脚本日志。
- 可在选项页添加更严格的限速，模拟真实生产环境。
- 建议使用网络层抓包验证批处理 JSON 数组正确性。


贡献
- 欢迎 Issue 与 PR。建议先讨论要点与场景，避免偏离“稳妥默认方案”。


许可证
- 本项目采用 MIT 协议，详见 LICENSE。


致谢
- 感谢各开源项目与 API 服务商的贡献。


版本历史
- 0.1.0：初始公开版本（MV3、调度/批处理/缓存/工作流/噪声注入）。


联系方式
- 可通过 GitHub Issue 反馈使用问题与建议。#
