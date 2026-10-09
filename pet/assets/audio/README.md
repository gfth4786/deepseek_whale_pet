# 音效声音包放这里

侧栏「声音」里 `kind: effect` 的条目会在这里找文件。默认那条是：

```yaml
# src/config.yml
voices:
  - id: mambo
    name: 曼波
    kind: effect
    file: assets/audio/manbo.mp3
```

于是把音频放到 **`pet/assets/audio/manbo.mp3`** 即可——文件名要和 `file` 里写的完全一致
（路径相对 `pet/` 根，也就是这个目录的上一级的上一级）。

## 行为

- 选中该声音后，**所有 AI 回复都不再朗读文字**，而是每条回复播放一次这个音频；
  气泡里的文字照常显示。
- `mp3` / `wav` / `ogg` / `m4a` 都能播（Chromium 支持的容器都行）。
- 文件缺失或解码失败时：会弹一次提示（写明是哪个路径），**并自动回退到语音合成**，
  不会变成哑巴。放好文件后在侧栏再点一次该声音即可重试。
- 想同时保留普通朗读：在 `src/config.yml` 的 `voices:` 里再挂一条 `kind: tts` 的条目，
  侧栏就能随时来回切。

## 换别的音效

不用改代码，改 `src/config.yml` 就行：

```yaml
voices:
  - id: my-sound
    name: 我的音效
    kind: effect
    file: assets/audio/my-sound.ogg
```

想给不同事件配不同音效（例如"回复"和"通知"分开），当前是一条声音一个文件；
需要的话可以扩成按事件分文件。
