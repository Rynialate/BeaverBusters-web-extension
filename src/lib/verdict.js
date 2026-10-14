/*
 * Interpret API responses.
 *
 * Response shapes come from the server, so this module reads common field
 * conventions (is_scam, status, risk_score, ...) and reduces them to one of
 * four levels: 'scam', 'suspicious', 'safe', 'unknown'. The raw response is
 * always kept so the UI can show exactly what the server said.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.BB = root.BB || {};
  root.BB.verdict = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
  const set = (arr) => new Set(arr.map(norm));

  const SCAM_FLAGS = set(['is_scam', 'scam', 'malicious', 'is_malicious', 'flagged', 'is_flagged', 'blacklisted', 'is_blacklisted', 'blocklisted', 'is_blocklisted', 'phishing', 'is_phishing', 'fraud', 'is_fraud', 'fraudulent', 'dangerous', 'is_dangerous', 'unsafe', 'is_unsafe', 'confirmed_scam', 'known_scam', 'is_known_scam', 'is_drainer', 'drainer', 'block', 'should_block', 'blocked', 'is_blocked']);
  const SAFE_FLAGS = set(['is_safe', 'safe', 'whitelisted', 'is_whitelisted', 'allowlisted', 'is_allowlisted', 'trusted', 'is_trusted', 'legit', 'is_legit', 'legitimate', 'is_legitimate', 'verified_safe']);
  const LISTED_FLAGS = set(['listed', 'is_listed', 'found', 'exists', 'in_database', 'known', 'is_known', 'match', 'matched', 'hit']);
  const STATUS_KEYS = set(['verdict', 'status', 'classification', 'category', 'label', 'result', 'risk_level', 'risklevel', 'threat_level', 'threat', 'level', 'rating', 'reputation', 'state', 'severity', 'assessment', 'risk']);
  const SCORE_KEYS = set(['risk_score', 'score', 'threat_score', 'scam_score', 'scam_probability', 'malicious_score', 'danger_score', 'risk']);
  const INVERSE_SCORE_KEYS = set(['trust_score', 'safety_score', 'reputation_score']);
  const COUNT_KEYS = set(['reports', 'report_count', 'reports_count', 'num_reports', 'total_reports', 'submissions', 'submission_count', 'submissions_count', 'times_reported', 'flags', 'flag_count']);
  const DETAIL_KEYS = ['reason', 'reasons', 'description', 'details', 'detail', 'message', 'notes', 'category', 'categories', 'type', 'tags', 'chain', 'network', 'blockchain', 'source', 'sources', 'first_seen', 'last_seen', 'created_at', 'updated_at', 'reported_at', 'reports', 'report_count', 'status', 'verdict', 'risk_score', 'score', 'risk_level', 'brand', 'target', 'impersonates', 'submitted_by', 'id'];

  const SAFE_STRONG = /\b(safe|clean|legit|legitimate|benign|white[\s_-]?listed|whitelist|allow[\s_-]?listed|allowlist|trusted|not[\s_-]?(?:a[\s_-]?)?scam|non[\s_-]?malicious|false[\s_-]?positive)\b/i;
  const SCAM_RE = /\b(scam|scams|scammer|phish|phishing|malicious|malware|fraud|fraudulent|black[\s_-]?listed|blacklist|block[\s_-]?listed|blocklist|blocked|dangerous|confirmed|critical|severe|high|drainer|rug[\s_-]?pull|ponzi|fake|impersonat\w*|stealer|honeypot)\b/i;
  const SUSPICIOUS_RE = /\b(suspicious|suspect|warn|warning|medium|moderate|pending|review|under[\s_-]?review|reported|unverified|caution|questionable|potential|potentially|possible|risky|elevated|investigating)\b/i;
  const SAFE_WEAK = /\b(low|none|ok|good|harmless|verified|minimal|negligible)\b/i;
  const UNKNOWN_RE = /\b(unknown|not[\s_-]?found|unlisted|no[\s_-]?data|unrated|unclassified|unchecked)\b/i;

  const LABELS = {
    scam: 'Known scam',
    suspicious: 'Suspicious',
    safe: 'No threats found',
    unknown: 'Not in database',
    error: 'Check failed',
  };

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /** Unwrap common envelopes ({data: {...}}, {result: {...}}, [first]). */
  function unwrap(data) {
    let cur = data;
    for (let i = 0; i < 3; i++) {
      if (Array.isArray(cur)) {
        if (!cur.length) return { empty: true };
        cur = cur[0];
        continue;
      }
      if (!isPlainObject(cur)) return cur;
      const keys = Object.keys(cur);
      const wrapper = ['data', 'result', 'results', 'item', 'record', 'entry', 'match', 'response'].find(
        (k) => k in cur && (isPlainObject(cur[k]) || Array.isArray(cur[k]))
      );
      if (wrapper && keys.length <= 4) {
        // Envelope siblings (status: "ok", success, meta, ...) describe the
        // HTTP exchange, not the entity, so they are dropped.
        const inner = cur[wrapper];
        if (Array.isArray(inner)) {
          if (!inner.length) return { empty: true };
          cur = isPlainObject(inner[0]) ? inner[0] : { value: inner[0] };
        } else {
          cur = inner;
        }
        continue;
      }
      return cur;
    }
    return cur;
  }

  /** Breadth-first walk over an object's entries (depth-limited). */
  function entries(obj, maxDepth) {
    const out = [];
    const queue = [[obj, 0, '']];
    while (queue.length) {
      const [node, depth, prefix] = queue.shift();
      if (!isPlainObject(node)) continue;
      for (const k of Object.keys(node)) {
        const v = node[k];
        out.push({ key: k, nkey: norm(k), value: v, depth, path: prefix ? prefix + '.' + k : k });
        if (isPlainObject(v) && depth < maxDepth) queue.push([v, depth + 1, prefix ? prefix + '.' + k : k]);
      }
    }
    return out;
  }

  function truthy(v) {
    return v === true || v === 1 || v === 'true' || v === 'yes' || v === 'Y';
  }
  function falsy(v) {
    return v === false || v === 0 || v === 'false' || v === 'no' || v === 'N';
  }

  function classifyText(text) {
    if (typeof text !== 'string' || !text) return null;
    if (SAFE_STRONG.test(text)) return 'safe';
    if (SCAM_RE.test(text)) return 'scam';
    if (SUSPICIOUS_RE.test(text)) return 'suspicious';
    if (SAFE_WEAK.test(text)) return 'safe';
    if (UNKNOWN_RE.test(text)) return 'unknown';
    return null;
  }

  function toPercent(n) {
    if (typeof n === 'string' && n.trim() !== '' && !isNaN(Number(n))) n = Number(n);
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
    if (n <= 1) return Math.round(n * 100);
    if (n <= 100) return Math.round(n);
    return null;
  }

  /**
   * Reduce an API response to a verdict.
   * @param {*} data parsed response body
   * @param {number} httpStatus
   */
  function normalizeVerdict(data, httpStatus) {
    const result = { level: 'unknown', label: LABELS.unknown, score: null, reasons: [], fields: [], raw: data, httpStatus: httpStatus || 200 };

    if (httpStatus === 404) {
      result.reasons.push('Not found in the database (HTTP 404)');
      return result;
    }

    const body = unwrap(data);
    if (typeof body === 'boolean') {
      // e.g. GET /is-scam?domain= -> true
      result.level = body ? 'scam' : 'safe';
      result.label = LABELS[result.level];
      return result;
    }
    if (typeof body === 'string') {
      const level = classifyText(body);
      if (level) result.level = level;
      result.label = LABELS[result.level];
      result.reasons.push(body.slice(0, 200));
      return result;
    }
    if (!isPlainObject(body)) return result;
    if (body.empty) {
      result.reasons.push('No matching records');
      return result;
    }

    const all = entries(body, 2);
    let level = null;

    // 1. Explicit scam / safe booleans
    for (const e of all) {
      if (SCAM_FLAGS.has(e.nkey) && truthy(e.value)) {
        level = 'scam';
        result.reasons.push(`${e.path}: ${e.value}`);
        break;
      }
    }
    if (!level) {
      for (const e of all) {
        if (SAFE_FLAGS.has(e.nkey) && truthy(e.value)) {
          level = 'safe';
          result.reasons.push(`${e.path}: ${e.value}`);
          break;
        }
      }
    }

    // An explicit "is_scam: false" outranks any label; a status can still mark it suspicious.
    const notScam = level ? null : all.find((e) => SCAM_FLAGS.has(e.nkey) && falsy(e.value));

    // 2. Status / verdict strings (shallowest first; free-form "category" last)
    if (!level) {
      const statusEntries = all.filter((e) => STATUS_KEYS.has(e.nkey));
      statusEntries.sort((a, b) => (a.nkey === 'category') - (b.nkey === 'category'));
      for (const e of statusEntries) {
        const text = Array.isArray(e.value) ? e.value.filter((x) => typeof x === 'string').join(' ') : e.value;
        let l = classifyText(text);
        if (l && notScam && l !== 'suspicious') l = null;
        if (l) {
          level = l;
          result.reasons.push(`${e.path}: ${text}`);
          break;
        }
      }
    }

    // 3. Numeric risk score
    if (!level && notScam) {
      level = 'safe';
      result.reasons.push(`${notScam.path}: ${notScam.value}`);
    }
    for (const e of all) {
      const isInverse = INVERSE_SCORE_KEYS.has(e.nkey);
      if (!SCORE_KEYS.has(e.nkey) && !isInverse) continue;
      let pct = toPercent(e.value);
      if (pct === null) continue;
      if (isInverse) pct = 100 - pct;
      result.score = pct;
      if (!level) {
        level = pct >= 75 ? 'scam' : pct >= 40 ? 'suspicious' : 'safe';
        result.reasons.push(`${e.path}: ${e.value}`);
      }
      break;
    }

    // 4. Report counts / listing flags
    if (!level) {
      const count = all.find((e) => COUNT_KEYS.has(e.nkey) && ((typeof e.value === 'number' && e.value > 0) || (Array.isArray(e.value) && e.value.length > 0)));
      if (count) {
        level = 'suspicious';
        result.reasons.push(`${count.path}: ${Array.isArray(count.value) ? count.value.length : count.value}`);
      }
    }
    if (!level) {
      const listed = all.find((e) => LISTED_FLAGS.has(e.nkey) && (truthy(e.value) || falsy(e.value)));
      if (listed) {
        // Being listed without any verdict field: warn rather than block.
        level = truthy(listed.value) ? 'suspicious' : 'unknown';
        result.reasons.push(`${listed.path}: ${listed.value}`);
      }
    }

    result.level = level || 'unknown';
    result.label = LABELS[result.level];
    if (result.level === 'suspicious' && !result.reasons.some((r) => SUSPICIOUS_RE.test(r) || SCAM_RE.test(r))) result.label = 'Listed / reported';
    result.fields = summarize(body);
    return result;
  }

  function scalarText(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== 'object')) return v.join(', ');
      return v.length + ' item' + (v.length === 1 ? '' : 's');
    }
    if (typeof v === 'object') return '';
    return String(v);
  }

  /** Pick up to `max` human-useful scalar fields for display. */
  function summarize(obj, max) {
    const limit = max || 12;
    const out = [];
    if (!isPlainObject(obj)) return out;
    const all = entries(obj, 1);
    const used = new Set();
    const push = (e) => {
      const text = scalarText(e.value);
      if (!text || used.has(e.path)) return;
      used.add(e.path);
      out.push({ key: e.path, value: text.length > 300 ? text.slice(0, 300) + '…' : text });
    };
    for (const k of DETAIL_KEYS) {
      const e = all.find((x) => x.nkey === norm(k));
      if (e) push(e);
      if (out.length >= limit) return out;
    }
    for (const e of all) {
      if (out.length >= limit) break;
      push(e);
    }
    return out;
  }

  const LIST_KEYS = ['items', 'results', 'data', 'submissions', 'reports', 'records', 'entries', 'rows', 'matches', 'wallets', 'addresses', 'domains'];

  /** Find the main list in a list-style response. */
  function extractList(data) {
    if (Array.isArray(data)) return data;
    if (!isPlainObject(data)) return [];
    for (const k of LIST_KEYS) {
      if (Array.isArray(data[k])) return data[k];
      if (isPlainObject(data[k])) {
        const inner = extractList(data[k]);
        if (inner.length) return inner;
      }
    }
    // Unknown key: only accept an array of records, not e.g. a "tags" list.
    const firstArray = Object.values(data).find((v) => Array.isArray(v) && v.length && v.every(isPlainObject));
    return firstArray || [];
  }

  /** True when the response is a (possibly empty) list rather than a single record. */
  function isListResponse(data) {
    if (Array.isArray(data)) return true;
    if (!isPlainObject(data)) return false;
    return LIST_KEYS.some((k) => Array.isArray(data[k]) || (isPlainObject(data[k]) && isListResponse(data[k])));
  }

  /** Pull wallet addresses out of an extraction / batch response. */
  function extractAddresses(data) {
    const list = extractList(data);
    const out = [];
    for (const item of list) {
      if (typeof item === 'string') out.push({ address: item, chain: '' });
      else if (isPlainObject(item)) {
        const address = item.address || item.wallet || item.wallet_address || item.walletAddress || item.value || item.addr;
        if (typeof address === 'string') out.push({ address, chain: item.chain || item.network || item.blockchain || item.coin || item.currency || '', record: item });
      }
    }
    return out;
  }

  /** Extract a submission / report identifier from a create response. */
  function extractId(data) {
    const body = unwrap(data);
    if (!isPlainObject(body)) return null;
    for (const k of ['id', 'submission_id', 'submissionId', 'report_id', 'reportId', 'uuid', 'reference', 'reference_id', 'ticket', 'ticket_id', 'tracking_id', 'case_id']) {
      if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'object') return String(body[k]);
    }
    return null;
  }

  /** Describe one submission record for list display. */
  function describeRecord(item) {
    if (!isPlainObject(item)) return { title: String(item), status: '', date: '', id: null, fields: [] };
    const title =
      item.domain || item.url || item.hostname || item.website || item.address || item.wallet || item.wallet_address || item.value || item.target || item.indicator || item.title || item.name || '(record)';
    const status = item.status || item.state || item.verdict || item.review_status || item.result || '';
    const date = item.updated_at || item.created_at || item.submitted_at || item.reported_at || item.date || item.timestamp || '';
    return {
      title: String(title),
      status: typeof status === 'object' ? '' : String(status),
      date: typeof date === 'object' ? '' : String(date),
      id: extractId(item),
      kind: item.type || item.kind || item.target_type || '',
      fields: summarize(item, 8),
    };
  }

  /** Human readable error from an error response body. */
  function errorMessage(data, status, statusText) {
    if (isPlainObject(data)) {
      const d = data.detail !== undefined ? data.detail : data.message !== undefined ? data.message : data.error !== undefined ? data.error : data.errors;
      if (typeof d === 'string') return d;
      if (Array.isArray(d)) {
        return d
          .map((x) => (isPlainObject(x) ? (x.loc ? x.loc.filter((p) => p !== 'body').join('.') + ': ' : '') + (x.msg || x.message || JSON.stringify(x)) : String(x)))
          .join('; ');
      }
      if (isPlainObject(d)) return d.message || d.msg || JSON.stringify(d);
    }
    if (typeof data === 'string' && data && data.length < 300 && !/^\s*</.test(data)) return data;
    return `HTTP ${status}${statusText ? ' ' + statusText : ''}`;
  }

  /** Records from a submission lookup response (list, single record, or {found:false}). */
  function submissionRecords(data) {
    const list = extractList(data);
    if (list.length || isListResponse(data)) return list.filter((x) => x !== null && x !== undefined);
    const rec = unwrap(data);
    if (!isPlainObject(rec) || rec.empty) return [];
    const flag = ['found', 'exists', 'submitted', 'reported', 'listed'].find((k) => typeof rec[k] === 'boolean');
    if (flag && rec[flag] === false) return [];
    return [rec];
  }

  return { LABELS, normalizeVerdict, summarize, extractList, isListResponse, submissionRecords, extractAddresses, extractId, describeRecord, errorMessage, classifyText, unwrap };
});
