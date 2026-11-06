// Native connect card (SwiftUI in a non-activating floating panel): shows above every app and Space without taking
// focus, so it works while DSH is hidden or in the background.
import AppKit
import SwiftUI

struct PodsSnapshot: Equatable {
  var model = "airpods-2"
  var name = "AirPods"
  var left: Int?
  var right: Int?
  var caseLevel: Int?
  var chargingLeft = false
  var chargingRight = false
  var chargingCase = false
  var gesture = "double-tap"
  /// Buds in the case: both, left, right, none or unknown.
  var caseSide = "both"
  /// Never paired with this Mac: the card offers pairing instead of connecting.
  var unpaired = false
}

final class PopupModel: ObservableObject {
  @Published var pods = PodsSnapshot()
  @Published var shown = false
  @Published var lidOpen = false
  /// Bumped per show so the artwork replays its entrance.
  @Published var generation = 0
  /// Buds are out of the case / in the ears: the card shows the worn animation.
  @Published var worn = false
  /// "Connect to this Mac" button state: hidden, available, connecting, connected or failed.
  @Published var connect = "hidden"
  /// Device name shown on the connect button.
  @Published var connectName = ""
  /// Microphone onboarding instead of the AirPods card: prompt, denied or granted.
  @Published var permission: String?
}

/// "Let DSH hear you": shown once before the first talk so a headphone press works.
/// DSH dark theme values (ui-theme tokens) so native surfaces match the app.
/// System setting "Reduce motion": looping float, spin and breathing effects stay off.
var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

enum DSH {
  static let surface = Color(red: 0x30 / 255, green: 0x31 / 255, blue: 0x36 / 255).opacity(0.94)
  static let label1 = Color(red: 0xf9 / 255, green: 0xfa / 255, blue: 0xfb / 255)
  static let label2 = Color(red: 0xcf / 255, green: 0xd3 / 255, blue: 0xd6 / 255)
  static let label3 = Color(red: 0xad / 255, green: 0xb2 / 255, blue: 0xb8 / 255)
  static let hover = Color.white.opacity(0.06)
}

struct PermissionPane: View {
  @ObservedObject var model: PopupModel
  var onAllow: () -> Void
  var onLater: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: model.permission == "granted" ? "checkmark.circle.fill" : "mic")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(model.permission == "granted" ? Color.green : DSH.label2)
          .frame(width: 16)
        Text(model.permission == "granted" ? "已允许使用麦克风" : "让 DSH 听见你")
          .font(.system(size: 13, weight: .semibold)).foregroundStyle(DSH.label1)
        Spacer(minLength: 0)
      }
      Text(body(for: model.permission)).font(.system(size: 12)).foregroundStyle(DSH.label3)
        .fixedSize(horizontal: false, vertical: true).padding(.leading, 26)
      if model.permission != "granted" {
        HStack(spacing: 6) {
          Spacer()
          Button(action: onLater) {
            Text("以后").font(.system(size: 12, weight: .medium)).foregroundStyle(DSH.label2)
              .padding(.horizontal, 10).frame(height: 26)
              .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(DSH.hover))
          }.buttonStyle(.plain)
          Button(action: onAllow) {
            Text(model.permission == "denied" ? "打开设置" : "允许").font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Color(red: 0.1, green: 0.1, blue: 0.12))
              .padding(.horizontal, 12).frame(height: 26)
              .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(DSH.label1))
          }.buttonStyle(.plain)
        }
      }
    }
  }

  private func body(for state: String?) -> String {
    switch state {
    case "granted": return "现在轻点两下耳机，就能和 DSH 说话。"
    case "denied": return "麦克风已关闭。在「隐私与安全性 › 麦克风」打开「DSH AirPods」。"
    default: return "只在你按下耳机时才会听，用于把你说的话变成文字。"
    }
  }
}

