/**
 * Outside-table payment lookup: choose a non-placeholder <select> option and
 * click the adjacent 조회 control so the official HTML payment table fills.
 *
 * Privacy: never returns option labels, selected values, names, ids, or
 * placeholders. Callers may only persist counts (non-placeholder option count,
 * whether lookup was clicked, whether body rows appeared).
 *
 * Self-contained for Playwright page.evaluate serialization (no outer closures).
 * Nested helpers must be declared inside each evaluate entrypoint — Playwright
 * serializes only the function you pass. Do not call module-level helpers from
 * discoverOutsideTableLookup / applyOutsideTableLookup.
 *
 * Optional trailing `doc` arg is for Node unit tests only (same pattern as
 * captureSujainTables). Production evaluate uses the page `document`.
 */

/** Empty / whitespace-only option values are placeholders — never label words. */
export function isPlaceholderOptionValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string' && typeof value !== 'number') return true;
  return String(value).trim() === '';
}

/**
 * @returns {{
 *   selectOrdinal: number,
 *   nonPlaceholderOptionIndices: number[],
 *   inquireFound: boolean,
 * }}
 */
export function discoverOutsideTableLookup(doc) {
  const empty = {
    selectOrdinal: -1,
    nonPlaceholderOptionIndices: [],
    inquireFound: false,
  };
  const root = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.querySelectorAll !== 'function') return empty;

  // Inlined: must not call module-level isPlaceholderOptionValue (page.evaluate).
  const isPlaceholderValue = (value) => {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'string' && typeof value !== 'number') return true;
    return String(value).trim() === '';
  };

  const isInsideTable = (el) => {
    if (!el || typeof el !== 'object') return false;
    if (typeof el.closest === 'function') {
      try {
        return Boolean(el.closest('table'));
      } catch {
        // fall through
      }
    }
    let node = el.parentElement ?? el.parentNode ?? null;
    while (node) {
      if (String(node.tagName || '').toLowerCase() === 'table') return true;
      node = node.parentElement ?? node.parentNode ?? null;
    }
    return false;
  };

  /**
   * Same visibility rule as applyOutsideTableLookup — attribute/property hidden
   * plus getComputedStyle display/visibility when available, else inline style.
   */
  const isHiddenControl = (el) => {
    if (!el || typeof el !== 'object') return true;
    if (el.hidden === true) return true;
    if (typeof el.getAttribute === 'function') {
      try {
        if (el.getAttribute('hidden') !== null) return true;
      } catch {
        // ignore
      }
    }
    try {
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(el);
        const display = String(style?.display ?? '').toLowerCase();
        const visibility = String(style?.visibility ?? '').toLowerCase();
        if (display === 'none' || visibility === 'hidden') return true;
      } else if (el.style && typeof el.style === 'object') {
        const display = String(el.style.display ?? '').toLowerCase();
        const visibility = String(el.style.visibility ?? '').toLowerCase();
        if (display === 'none' || visibility === 'hidden') return true;
      }
    } catch {
      // ignore
    }
    return false;
  };

  const controlText = (el) => {
    const tag = String(el?.tagName || '').toLowerCase();
    if (tag === 'input') {
      return String(el.value ?? (typeof el.getAttribute === 'function' ? el.getAttribute('value') : '') ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
    }
    return String(el?.textContent ?? '').replace(/\s+/gu, ' ').trim();
  };

  /**
   * Adjacent inquire only — never payment / contract-change / download actions.
   * Matches short 조회 controls; rejects known action words.
   */
  const isInquireControl = (el) => {
    if (!el || typeof el !== 'object') return false;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const type = String(
        (typeof el.getAttribute === 'function' ? el.getAttribute('type') : null)
          ?? el.type
          ?? 'text',
      ).toLowerCase();
      if (type !== 'button' && type !== 'submit' && type !== 'image') return false;
    } else if (tag !== 'a' && tag !== 'button') {
      return false;
    }
    const text = controlText(el);
    if (!text || text.length > 12) return false;
    if (/납부|다운로드|계약|변경|결제|이체|출력|인쇄|삭제|저장|신청/u.test(text)) return false;
    return /^조회/u.test(text);
  };

  const findAdjacentInquire = (select) => {
    const visit = (el) => {
      if (!el) return null;
      if (isInquireControl(el)) return el;
      if (typeof el.querySelectorAll === 'function') {
        for (const child of Array.from(el.querySelectorAll('a, button, input')).slice(0, 40)) {
          if (isInquireControl(child)) return child;
        }
      }
      return null;
    };

    let sib = select.nextElementSibling ?? null;
    for (let i = 0; i < 8 && sib; i += 1) {
      const hit = visit(sib);
      if (hit) return hit;
      sib = sib.nextElementSibling ?? null;
    }

    const parent = select.parentElement ?? select.parentNode ?? null;
    if (parent && typeof parent.querySelectorAll === 'function') {
      for (const el of Array.from(parent.querySelectorAll('a, button, input')).slice(0, 40)) {
        if (isInquireControl(el)) return el;
      }
    }
    return null;
  };

  const selects = Array.from(root.querySelectorAll('select')).slice(0, 50);
  let outsideOrdinal = -1;
  for (const select of selects) {
    if (isInsideTable(select)) continue;
    if (isHiddenControl(select)) continue;
    outsideOrdinal += 1;
    const inquire = findAdjacentInquire(select);
    if (!inquire) continue;

    const options = select.options
      ?? (typeof select.querySelectorAll === 'function' ? select.querySelectorAll('option') : []);
    const indices = [];
    const list = Array.from(options).slice(0, 50);
    for (let i = 0; i < list.length; i += 1) {
      const opt = list[i];
      const value = opt?.value ?? (typeof opt?.getAttribute === 'function' ? opt.getAttribute('value') : '');
      if (!isPlaceholderValue(value)) indices.push(i);
    }

    return {
      selectOrdinal: outsideOrdinal,
      nonPlaceholderOptionIndices: indices.slice(0, 20),
      inquireFound: true,
    };
  }

  return empty;
}

