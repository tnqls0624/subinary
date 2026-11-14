//
//  CardSmsIntents.swift
//  App
//
//  ADR-0038 시제품: iPhone 카드 문자를 App Intent로 전달받아 기존 토큰 경로(ADR-0016)로 보낸다.
//  목적은 "단축어 자동화 → 앱 동작" 경로가 실제 기기에서 도는지 확인하는 것이다.
//  아직 없는 것: HMAC 서명(ADR-0007), 기기 안 카드 문자 판별, 실패 대기열.
//

import AppIntents
import Foundation
import Security

// MARK: - 수집 설정 (키체인)

/// 서버 주소와 수집 토큰을 키체인에 둔다.
/// '첫 잠금 해제 이후' 등급이어야 화면이 잠긴 상태에서 문자가 와도 읽힌다 (ADR-0038 결정 4).
enum CollectSettingsStore {
    static let serverURLAccount = "serverURL"
    static let tokenAccount = "collectToken"
    private static let service = "ai.familymemory.app.collect"

    static func save(_ value: String, account: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var item = base
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    /// 상태 코드도 돌려준다. 재부팅 뒤 첫 잠금 해제 전에는 `errSecInteractionNotAllowed`가 온다.
    static func load(account: String) -> (value: String?, status: OSStatus) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return (nil, status) }
        return (String(data: data, encoding: .utf8), status)
    }
}

// MARK: - 시험용 실행 기록

/// 실기기 시험에서 "언제 실행됐고 결과가 무엇이었나"를 보려는 기록이다.
/// 문자 원문과 보낸 사람은 남기지 않는다 (PRD §3.5 최소 수집). 최근 20건만 둔다.
enum IntentRunLog {
    private static let key = "cardSmsIntent.runLog"

    static func append(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        var lines = UserDefaults.standard.stringArray(forKey: key) ?? []
        lines.append("\(stamp) \(line)")
        UserDefaults.standard.set(Array(lines.suffix(20)), forKey: key)
    }

    static func recent(_ count: Int) -> [String] {
        Array((UserDefaults.standard.stringArray(forKey: key) ?? []).suffix(count))
    }
}

// MARK: - 동작: 수집 설정 저장

@available(iOS 16.0, *)
struct SaveCollectSettingsIntent: AppIntent {
    static var title: LocalizedStringResource = "수집 설정 저장"
    static var description = IntentDescription("서버 주소와 수집 토큰을 이 iPhone에 저장합니다. 처음 한 번만 실행하면 됩니다.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "서버 주소", default: "https://app.subinary.cloud")
    var serverURL: String

    @Parameter(title: "수집 토큰")
    var collectToken: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        var url = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url.removeLast() }
        let token = collectToken.trimmingCharacters(in: .whitespacesAndNewlines)

        guard URL(string: url)?.scheme == "https", !token.isEmpty else {
            return .result(dialog: "서버 주소는 https로 시작해야 하고, 수집 토큰이 비어 있으면 안 돼요.")
        }
        let saved = CollectSettingsStore.save(url, account: CollectSettingsStore.serverURLAccount)
            && CollectSettingsStore.save(token, account: CollectSettingsStore.tokenAccount)
        IntentRunLog.append(saved ? "설정 저장" : "설정 저장 실패")
        return .result(dialog: saved ? "저장했어요." : "저장하지 못했어요.")
    }
}

// MARK: - 동작: 카드 문자 기록

@available(iOS 16.0, *)
struct RecordCardSmsIntent: AppIntent {
    static var title: LocalizedStringResource = "카드 문자 기록"
    static var description = IntentDescription("받은 카드 문자를 모아 가계부로 보냅니다. 단축어 자동화에서 '단축어 입력'을 연결하세요.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "문자 내용")
    var content: String

    @Parameter(title: "보낸 사람")
    var sender: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let body = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            IntentRunLog.append("내용 없음")
            return .result(dialog: "문자 내용이 비어 있어요. 자동화에서 '단축어 입력'을 연결했는지 확인해 주세요.")
        }

        let (serverURL, urlStatus) = CollectSettingsStore.load(account: CollectSettingsStore.serverURLAccount)
        let (token, _) = CollectSettingsStore.load(account: CollectSettingsStore.tokenAccount)
        guard let serverURL, let token,
              let endpoint = URL(string: serverURL + "/v1/mobile-events/card-sms-token") else {
            if urlStatus == errSecInteractionNotAllowed {
                IntentRunLog.append("키체인 잠김 (첫 잠금 해제 전)")
                return .result(dialog: "재부팅 뒤 잠금을 아직 풀지 않아서 설정을 읽을 수 없어요.")
            }
            IntentRunLog.append("설정 없음")
            return .result(dialog: "먼저 '수집 설정 저장'을 실행해 주세요.")
        }

        // 서버 계약: sender 1~100자 필수, content 1~4000자, receivedAt은 UTC ISO 8601 (packages/contracts card-sms.ts)
        let trimmedSender = (sender ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let senderMissing = trimmedSender.isEmpty
        let payload: [String: String] = [
            "eventId": "ios-intent-" + UUID().uuidString,
            "sender": senderMissing ? "ios-intent-unknown" : String(trimmedSender.prefix(100)),
            "content": String(body.prefix(4000)),
            "receivedAt": ISO8601DateFormatter().string(from: Date()),
        ]

        var request = URLRequest(url: endpoint, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            IntentRunLog.append("전송 \(status), 글자 \(body.count)\(senderMissing ? ", 보낸 사람 없음" : "")")

            switch status {
            case 200..<300:
                let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let duplicate = json?["duplicate"] as? Bool ?? false
                return .result(dialog: duplicate ? "이미 받은 문자예요." : "가계부로 보냈어요.")
            case 401:
                return .result(dialog: "수집 토큰이 맞지 않아요. '수집 설정 저장'을 다시 실행해 주세요.")
            default:
                return .result(dialog: "보내지 못했어요. (응답 \(status))")
            }
        } catch {
            IntentRunLog.append("네트워크 오류")
            return .result(dialog: "인터넷에 연결되지 않아 보내지 못했어요.")
        }
    }
}

// MARK: - 동작: 수집 기록 보기 (시험용)

@available(iOS 16.0, *)
struct ShowCollectLogIntent: AppIntent {
    static var title: LocalizedStringResource = "수집 기록 보기"
    static var description = IntentDescription("'카드 문자 기록'이 최근에 언제 실행됐고 결과가 무엇이었는지 보여 줍니다.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let lines = IntentRunLog.recent(8)
        let text = lines.isEmpty ? "아직 기록이 없어요." : lines.joined(separator: "\n")
        return .result(dialog: "\(text)")
    }
}

// MARK: - 단축어 앱에 동작 등록

/// 앱을 설치하면 사용자가 따로 등록하지 않아도 단축어 앱의 '모아' 동작 목록에 나타난다.
@available(iOS 16.0, *)
struct MoaAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: RecordCardSmsIntent(), phrases: ["\(.applicationName)에 카드 문자 기록"])
        AppShortcut(intent: SaveCollectSettingsIntent(), phrases: ["\(.applicationName) 수집 설정 저장"])
        AppShortcut(intent: ShowCollectLogIntent(), phrases: ["\(.applicationName) 수집 기록 보기"])
    }
}
