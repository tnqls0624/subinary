// Deliberately small, read-only fixture DOM. This is not a browser or a general HTML parser.
// It implements only the visible table APIs used by collector.js; no network or packages.
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
})[entity]);
const styles = (node) => Object.fromEntries((node.getAttribute('style') ?? '').split(';')
  .map((item) => item.split(':').map((part) => part.trim())).filter((pair) => pair.length === 2));
const ownHidden = (node) => node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
  || styles(node).display === 'none' || ['hidden', 'collapse'].includes(styles(node).visibility)
  || styles(node).opacity === '0';

class FixtureElement {
  constructor(tagName, attrs, parent) {
    this.tagName = tagName.toUpperCase();
    this.attrs = attrs;
    this.parent = parent;
    this.nodes = [];
  }
  get parentElement() { return this.parent?.tagName === '#DOCUMENT' ? null : this.parent; }
  get children() { return this.nodes.filter((node) => typeof node !== 'string'); }
  get previousElementSibling() {
    const siblings = this.parent?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get caption() { return this.tagName === 'TABLE' ? this.children.find((node) => node.tagName === 'CAPTION') ?? null : null; }
  get innerText() {
    if (ownHidden(this)) return '';
    return this.nodes.map((node) => typeof node === 'string' ? node : node.innerText).join(' ');
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  getClientRects() { return ownHidden(this) ? [] : [{ width: 200, height: 20 }]; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.tagName.toLowerCase() === selector) return node;
    return null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((part) => part.trim());
    const matches = (node) => selectors.some((part) => part === '[role="heading"]'
      ? node.getAttribute('role') === 'heading' : node.tagName.toLowerCase() === part);
    const found = [];
    const visit = (parent) => {
      for (const child of parent.children) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

export function fixtureDocument(html, { url = 'https://bank.shinhan.com/index.jsp', topLevel = true } = {}) {
  const document = new FixtureElement('#document', {}, null);
  const stack = [document];
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/gu) ?? []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (token.startsWith('<')) {
      const match = /^<([a-z][a-z0-9-]*)([\s\S]*?)\/?\s*>$/iu.exec(token);
      if (!match) throw new Error('Unsupported fixture HTML');
      const attrs = {};
      for (const attr of match[2].matchAll(/([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/giu)) {
        attrs[attr[1]] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
      const node = new FixtureElement(match[1], attrs, stack.at(-1));
      stack.at(-1).nodes.push(node);
      if (!['meta', 'br', 'input', 'link', 'hr', 'img'].includes(match[1].toLowerCase()) && !token.endsWith('/>')) stack.push(node);
    } else stack.at(-1).nodes.push(decode(token));
  }
  if (stack.length !== 1) throw new Error('Unbalanced fixture HTML');
  const view = { getComputedStyle: (element) => ({ display: 'block', visibility: 'visible', opacity: '1', ...styles(element) }) };
  view.self = view;
  view.top = topLevel ? view : {};
  document.defaultView = Object.freeze(view);
  document.location = Object.freeze({ href: url });
  document.title = document.querySelectorAll('title')[0]?.innerText.trim() ?? '';
  const freeze = (node) => {
    node.children.forEach(freeze);
    Object.freeze(node.nodes);
    Object.freeze(node.attrs);
    Object.freeze(node);
  };
  freeze(document);
  return document;
}

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function tableHtml({
  headers = ['상품', '계좌번호', '대출잔액', '만기일'],
  rows = [['합성 중도금 대출', '123-456-789012', '12,345 원', '2030.02.28']],
  caption = '', tableAttributes = '',
} = {}) {
  return `<table ${tableAttributes}>${caption ? `<caption>${escape(caption)}</caption>` : ''}<thead><tr>${headers.map((value) => `<th>${escape(value)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
export function pageHtml({ title = '대출계좌명세 | 신한은행 개인뱅킹', heading = '대출계좌명세', body = tableHtml() } = {}) {
  return `<!doctype html><html><head><title>${escape(title)}</title></head><body><h1>${escape(heading)}</h1>${body}</body></html>`;
}