/**
 * Select one option by index on the discovered outside-table select and click
 * the adjacent 조회 control. Never returns labels or values.
 *
 * Playwright calling convention (production):
 *   page.evaluate(applyOutsideTableLookup, { selectOrdinal, optionIndex })
 *   → applyOutsideTableLookup(plan) with page `document`.
 *
 * Node tests may pass an optional second `doc` (like captureSujainTables).
 *
 * @returns {{ selected: boolean, clicked: boolean }}
 */
export function applyOutsideTableLookup(plan, doc) {
  const empty = { selected: false, clicked: false };
  const root = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.querySelectorAll !== 'function') return empty;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return empty;

  const selectOrdinal = Number(plan.selectOrdinal);
  const optionIndex = Number(plan.optionIndex);
  if (!Number.isInteger(selectOrdinal) || selectOrdinal < 0) return empty;
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return empty;

  // Inlined: must not call module-level isPlaceholderOptionValue (page.evaluate).
  const isPlaceholderValue = (value) => {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'string' && typeof value !== 'number') return true;
    return String(value).trim() === '';
  };

  const isInsideTable = (el) => {
    if (!el || typeof el !== 'object') return false;
    if (typeof el.closest === 'function') {
      try {
        return Boolean(el.closest('table'));
      } catch {
        // fall through
      }
    }
    let node = el.parentElement ?? el.parentNode ?? null;
    while (node) {
      if (String(node.tagName || '').toLowerCase() === 'table') return true;
      node = node.parentElement ?? node.parentNode ?? null;
    }
    return false;
  };

  /**
   * Must match discoverOutsideTableLookup exactly — including getComputedStyle —
   * so selectOrdinal stays aligned when hidden selects precede the visible one.
   */
  const isHiddenControl = (el) => {
    if (!el || typeof el !== 'object') return true;
    if (el.hidden === true) return true;
    if (typeof el.getAttribute === 'function') {
      try {
        if (el.getAttribute('hidden') !== null) return true;
      } catch {
        // ignore
      }
    }
    try {
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(el);
        const display = String(style?.display ?? '').toLowerCase();
        const visibility = String(style?.visibility ?? '').toLowerCase();
        if (display === 'none' || visibility === 'hidden') return true;
      } else if (el.style && typeof el.style === 'object') {
        const display = String(el.style.display ?? '').toLowerCase();
        const visibility = String(el.style.visibility ?? '').toLowerCase();
        if (display === 'none' || visibility === 'hidden') return true;
      }
    } catch {
      // ignore
    }
    return false;
  };

  const controlText = (el) => {
    const tag = String(el?.tagName || '').toLowerCase();
    if (tag === 'input') {
      return String(el.value ?? '').replace(/\s+/gu, ' ').trim();
    }
    return String(el?.textContent ?? '').replace(/\s+/gu, ' ').trim();
  };

  const isInquireControl = (el) => {
    if (!el || typeof el !== 'object') return false;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const type = String(el.type ?? 'text').toLowerCase();
      if (type !== 'button' && type !== 'submit' && type !== 'image') return false;
    } else if (tag !== 'a' && tag !== 'button') {
      return false;
    }
    const text = controlText(el);
    if (!text || text.length > 12) return false;
    if (/납부|다운로드|계약|변경|결제|이체|출력|인쇄|삭제|저장|신청/u.test(text)) return false;
    return /^조회/u.test(text);
  };

  const findAdjacentInquire = (select) => {
    const visit = (el) => {
      if (!el) return null;
      if (isInquireControl(el)) return el;
      if (typeof el.querySelectorAll === 'function') {
        for (const child of Array.from(el.querySelectorAll('a, button, input')).slice(0, 40)) {
          if (isInquireControl(child)) return child;
        }
      }
      return null;
    };
    let sib = select.nextElementSibling ?? null;
    for (let i = 0; i < 8 && sib; i += 1) {
      const hit = visit(sib);
      if (hit) return hit;
      sib = sib.nextElementSibling ?? null;
    }
    const parent = select.parentElement ?? select.parentNode ?? null;
    if (parent && typeof parent.querySelectorAll === 'function') {
      for (const el of Array.from(parent.querySelectorAll('a, button, input')).slice(0, 40)) {
        if (isInquireControl(el)) return el;
      }
    }
    return null;
  };

  const selects = Array.from(root.querySelectorAll('select')).slice(0, 50);
  let outsideOrdinal = -1;
  let target = null;
  for (const select of selects) {
    if (isInsideTable(select)) continue;
    if (isHiddenControl(select)) continue;
    outsideOrdinal += 1;
    if (outsideOrdinal === selectOrdinal) {
      target = select;
      break;
    }
  }
  if (!target) return empty;

  const options = target.options
    ?? (typeof target.querySelectorAll === 'function' ? target.querySelectorAll('option') : []);
  const list = Array.from(options);
  if (optionIndex >= list.length) return empty;
  const opt = list[optionIndex];
  const value = opt?.value ?? '';
  if (isPlaceholderValue(value)) return empty;

  target.selectedIndex = optionIndex;
  if (typeof target.value !== 'undefined') {
    try {
      target.value = value;
    } catch {
      // some fixtures are read-only
    }
  }
  if (typeof target.dispatchEvent === 'function') {
    try {
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      // Event may be missing in Node fixtures
    }
  }

  const inquire = findAdjacentInquire(target);
  if (!inquire) return { selected: true, clicked: false };
  if (typeof inquire.click === 'function') {
    inquire.click();
  } else if (typeof inquire.dispatchEvent === 'function') {
    try {
      inquire.dispatchEvent(new Event('click', { bubbles: true }));
    } catch {
      return { selected: true, clicked: false };
    }
  } else {
    return { selected: true, clicked: false };
  }
  return { selected: true, clicked: true };
}

/** Counts-only lookup diagnostic defaults. */
export function emptyLookupDiagnostic() {
  return {
    lookupNonPlaceholderOptionCount: 0,
    lookupClicked: false,
    lookupBodyRowsAppeared: false,
  };
}