/// Buds floating out of the case with a check mark drawn underneath.
struct WornArtwork: View {
  var model: String
  @State private var out = false
  @State private var check = 0.0
  @State private var halo = false
  @State private var float = false
  var body: some View {
    let family = Art.family(model)
    let single = family == "airpods-max"
    ZStack {
      // one soft green ring that grows and fades as the check lands
      Circle().stroke(Color.green.opacity(halo ? 0 : 0.55), lineWidth: 2)
        .frame(width: 34, height: 34).scaleEffect(halo ? 2.6 : 1).offset(y: 72)
      if single, let image = Art.image(family) {
        Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
          .frame(width: 160, height: 140).scaleEffect(out ? 1 : 0.6).offset(y: out ? (float ? -14 : -8) : 30).opacity(out ? 1 : 0)
      } else {
        // The two buds rise from where the case sits, part slightly, then settle and float in step.
        ForEach(["left", "right"], id: \.self) { side in
          let sign: CGFloat = side == "left" ? -1 : 1
          if let image = Art.bud(family, side: side) {
            Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
              .frame(width: 84, height: 132)
              .rotationEffect(.degrees(out ? Double(sign) * 6 : Double(sign) * -8))
              .scaleEffect(out ? 1 : 0.5)
              .offset(x: out ? sign * 46 : sign * 16, y: out ? (float ? -16 : -10) : 40)
              .opacity(out ? 1 : 0)
              .animation(.spring(response: 0.5, dampingFraction: 0.72).delay(side == "left" ? 0 : 0.06), value: out)
          }
        }
      }
      ZStack {
        Circle().fill(Color.green).frame(width: 34, height: 34).scaleEffect(check > 0 ? 1 : 0.2).opacity(check > 0 ? 1 : 0)
        CheckShape().trim(from: 0, to: check).stroke(Color.black, style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
          .frame(width: 14, height: 11)
      }
      .offset(y: 72)
    }
    .frame(height: 180)
    .onAppear {
      out = true
      withAnimation(.spring(response: 0.3, dampingFraction: 0.6).delay(0.32)) { check = 1 }
      if !reduceMotion {
        withAnimation(.easeOut(duration: 0.9).delay(0.45)) { halo = true }
        withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true).delay(0.8)) { float = true }
      }
    }
  }
}

struct CheckShape: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.minX, y: rect.midY))
    path.addLine(to: CGPoint(x: rect.width * 0.38, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    return path
  }
}

// MARK: - Artwork (generated transparent product renders in ../assets, one closed + one open image per case shape)

enum Art {
  /// Directory holding the renders: $DSH_AIRPODS_ASSETS, else ../assets next to the executable.
  static let directory: URL = {
    if let path = ProcessInfo.processInfo.environment["DSH_AIRPODS_ASSETS"] { return URL(fileURLWithPath: path) }
    return URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("assets")
  }()
  static var cache: [String: NSImage] = [:]
  static func image(_ name: String) -> NSImage? {
    if let hit = cache[name] { return hit }
    let image = NSImage(contentsOf: directory.appendingPathComponent("\(name).png"))
    cache[name] = image
    return image
  }
  /// One earbud: the left or right half of the two-bud render.
  static func bud(_ family: String, side: String) -> NSImage? {
    let key = "\(family)-bud-\(side)"
    if let hit = cache[key] { return hit }
    guard let both = image("\(family)-buds"), let cg = both.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    let half = cg.width / 2
    guard let cropped = cg.cropping(to: CGRect(x: side == "left" ? 0 : half, y: 0, width: half, height: cg.height)) else { return nil }
    let result = NSImage(cgImage: cropped, size: NSSize(width: half, height: cg.height))
    cache[key] = result
    return result
  }
  /// Case shape family for a model key.
  static func family(_ model: String) -> String {
    if model.hasPrefix("airpods-max") { return "airpods-max" }
    if model.hasPrefix("airpods-pro") { return "airpods-pro" }
    if model.hasPrefix("airpods-4") { return "airpods-4" }
    if model == "airpods-3" { return "airpods-3" }
    return "airpods-2"
  }
}

