// Gesture and voice-command guide: a translucent panel centered on the desktop, shown once per model on first use and
// whenever the user opens it from DSH's AirPods menu.
import AppKit
import SwiftUI

struct GuideRow: Identifiable {
  let id = UUID()
  let symbol: String
  let title: String
  let detail: String
  var muted = false
}

struct GuideContent {
  let title: String
  let rows: [GuideRow]
  /// AirPods 1/2 need their double-tap actions configured once.
  let setup: String?

  static func make(model: String, name: String) -> GuideContent {
    let doubleTap = model == "airpods-1" || model == "airpods-2"
    let crown = model.hasPrefix("airpods-max")
    let motion = !doubleTap
    let talk = crown ? "按一下数码表冠" : doubleTap ? "轻点两下（设成「播放/暂停」的那只）" : "捏一下耳机柄"
    let interrupt = crown ? "按两下数码表冠" : doubleTap ? "轻点两下另一只（设成「下一首」）" : "捏两下"
    var rows = [
      GuideRow(symbol: "waveform", title: "说话", detail: talk),
      GuideRow(symbol: "paperplane", title: "发送", detail: "停顿 3 秒自动发送，或再\(crown ? "按" : doubleTap ? "轻点两下" : "捏")一下"),
      GuideRow(symbol: "stop.circle", title: "打断 DSH", detail: interrupt + "，正在朗读时也会停下"),
    ]
    if !doubleTap && !crown { rows.append(GuideRow(symbol: "arrow.uturn.backward", title: "撤销刚说的", detail: "捏三下")) }
    rows.append(GuideRow(symbol: "hand.thumbsup", title: "点头同意 · 摇头拒绝", detail: motion ? "DSH 请你确认操作时" : "这副耳机没有运动传感器，不支持", muted: !motion))
    rows.append(GuideRow(symbol: "quote.bubble", title: "语音指令", detail: "「停一下」「发送」「取消」「新会话」「清空」「读一下」"))
    rows.append(GuideRow(symbol: "ear", title: "摘下耳机", detail: "朗读自动暂停，戴上继续"))
    rows.append(GuideRow(symbol: "waveform.badge.mic", title: "说话时的音质", detail: "开麦期间耳机会切到通话音质，说完自动恢复"))
    let setup = doubleTap ? "第一次使用：打开「系统设置 › 蓝牙」，点「\(name)」旁的 ⓘ，把一只耳机的「轻点两下」设为「播放/暂停」，另一只设为「下一首」。" : nil
    return GuideContent(title: "用 \(name) 和 DSH 说话", rows: rows, setup: setup)
  }
}

final class GuideModel: ObservableObject {
  @Published var content = GuideContent.make(model: "airpods-2", name: "AirPods")
  @Published var shown = false
}

struct GuideView: View {
  @ObservedObject var model: GuideModel
  var onClose: () -> Void
  var onOpenBluetooth: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text(model.content.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(DSH.label1)
        Spacer()
        Button(action: onClose) {
          Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(DSH.label3)
            .frame(width: 24, height: 24).background(Circle().fill(DSH.hover))
        }.buttonStyle(.plain)
      }
      VStack(alignment: .leading, spacing: 10) {
        ForEach(model.content.rows) { row in
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: row.symbol).font(.system(size: 14)).foregroundStyle(row.muted ? DSH.label3 : DSH.label2).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
              Text(row.title).font(.system(size: 13, weight: .medium)).foregroundStyle(row.muted ? DSH.label3 : DSH.label1)
              Text(row.detail).font(.system(size: 12)).foregroundStyle(DSH.label3).fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      if let setup = model.content.setup {
        VStack(alignment: .leading, spacing: 8) {
          Text(setup).font(.system(size: 12)).foregroundStyle(DSH.label2).fixedSize(horizontal: false, vertical: true)
          Button(action: onOpenBluetooth) {
            Text("打开蓝牙设置").font(.system(size: 12, weight: .medium)).foregroundStyle(DSH.label1)
              .padding(.horizontal, 10).frame(height: 26)
              .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(DSH.hover))
          }.buttonStyle(.plain)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
      }
      HStack {
        Text("随时可以在 DSH 输入框的耳机菜单里打开这份指南").font(.system(size: 11)).foregroundStyle(DSH.label3)
        Spacer()
        Button(action: onClose) {
          Text("知道了").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color(red: 0.1, green: 0.1, blue: 0.12))
            .padding(.horizontal, 14).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(DSH.label1))
        }.buttonStyle(.plain)
      }
    }
    .padding(18)
    .frame(width: 420)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(DSH.surface.opacity(0.88))
      .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.ultraThinMaterial)))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5))
    .environment(\.colorScheme, .dark)
    .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
    .scaleEffect(model.shown ? 1 : 0.96)
    .opacity(model.shown ? 1 : 0)
    .animation(.easeOut(duration: 0.2), value: model.shown)
  }
}

final class Guide {
  private let model = GuideModel()
  private var panel: NSPanel?
  private let stateDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/DSH AirPods", isDirectory: true)

  /// Show for this model; `firstTimeOnly` skips models whose guide was already shown once.
  func show(model key: String, name: String, firstTimeOnly: Bool) {
    let marker = stateDirectory.appendingPathComponent("guide-\(key)")
    if firstTimeOnly && FileManager.default.fileExists(atPath: marker.path) { return }
    try? FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: marker.path, contents: Data())
    model.content = GuideContent.make(model: key, name: name)
    ensurePanel()
    if let screen = NSScreen.main?.visibleFrame, let panel {
      panel.setFrameOrigin(NSPoint(x: screen.midX - panel.frame.width / 2, y: screen.midY - panel.frame.height / 2 + 60))
    }
    panel?.orderFrontRegardless()
    DispatchQueue.main.async { self.model.shown = true }
    emit("guide", ["state": "shown", "model": key])
  }

  func hide() {
    model.shown = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { [weak self] in
      guard let self, !self.model.shown else { return }
      self.panel?.orderOut(nil)
    }
    emit("guide", ["state": "hidden"])
  }

  private func ensurePanel() {
    guard panel == nil else { return }
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 460, height: 600), styleMask: [.nonactivatingPanel, .borderless],
                        backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true
    let host = NSHostingView(rootView: GuideView(model: model, onClose: { [weak self] in self?.hide() }, onOpenBluetooth: {
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.BluetoothSettings")!)
    }).frame(maxWidth: .infinity, maxHeight: .infinity))
    host.frame = panel.contentView!.bounds
    host.autoresizingMask = [.width, .height]
    panel.contentView = host
    self.panel = panel
  }
}
