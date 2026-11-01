# Shinhan loan collector — local, experimental

This dependency-free Manifest V3 extension prepares **one user-selected loan observation** for the FMA import review flow. It reads the currently selected tab only after a popup button click, offers eligible rows separately, and downloads one sanitized JSON file only after selection, value confirmation, and a separate export click. It never sums rows or submits anything to FMA or the bank.

**Status:** the current account-list screen and the labels `계좌번호`, `대출잔액`, and `만기일` were observed through accessibility inspection. The actual bank DOM and selectors have **not** been inspected or verified. The HTML layouts below are synthetic fixtures, not saved bank pages. This implementation can reject the real bank layout; do not loosen validation or substitute historical balances when that happens. No live collection, extension installation, login, bank request, or real export was performed to develop this package.

## Future manual use

These steps describe a future user action; creating these files does not install or run the extension.

1. Review this directory. In Chrome or another compatible Chromium browser, open the extensions page, enable developer mode, and choose **Load unpacked**, selecting this directory. No build or package installation is needed.
2. Sign in to the bank yourself and navigate to the current **대출계좌명세** screen at exactly `https://bank.shinhan.com`. This tool does not perform login or authentication steps.
3. With that tab selected, open the extension popup and click **현재 탭에서 확인**.
4. Select one eligible 중도금 or 전세 row. Compare the displayed last four digits, current outstanding principal, and maturity date with the bank screen. Even a single eligible row must be explicitly selected.
5. Confirm the values and click **선택한 대출 JSON 저장**. The file is named `shinhan-loan-capture.json`. Saving the file is a separate user action; the collector does not upload it.
6. Use FMA's loan-import review flow to import and review that file. `capturedAt` is the browser observation time, **not** the bank's accounting date. `bankAsOfDate` is always `null` because this screen does not establish it.

Opening a popup does not read the tab. Closing it discards its in-memory candidates. A downloaded file remains on disk until the user manages it. Its balances and account fingerprint remain sensitive financial information.

## Supported layout and rejection rules

- Exact origin `https://bank.shinhan.com`, no URL credentials, and top-level document only. The extension does not enter iframes or request frame permissions. An account table that only exists inside an iframe is unsupported, including same-origin iframes.
- Exact document title `대출계좌명세 | 신한은행 개인뱅킹`, or `인터넷뱅킹 메인 | 신한은행 개인뱅킹` plus an exact visible `대출계좌명세` heading/caption. Surrounding title whitespace is ignored. Known transaction-history, repayment-history, and rate-page headings are rejected.
- Exactly one visible table with one simple, visible header row made of `th` cells. Required semantic columns must occur exactly once: `계좌번호`, `대출잔액`, `만기일`. Header whitespace used for wrapping is ignored. Documented balance-header variants are `대출잔액(원)` and `대출잔액(KRW)`; these provide explicit KRW evidence. `대출한도`, `대출실행금액`, substring lookalikes, and historical transaction columns are never alternate balance sources.
- All visible data rows must have the same number of visible cells as the header and have no row/column spans. Multiple candidate tables, repeated semantic headers, hidden data cells, summary rows with merged cells, and malformed layouts stop the entire capture. Fully hidden rows/tables are ignored.
- A candidate row's **visible row text**, without requiring a particular product-column name, must contain exactly one of `중도금` or `전세`. Neither label means the row is ineligible; both labels mean the capture is ambiguous. Only that row's mapped account, balance, and maturity cells are read for those values. Row text and product labels never leave the collector.
- The mapped account cell must contain only an unmasked full account number: 10–20 ASCII digits, optionally separated by hyphens. An account cell containing additional labels, masked digits, address text, or multiple accounts is unsupported. Repeated eligible accounts are rejected. Account formatting is normalized only for fingerprinting.
- KRW must be explicit: a documented balance-header variant; `₩`, `KRW`, or `원` in the balance cell; or an exact visible unit label in the table caption/immediately preceding element. Supported unit labels are `단위: 원` / `(단위: 원)`, optionally prefixed by `대출계좌명세`, with a full-width colon also accepted. Nearby arbitrary page text is not a unit source.
- Balances are nonnegative whole-won decimal **strings**, at most 20 digits. Proper thousands separators are removed without converting the value through JavaScript `Number`. Zero remains `"0"`; empty, signed, decimal, exponential, incorrectly grouped, foreign-currency, and overlong values are rejected.
- Maturity dates accept `YYYY-MM-DD`, `YYYY.MM.DD`, or `YYYY/MM/DD` with two-digit month/day, and must be real calendar dates (including leap-year rules). Only the explicit indicators `-`, `없음`, and `해당없음` map to `null`. A blank cell fails. Exported dates are canonical `YYYY-MM-DD`.