struct PodsArtwork: View {
  var model: String
  var lidOpen: Bool
  var caseSide = "both"
  @State private var risen = false
  @State private var float = false
  @State private var lidPop = false
  var body: some View {
    let family = Art.family(model)
    let single = family == "airpods-max"
    // Which buds are out of the case: they lift out as separate sprites and float beside it.
    let leftOut = !single && lidOpen && (caseSide == "right" || caseSide == "none")
    let rightOut = !single && lidOpen && (caseSide == "left" || caseSide == "none")
    let empty = leftOut && rightOut
    ZStack {
      // soft contact shadow that breathes with the float
      Ellipse().fill(RadialGradient(colors: [.black.opacity(0.45), .clear], center: .center, startRadius: 2, endRadius: 70))
        .frame(width: 130, height: 20).offset(y: 80).scaleEffect(float ? 0.86 : 1).opacity(risen ? (empty ? 0.5 : 1) : 0)
      ZStack {
        if let closed = Art.image(single ? family : "\(family)-closed") {
          Image(nsImage: closed).resizable().interpolation(.high).scaledToFit().opacity(single || !lidOpen ? 1 : 0)
        }
        if !single, let open = Art.image(caseSide == "left" || caseSide == "right" ? "\(family)-open-\(caseSide)" : "\(family)-open") {
          Image(nsImage: open).resizable().interpolation(.high).scaledToFit().opacity(lidOpen ? 1 : 0)
        }
      }
      .frame(width: 170, height: 170)
      .rotation3DEffect(.degrees(reduceMotion ? 0 : risen ? (float ? 6 : -6) : -38), axis: (x: 0, y: 1, z: 0), perspective: 0.5)
      .offset(y: risen ? (float ? -4 : 2) + (empty ? 14 : 0) : 50)
      .scaleEffect((risen ? 1 : 0.7) * (empty ? 0.8 : 1) * (lidPop ? 1.035 : 1))
      // The open-case render always contains both buds; with both out the case recedes almost entirely.
      .opacity(risen ? (empty ? 0.08 : 1) : 0)
      if !single {
        BudSprite(family: family, side: "left", out: leftOut, float: float)
        BudSprite(family: family, side: "right", out: rightOut, float: float)
      }
    }
    .frame(height: 180)
    .animation(.easeInOut(duration: 0.32), value: lidOpen)
    .animation(.spring(response: 0.5, dampingFraction: 0.78), value: caseSide)
    .onChange(of: lidOpen) { open in
      // The lid "gives" a little as it opens, like the case on iPhone's card.
      guard open, !reduceMotion else { return }
      withAnimation(.spring(response: 0.22, dampingFraction: 0.5)) { lidPop = true }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { lidPop = false } }
    }
    .onAppear {
      withAnimation(.spring(response: 0.42, dampingFraction: 0.78)) { risen = true }
      if !reduceMotion { withAnimation(.easeInOut(duration: 2.6).repeatForever(autoreverses: true).delay(0.8)) { float = true } }
    }
  }
}

/// One earbud cut from the two-bud render: rests in its slot (hidden, small) or lifts out, tilts and floats beside
/// the case. Changing `out` animates the bud leaving or returning to the case.
struct BudSprite: View {
  var family: String
  var side: String
  var out: Bool
  var float: Bool
  var body: some View {
    let sign: CGFloat = side == "left" ? -1 : 1
    Group {
      if let image = Art.bud(family, side: side) {
        Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
      }
    }
    .frame(width: 70, height: 110)
    .rotationEffect(.degrees(out ? Double(sign) * (float ? 10 : 14) : 0))
    .scaleEffect(out ? 0.78 : 0.34)
    .offset(x: out ? sign * 108 : sign * 20, y: out ? (float ? -30 : -22) : -14)
    .opacity(out ? 1 : 0)
    .shadow(color: .black.opacity(out ? 0.35 : 0), radius: 10, y: 8)
    .allowsHitTesting(false)
  }
}

// MARK: - Battery

struct BatteryRing: View {
  var label: String
  var level: Int?
  var charging: Bool
  /// Seconds after the card appears before this ring fills, so the three rings fill one after another.
  var delay = 0.3
  @State private var fill = 0.0
  @State private var shown = 0
  @State private var breathe = false
  var body: some View {
    VStack(spacing: 8) {
      ZStack {
        Circle().stroke(Color.white.opacity(0.12), lineWidth: 4)
        Circle().trim(from: 0, to: fill).stroke(color, style: StrokeStyle(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90))
        Text(level == nil ? "—" : "\(shown)%").font(.system(size: 13, weight: .semibold)).monospacedDigit().foregroundStyle(.white)
        if charging {
          Image(systemName: "bolt.fill").font(.system(size: 10, weight: .bold)).foregroundStyle(.black)
            .frame(width: 16, height: 16).background(Circle().fill(Color.green))
            .scaleEffect(breathe ? 1.08 : 0.94).offset(x: 18, y: -18)
            .transition(.scale.combined(with: .opacity))
        }
      }
      .frame(width: 50, height: 50)
      Text(label).font(.system(size: 11)).foregroundStyle(Color.white.opacity(0.55))
    }
    .animation(.spring(response: 0.3, dampingFraction: 0.7), value: charging)
    .onAppear {
      let target = level ?? 0
      withAnimation(.easeOut(duration: 0.8).delay(delay)) { fill = Double(target) / 100 }
      // Count the number up alongside the ring.
      for step in 0...8 {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay + Double(step) * 0.09) {
          withAnimation(.easeOut(duration: 0.12)) { shown = target * step / 8 }
        }
      }
      if !reduceMotion { withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { breathe = true } }
    }
    .onChange(of: level) { value in
      withAnimation(.easeOut(duration: 0.4)) { fill = Double(value ?? 0) / 100; shown = value ?? 0 }
    }
  }
  private var color: Color { guard let level else { return .clear }; return level <= 20 && !charging ? .red : .green }
}

