# AirPods space

English | [中文](README.zh.md)

Press your AirPods to talk to DSH. Opening the case shows a battery card; while you speak, your words appear in the composer and are sent when you finish; DSH's replies are read into your ears.

## Turn it on

1. In DSH, open **Plugins**, find **AirPods space** under Experimental plugins and switch it on. No restart needed.
2. The setup dialog opens the first time: choose speech recognition, allow the microphone, and see the gestures.
3. Connect your AirPods. The first time a model connects, a gesture guide appears in the middle of the desktop; open the full guide any time from the composer's AirPods menu › **Settings…** › **Guide**.

## Gestures

| To | AirPods 3 / 4 / Pro | AirPods 1 / 2 | AirPods Max |
|---|---|---|---|
| Talk | Press the stem | Double-tap (the bud set to Play/Pause) | Press the Digital Crown |
| Send | Say "send" alone or at the end of a sentence, or send after a 1–3 s pause (Settings › Talk) | Same | Same |
| Interrupt DSH / stop reading | Press twice | Double-tap the other bud (set to Next Track) | Press the crown twice |
| Undo the last sentence | Press three times | Say "cancel" | Say "cancel" |
| Approve / reject | Nod / shake | Say "approve" / "reject" | Nod / shake |

AirPods 1 and 2 need a one-time setting: System Settings › Bluetooth › your AirPods ⓘ, set one bud's double-tap to Play/Pause (one bud is enough); optionally set the other to Next Track to interrupt DSH.

**Voice commands** run only when the whole utterance is the phrase; anything else is sent to DSH as text: stop · send · cancel · new session · clear · read · approve / reject (Chinese phrases: 停一下, 发送, 取消, 新会话, 清空, 读一下, 同意, 拒绝).

## The AirPods icon

White: ready · Yellow: not connected or not worn · Red: needs attention (permission, error, another app holds the button; hover for the reason, open the menu to fix) · Green breathing: listening · Thin ring: local model downloading · Red dot: battery below 10%.

## Speech recognition

| Source | Notes |
|---|---|
| Apple on this Mac (default) | Runs on this Mac, no download, no network; allow Speech Recognition on first use |
| Aliyun | Most accurate (also for mixed Chinese and English); needs a network and an Aliyun API key |
| Local model | Fully offline; downloads about 240 MB only when chosen; cancel any time |

The Aliyun key is read from the plugin's `apiKey`, then `DASHSCOPE_API_KEY`, then the macOS Keychain (account `dshub`, service `dshub.aliyun.dashscope`). If the cloud is unreachable, that turn uses the local model.

## Privacy

Audio is captured only after you press (or choose Start talking) and stops when you finish; macOS shows the orange microphone dot meanwhile. Only the AirPods microphone is used; with no AirPods connected nothing is recorded. Apple and local recognition keep audio on this Mac; Aliyun sends it to Aliyun for recognition.