Surrounding rendered-cell whitespace is trimmed before parsing, and canonical outputs contain no surrounding whitespace. All value validators require a full-string match; a trailing newline cannot bypass a `$` regular-expression anchor in exported fields. Unknown errors are reduced to a fixed safe code, never their raw message.

## Data and trust boundary

The JSON matches `packages/contracts/src/loan-import.ts` (`shinhanLoanCaptureSchema`) and contains only:

```text
formatVersion, provider, source, origin, pageKind, capturedAt,
accountFingerprint, accountLast4, loanType, outstandingPrincipalKrw,
maturityDate, bankAsOfDate
```

The account fingerprint is lowercase SHA-256 of this UTF-8 byte sequence, with literal NUL separators:

```text
fma:shinhan:loan-account:v1\0https://bank.shinhan.com\0<digits-only full account>
```

The fingerprint is **pseudonymous, not anonymous or encrypted**. It enables stable account matching, including distinguishing two accounts with the same last four digits. It can be linked across captures and may be guessed if account-number candidates are known. Treat it and the export as private financial data. The full account number exists transiently while the collector computes the fingerprint; it is never returned to the popup, logged, stored, or exported. Product names, addresses, raw DOM, arbitrary page URLs, and other page text are not included in the result.

This is an unsigned, user-reviewed browser observation. Origin and structure checks cannot prove bank ownership, account ownership, bank authenticity of a balance, freshness of a displayed balance, or protection from a compromised browser/page. The import review remains necessary. The captured browser time is not a bank valuation timestamp.

The manifest grants only `activeTab` and `scripting`. There are no host permissions, content scripts, background worker, cookie access, authentication/credential access, token access, storage API, clipboard access, network client, telemetry, automatic login, or schedule. The popup's CSP disables connections. DOM extraction uses a self-contained function in the default isolated scripting world and does not click bank controls, mutate the bank DOM, submit forms, or navigate the bank. The only file action is the user's explicit popup export through a local Blob URL.

## Offline verification

Run from the repository root when the repository's serialized verification guard permits it:

```sh
node --test tools/shinhan-loan-collector/test/*.test.mjs
```

No dependencies, build, browser, extension installation, bank credentials, or network are needed. `test/fixtures/*.html` contain synthetic values only. `test/synthetic-dom.mjs` implements the minimal read-only table/visibility interface needed to extract from those fixture files; it is intentionally not a complete browser DOM. Tests cover exact-field selection, precision, explicit KRW evidence, real dates, zero versus missing, origin/frame/page rejection, ambiguous layouts, hidden rows, masked accounts, per-row loan selection, safe errors, data minimization, fingerprint stability/domain separation, and strict export rejection. A VM test serializes and executes the injection function in a fresh context to detect accidental module-scope dependencies. Static tests pin extension permissions and reject network/storage/logging surfaces.

These tests are synthetic verification, not proof that the current bank DOM is compatible. Any future real-browser probe, extension installation, or collection requires the user's separate authorization and should preserve this narrow read-only boundary.