/// Chinese product names for the card title.
func displayName(_ model: String) -> String {
  switch model {
  case "airpods-1": return "AirPods（第 1 代）"
  case "airpods-2": return "AirPods（第 2 代）"
  case "airpods-3": return "AirPods（第 3 代）"
  case "airpods-4": return "AirPods 4"
  case "airpods-4-anc": return "AirPods 4（主动降噪）"
  case "airpods-pro": return "AirPods Pro"
  case "airpods-pro-2", "airpods-pro-2-usbc": return "AirPods Pro 2"
  case "airpods-pro-3": return "AirPods Pro 3"
  case "airpods-max", "airpods-max-usbc": return "AirPods Max"
  default: return "AirPods"
  }
}

// MARK: - Card

struct PopupCard: View {
  @ObservedObject var model: PopupModel
  var onClose: () -> Void
  var onConnect: () -> Void
  var onAllow: () -> Void
  var body: some View {
    VStack(spacing: 10) {
      if model.permission != nil {
        PermissionPane(model: model, onAllow: onAllow, onLater: onClose)
      } else {
        content
      }
    }
    .padding(.horizontal, model.permission != nil ? 14 : 26).padding(.top, model.permission != nil ? 12 : 18).padding(.bottom, model.permission != nil ? 12 : 20)
    .frame(width: model.permission != nil ? 320 : 420)
    .background(
      RoundedRectangle(cornerRadius: model.permission != nil ? 16 : 30, style: .continuous)
        .fill(model.permission != nil ? AnyShapeStyle(DSH.surface)
              : AnyShapeStyle(LinearGradient(colors: [Color(white: 0.17), Color(white: 0.09)], startPoint: .top, endPoint: .bottom)))
        // Only the translucent notice needs the blur; under the opaque card a lighter material leaks out at the rounded
        // edge as a pale halo.
        .background(RoundedRectangle(cornerRadius: model.permission != nil ? 16 : 30, style: .continuous)
          .fill(model.permission != nil ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Color.clear)))
    )
    .overlay(
      RoundedRectangle(cornerRadius: model.permission != nil ? 16 : 30, style: .continuous)
        .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
    )
    .environment(\.colorScheme, .dark)
    .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
    .scaleEffect(model.shown ? 1 : 0.86)
    .offset(y: model.shown ? 0 : -260)
    .opacity(model.shown ? 1 : 0)
    .animation(model.shown ? .spring(response: 0.34, dampingFraction: 0.82) : .easeIn(duration: 0.22), value: model.shown)
  }

  @ViewBuilder private var content: some View {
    VStack(spacing: 10) {
      ZStack {
        Text(displayName(model.pods.model)).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
        HStack {
          Spacer()
          Button(action: onClose) {
            Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.secondary)
              .frame(width: 30, height: 30).background(Circle().fill(Color.primary.opacity(0.1)))
          }.buttonStyle(.plain)
        }
      }
      ZStack {
        if model.worn {
          WornArtwork(model: model.pods.model).transition(.opacity.combined(with: .scale(scale: 0.9)))
        } else {
          PodsArtwork(model: model.pods.model, lidOpen: model.lidOpen, caseSide: model.pods.caseSide).transition(.opacity)
        }
      }
      .id("\(model.pods.model)-\(model.generation)-\(model.worn)")
      .animation(.easeInOut(duration: 0.25), value: model.worn)
      HStack(spacing: 40) {
        if model.pods.left != nil { BatteryRing(label: "左耳", level: model.pods.left, charging: model.pods.chargingLeft, delay: 0.3).transition(.opacity) }
        if model.pods.right != nil { BatteryRing(label: "右耳", level: model.pods.right, charging: model.pods.chargingRight, delay: 0.42).transition(.opacity) }
        if !model.pods.model.hasPrefix("airpods-max") && !model.worn && model.pods.caseLevel != nil {
          BatteryRing(label: "充电盒", level: model.pods.caseLevel, charging: model.pods.chargingCase, delay: 0.54).transition(.opacity)
        }
      }
      .frame(height: 76)
      .animation(.easeInOut(duration: 0.25), value: [model.pods.left, model.pods.right, model.pods.caseLevel])
      if model.connect != "hidden" && !model.worn {
        Button(action: onConnect) {
          HStack(spacing: 8) {
            if model.connect == "connecting" { ProgressView().controlSize(.small).tint(.white) }
            if model.connect == "connected" { Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)) }
            Text(connectTitle).font(.system(size: 15, weight: .semibold))
          }
          .frame(maxWidth: .infinity).frame(height: 44)
          .foregroundStyle(model.connect == "connected" ? Color.white.opacity(0.85) : Color.black)
          .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(model.connect == "connected" ? Color.white.opacity(0.14) : Color.white))
        }
        .buttonStyle(.plain)
        .disabled(model.connect == "connecting" || model.connect == "connected")
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      Text(hint).font(.system(size: 12)).foregroundStyle(Color.white.opacity(0.5)).padding(.top, 2)
    }
  }
  private var connectTitle: String {
    switch model.connect {
    case "connecting": return "正在连接…"
    case "connected": return "已连接到这台 Mac"
    case "failed": return "没连上，再试一次"
    case "pair": return "在蓝牙设置里配对"
    default: return model.connectName.isEmpty ? "连接到这台 Mac" : "连接「\(model.connectName)」到这台 Mac"
    }
  }

  private var hint: String {
    if model.pods.unpaired {
      // How each case enters pairing mode: AirPods 4 has a touch area on the front, Max a noise-control button.
      let how = model.pods.model.hasPrefix("airpods-4") ? "在充电盒正面轻点两下"
        : model.pods.model.hasPrefix("airpods-max") ? "按住降噪控制按钮" : "按住充电盒背面的按钮"
      return "这副耳机还没和这台 Mac 配对：\(how)，直到灯闪白光"
    }
    if model.worn {
      switch model.pods.gesture {
      case "press": return "已连接 · 捏一下耳机柄，和 DSH 说话"
      case "crown": return "已连接 · 按一下数码表冠，和 DSH 说话"
      default: return "已连接 · 轻点两下耳机，和 DSH 说话"
      }
    }
    switch model.pods.gesture {
    case "press": return "戴上后捏一下耳机柄，就能和 DSH 说话"
    case "crown": return "戴上后按一下数码表冠，就能和 DSH 说话"
    default: return "戴上后轻点两下耳机，就能和 DSH 说话"
    }
  }
}

