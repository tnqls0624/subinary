/** 검증 결과를 부모에게 보내고 화면과 콘솔에 남긴다. */
function report(test, status, detail) {
  parent.postMessage({session:'sandbox-verify', test, status, detail}, location.origin);
}
addEventListener('error', event => report('window-error', 'FAIL', event.message));
addEventListener('unhandledrejection', event => report('unhandledrejection', 'FAIL', String(event.reason)));
addEventListener('message', event => {
  if(event.source === parent && event.data?.session === 'sandbox-verify' && event.data.test === 'ack') {
    report('roundtrip', event.data.revision === 7 ? 'PASS' : 'FAIL', event.data);
  }
});
report('ping', 'INFO', {revision:7, userAgent:navigator.userAgent});
