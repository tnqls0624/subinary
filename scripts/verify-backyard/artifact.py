"""export 파일 일치와 OTA와 같은 Info-ZIP 압축 크기를 검증한다."""
import hashlib
import json
import subprocess
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'apps/web/public'
OUT = ROOT / 'apps/web/out'
EVIDENCE = ROOT / 'docs/evidence/backyard-s6'


class References(HTMLParser):
    """게임 entry의 외부 script와 CSS 경로를 수집한다."""
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'script' and 'src' in values:
            self.paths.append(values['src'])
        if tag == 'link' and values.get('rel') == 'stylesheet':
            self.paths.append(values['href'])


def main():
    """바이트 일치를 강제한 뒤 raw/ZIP의 기준 대비 증가량을 기록한다."""
    entry = PUBLIC / 'miniapps/backyard/index.html'
    parser = References()
    parser.feed(entry.read_text())
    files = [entry] + [(entry.parent / path).resolve() for path in parser.paths]
    manifest = []
    for source in files:
        relative = source.relative_to(PUBLIC)
        actual = (OUT / relative).read_bytes()
        assert actual == source.read_bytes(), f'원본 불일치: {relative}'
        manifest.append({'path': str(relative), 'bytes': len(actual), 'sha256': hashlib.sha256(actual).hexdigest()})
    assert (OUT / 'play/app/index.html').is_file()
    raw_files = [path for path in OUT.rglob('*') if path.is_file()]
    raw = sum(path.stat().st_size for path in raw_files)
    bundle = subprocess.run(['zip', '-qr', '-', '.'], cwd=OUT, capture_output=True, check=True).stdout
    artifact = Path('/tmp/backyard-s6-ota.zip')
    artifact.write_bytes(bundle)
    result = {'files': len(raw_files), 'rawBytes': raw, 'zipBytes': len(bundle),
              'baselineRawBytes': 3864248, 'baselineZipBytes': 1123874,
              'rawDeltaBytes': raw - 3864248, 'zipDeltaBytes': len(bundle) - 1123874,
              'rawDeltaPercent': round((raw / 3864248 - 1) * 100, 2),
              'zipDeltaPercent': round((len(bundle) / 1123874 - 1) * 100, 2),
              'gameAndBridgeRawBytes': sum(item['bytes'] for item in manifest),
              'zipPath': str(artifact), 'zipSha256': hashlib.sha256(bundle).hexdigest(),
              'publicByteEquality': manifest}
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / 'artifact-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