/// Places the card in the panel: bottom-center for AirPods, top-right for the permission notice.
struct PopupRoot: View {
  @ObservedObject var model: PopupModel
  var onClose: () -> Void
  var onConnect: () -> Void
  var onAllow: () -> Void
  var body: some View {
    PopupCard(model: model, onClose: onClose, onConnect: onConnect, onAllow: onAllow)
      .padding(model.permission != nil ? 12 : 20)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: model.permission != nil ? .topTrailing : .top)
  }
}

final class Popup {
  private let model = PopupModel()
  private var panel: NSPanel?
  private var hideTimer: Timer?
  private var lastShown: [String: Date] = [:]
  var visibleSeconds = 10.0
  var repeatSuppressSeconds = 8.0
  var enabled = true

  /// Show or refresh the card for one lid-open event.
  func show(_ pods: PodsSnapshot, key: String) {
    guard enabled else { return }
    if let last = lastShown[key], Date().timeIntervalSince(last) < repeatSuppressSeconds, model.shown { update(pods); return }
    lastShown[key] = Date()
    ensurePanel()
    model.pods = pods
    model.lidOpen = false
    model.worn = false
    model.connect = "hidden"
    model.permission = nil
    model.generation += 1
    position()
    panel?.orderFrontRegardless()
    DispatchQueue.main.async { self.model.shown = true }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { self.model.lidOpen = true }
    scheduleHide()
    emit("popup", ["state": "shown", "model": pods.model])
  }

  /// Update batteries while the card is visible.
  func update(_ pods: PodsSnapshot) {
    guard model.shown else { return }
    model.pods = pods
    if !model.worn { scheduleHide() }
  }

