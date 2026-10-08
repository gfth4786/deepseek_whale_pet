# PNG 立绘放这里

窗口启动时会探测这个目录（`pet/assets/whale/png/`）。只要存在至少一张 PNG，
渲染层就会改用 PNG 而不是内置的 SVG 鲸鱼娘，缺失的表情自动回退到 `idle.png`。

按表情命名，全部可选：

| 文件名 | 对应表情 |
| --- | --- |
| `idle.png` | 发呆（同时是其他表情的兜底） |
| `happy.png` | 开心 |
| `thinking.png` | 思考 |
| `working.png` | 干活 |
| `sleepy.png` | 困了 |
| `surprised.png` | 惊讶 |

约定：

- 建议透明背景 PNG，人物站在画布底部（渲染层用 `object-fit: contain` + 底部对齐）。
- 窗口默认 320×420，人物区域约 300×330；按 600×660 或更高分辨率出图即可，缩放由 CSS 负责。
- 不想要 PNG 了，删掉这些文件就会自动回到 SVG 形象。

SVG 形象的 id 契约见 [../README.md](../README.md)。
