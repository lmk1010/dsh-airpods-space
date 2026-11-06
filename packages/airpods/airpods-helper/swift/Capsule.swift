// Live caption capsule under the menu bar while talking with DSH in the background; hidden when DSH is frontmost,
// where the words already appear in the composer.
import AppKit
import SwiftUI

final class CapsuleModel: ObservableObject {
  @Published var text = ""
  /// listening, recognizing, sent, failed
  @Published var phase = "listening"
  @Published var shown = false
}

struct CapsuleView: View {
  @ObservedObject var model: CapsuleModel
  @State private var pulse = false
  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        if model.phase == "sent" {
          Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.green)
        } else {
          Circle().fill(model.phase == "failed" ? Color.red : Color.green).frame(width: 8, height: 8)
            .scaleEffect(pulse ? 1.15 : 0.75).opacity(pulse ? 1 : 0.55)
        }
      }
      .frame(width: 14)
      Text(label).font(.system(size: 13)).foregroundStyle(model.text.isEmpty ? DSH.label3 : DSH.label1)
        .lineLimit(1).truncationMode(.head)
    }
    .padding(.horizontal, 14).frame(height: 34).frame(maxWidth: 460)
    .fixedSize(horizontal: true, vertical: false)
    .background(Capsule().fill(DSH.surface).background(Capsule().fill(.ultraThinMaterial)))
    .overlay(Capsule().strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5))
    .environment(\.colorScheme, .dark)
    .shadow(color: .black.opacity(0.3), radius: 8, y: 3)
    .offset(y: model.shown ? 0 : -50).opacity(model.shown ? 1 : 0)
    .animation(.spring(response: 0.32, dampingFraction: 0.85), value: model.shown)
    .onAppear { if reduceMotion { pulse = true } else { withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { pulse = true } } }
  }

  private var label: String {
    switch model.phase {
    case "sent": return model.text.isEmpty ? "已发送" : model.text
    case "failed": return "没听清，再说一次"
    case "recognizing": return model.text.isEmpty ? "识别中…" : model.text
    default: return model.text.isEmpty ? "在听…" : model.text
    }
  }
}

final class CapsuleWindow {
  private let model = CapsuleModel()
  private var panel: NSPanel?
  private var hideTimer: Timer?


  func update(phase: String, text: String? = nil) {
    hideTimer?.invalidate()
    if let text { model.text = String(text.suffix(60)) }
    model.phase = phase
    guard !dshFrontmost() else { hide(); return }
    ensurePanel()
    position()
    panel?.orderFrontRegardless()
    model.shown = true
    if phase == "sent" || phase == "failed" {
      hideTimer = Timer.scheduledTimer(withTimeInterval: 1.4, repeats: false) { [weak self] _ in self?.hide() }
    }
  }

  func hide() {
    hideTimer?.invalidate()
    guard model.shown else { return }
    model.shown = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self, !self.model.shown else { return }
      self.panel?.orderOut(nil); self.model.text = ""
    }
  }

  private func position() {
    guard let panel, let frame = (NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main)?.visibleFrame else { return }
    panel.setFrameOrigin(NSPoint(x: frame.midX - panel.frame.width / 2, y: frame.maxY - panel.frame.height - 6))
  }

  private func ensurePanel() {
    guard panel == nil else { return }
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 50), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    let host = NSHostingView(rootView: CapsuleView(model: model).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).padding(.top, 6))
    host.frame = panel.contentView!.bounds
    host.autoresizingMask = [.width, .height]
    panel.contentView = host
    self.panel = panel
  }
}