  /// Pulls the AirPods to this Mac; set by main.
  var onConnect: (() -> Void)?
  /// Microphone card action; set by main.
  var onAllow: (() -> Void)?

  /// Show the microphone card (prompt or denied), replacing any AirPods card.
  func showPermission(_ state: String) {
    ensurePanel()
    model.permission = state
    model.generation += 1
    position()
    panel?.orderFrontRegardless()
    DispatchQueue.main.async { self.model.shown = true }
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in self?.hide(reason: "timeout") }
    emit("popup", ["state": "permission", "permission": state])
  }

  /// Update the microphone card after the user answered.
  func permissionAnswered(_ state: String) {
    guard model.permission != nil else { return }
    withAnimation(.easeInOut(duration: 0.2)) { model.permission = state }
    if state == "granted" { scheduleHide(after: 2.2) }
  }

  /// Show or update the connect button; `hidden` removes it.
  func setConnect(_ state: String, name: String = "") {
    // A connection that happened on its own needs no button.
    if state == "connected" && model.connect == "hidden" { return }
    withAnimation(.easeInOut(duration: 0.2)) {
      model.connect = state
      if !name.isEmpty { model.connectName = name }
    }
    if state == "connected" { scheduleHide(after: 1.6) }
  }

  private func connectTapped() {
    if model.connect == "pair" {
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.BluetoothSettings")!)
      hide(reason: "pair"); return
    }
    guard model.connect == "available" || model.connect == "failed" else { return }
    setConnect("connecting")
    hideTimer?.invalidate()
    onConnect?()
  }

  private var lastWorn = Date.distantPast
  var wornVisibleSeconds = 3.5
  var wornRepeatSuppressSeconds = 20.0

  /// Buds left the case or became the audio output: morph the open card, or show a short worn card.
  func worn(_ pods: PodsSnapshot) {
    guard enabled, !model.worn else { return }
    if !model.shown {
      guard Date().timeIntervalSince(lastWorn) > wornRepeatSuppressSeconds else { return }
      ensurePanel()
      model.generation += 1
      position()
      panel?.orderFrontRegardless()
      model.pods = pods
      model.permission = nil
      model.worn = true
      DispatchQueue.main.async { self.model.shown = true }
    } else {
      model.pods = pods
      model.worn = true
    }
    lastWorn = Date()
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: wornVisibleSeconds, repeats: false) { [weak self] _ in self?.hide(reason: "worn") }
    emit("popup", ["state": "worn", "model": pods.model])
  }

  /// Close the lid on screen, then dismiss.
  func lidClosed() {
    guard model.shown else { return }
    model.lidOpen = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.hide(reason: "lid-closed") }
  }

  func hide(reason: String) {
    guard model.shown else { return }
    hideTimer?.invalidate()
    model.shown = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self, !self.model.shown else { return }
      self.panel?.orderOut(nil)
    }
    emit("popup", ["state": "hidden", "reason": reason])
  }

  private func scheduleHide(after seconds: Double? = nil) {
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: seconds ?? visibleSeconds, repeats: false) { [weak self] _ in self?.hide(reason: "timeout") }
  }

  private func ensurePanel() {
    guard panel == nil else { return }
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 470, height: 480),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true
    let host = NSHostingView(rootView: PopupRoot(model: model, onClose: { [weak self] in self?.hide(reason: "close") },
                                                 onConnect: { [weak self] in self?.connectTapped() },
                                                 onAllow: { [weak self] in self?.onAllow?() }))
    host.frame = panel.contentView!.bounds
    host.autoresizingMask = [.width, .height]
    panel.contentView = host
    self.panel = panel
  }

  /// AirPods cards: top-center, dropping from under the menu bar. Permission notice: top-right like a system notification,
  /// clear of app content such as DSH's composer.
  private func position() {
    guard let panel else { return }
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    guard let frame = screen?.visibleFrame else { return }
    if model.permission != nil {
      panel.setFrameOrigin(NSPoint(x: frame.maxX - panel.frame.width + 4, y: frame.maxY - panel.frame.height + 12))
    } else {
      // Top center, just under the menu bar (and notch): clear of app toolbars and composers at the bottom.
      panel.setFrameOrigin(NSPoint(x: frame.midX - panel.frame.width / 2, y: frame.maxY - panel.frame.height + 8))
    }
  }
}
