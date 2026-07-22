import UIKit
import Capacitor
// ⚠️ FirebaseCore/FirebaseMessaging는 SPM 의존성 추가 후 컴파일된다.
//    Xcode > File > Add Package Dependencies > https://github.com/firebase/firebase-ios-sdk
//    에서 FirebaseMessaging을 App 타겟에 추가하기 전에는 빌드가 실패한다.
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Firebase 초기화(GoogleService-Info.plist 필요) + FCM 토큰 델리게이트 등록.
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused while the application was inactive.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate.
    }

    // APNs 등록 성공 → 원시 토큰을 FCM에 전달(FCM이 APNs↔FCM 매핑을 수행).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
        // ⚠️ Capacitor 기본 동작은 여기서 APNs 토큰을 registration 이벤트로 발행한다.
        //    우리 서버는 FCM HTTP v1로 발송하므로 APNs 토큰이 아니라 FCM 토큰이 필요하다.
        //    따라서 이 경로는 두지 않고, 아래 MessagingDelegate에서 FCM 토큰을 브리지한다.
    }

    // APNs 등록 실패 → Capacitor 실패 이벤트 전달(웹의 registrationError 리스너).
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Keep for App API url-open tracking.
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity (Universal Links 포함).
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

extension AppDelegate: MessagingDelegate {
    // FCM 등록 토큰 수신 → Capacitor push-notifications의 registration 이벤트로 전달.
    // 이로써 웹 native.ts의 "registration" 리스너가 (APNs가 아니라) FCM 토큰을 받아
    // 서버에 등록하고, FcmService가 안드로이드와 동일 경로로 발송한다.
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: fcmToken
        )
    }
}
