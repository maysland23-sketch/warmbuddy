(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexReceiptContract = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var PROFILE = 'github-mcp-v1';
  var MAX_ACTIVITIES = 64;
  var MAX_SOURCES_PER_ACTIVITY = 8;
  var MAX_RECEIPT_BYTES = 64 * 1024;
  var MAX_URL_BYTES = 2048;
  var MAX_TITLE_BYTES = 256;
  var MAX_REF_ID_BYTES = 128;
  var MAX_ACTIVITY_ID_BYTES = 128;
  var MAX_SAFE_INTEGER = 9007199254740991;
  var REQUEST_ID_PATTERN = /^wr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var ACTIVITY_ID_PATTERN = /^wa_[1-9][0-9]*$/;
  var SOURCE_ID_PATTERN = /^ws_[0-9a-f]{64}$/;
  var REF_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
  var OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  var REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  var PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
  var REF_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
  var COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
  var WEB_ACTIONS = { unknown: true, search: true, open_page: true };
  var GITHUB_ACTIONS = {
    search_repositories: true,
    search_code: true,
    get_file_contents: true,
    list_commits: true
  };
  var PHASES = { started: true, completed: true, interrupted: true };
  var SOURCE_STATES = { available: true, none: true, unknown: true };
  var INTERRUPT_REASONS = { turn_ended: true, round_failed: true, cancelled: true };

  function ReceiptContractError(code, message) {
    this.name = 'ReceiptContractError';
    this.code = code;
    this.message = message || code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ReceiptContractError);
  }
  ReceiptContractError.prototype = Object.create(Error.prototype);
  ReceiptContractError.prototype.constructor = ReceiptContractError;

  function fail(code, message) {
    throw new ReceiptContractError(code, message);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function hasEnumMember(collection, value) {
    return typeof value === 'string' && hasOwn(collection, value) && collection[value] === true;
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function utf8Bytes(value) {
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(value, 'utf8');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function jsonBytes(value) {
    return utf8Bytes(JSON.stringify(value));
  }

  function isBoundedString(value, maxBytes, required) {
    return typeof value === 'string' &&
      value.length <= maxBytes &&
      (required ? value.length > 0 : true) &&
      utf8Bytes(value) <= maxBytes;
  }

  function isFixedId(value, length, pattern) {
    return typeof value === 'string' && value.length === length && pattern.test(value);
  }

  function isActivityId(value) {
    return typeof value === 'string' &&
      value.length <= MAX_ACTIVITY_ID_BYTES &&
      utf8Bytes(value) <= MAX_ACTIVITY_ID_BYTES &&
      ACTIVITY_ID_PATTERN.test(value);
  }

  function isRefId(value) {
    return typeof value === 'string' &&
      value.length <= MAX_REF_ID_BYTES &&
      utf8Bytes(value) <= MAX_REF_ID_BYTES &&
      REF_ID_PATTERN.test(value);
  }

  function isSafeNonNegativeInteger(value) {
    return typeof value === 'number' && isFinite(value) &&
      Math.floor(value) === value && value >= 0 && value <= MAX_SAFE_INTEGER;
  }

  function addOmittedSources(prior, total, kept) {
    var dropped = total - kept;
    if (!isSafeNonNegativeInteger(prior) ||
        !isSafeNonNegativeInteger(dropped) ||
        prior > MAX_SAFE_INTEGER - dropped) {
      fail('RECEIPT_INVALID_OMISSION');
    }
    return prior + dropped;
  }

  function isSafePublicUrl(value) {
    if (!isBoundedString(value, MAX_URL_BYTES, true) || /[\s\u0000-\u001f\u007f\\]/.test(value)) return false;
    if (!/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)) return false;
    try {
      var authority = value.match(/^https?:\/\/([^/?#]+)/i);
      if (!authority || authority[1].indexOf(':') >= 0) return false;
      var parsed = new URL(value);
      var host = String(parsed.hostname || '').toLowerCase();
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username && !parsed.password && !parsed.port &&
        !parsed.search && !parsed.hash && !/^\d+(?:\.\d+){3}$/.test(host) &&
        host.indexOf(':') < 0 && host.indexOf('.') >= 0 &&
        host.charAt(host.length - 1) !== '.' &&
        !/(^|\.)(localhost|local|internal|invalid|test)$/.test(host) &&
        /^[a-z0-9.-]+$/.test(host);
    } catch (_) {
      return false;
    }
  }

  function isGithubConstructedUrl(value) {
    if (!isSafePublicUrl(value)) return false;
    try {
      var parsed = new URL(value);
      return parsed.protocol === 'https:' && String(parsed.hostname).toLowerCase() === 'github.com';
    } catch (_) {
      return false;
    }
  }

  function normalizeContext(context) {
    if (!isObject(context)) return undefined;
    var result = {};
    var owner = context.owner;
    var repo = context.repo;
    var pathValue = context.path;
    var ref = context.ref;
    var commit = context.commit;

    if (typeof owner === 'string' && utf8Bytes(owner) >= 1 && utf8Bytes(owner) <= 39 &&
        OWNER_PATTERN.test(owner) && owner.indexOf('--') < 0) result.owner = owner;
    if (typeof repo === 'string' && utf8Bytes(repo) >= 1 && utf8Bytes(repo) <= 100 &&
        REPO_PATTERN.test(repo)) result.repo = repo;
    if (typeof pathValue === 'string' && utf8Bytes(pathValue) >= 1 && utf8Bytes(pathValue) <= 512 &&
        PATH_PATTERN.test(pathValue) && pathValue.charAt(0) !== '/' &&
        pathValue.charAt(pathValue.length - 1) !== '/') {
      var pathParts = pathValue.split('/');
      if (pathParts.every(function(part) { return part && part !== '.' && part !== '..'; })) {
        result.path = pathValue;
      }
    }
    if (typeof ref === 'string' && utf8Bytes(ref) >= 1 && utf8Bytes(ref) <= 128) {
      var refParts = ref.split('/');
      if (refParts.every(function(part) {
        return REF_SEGMENT_PATTERN.test(part) &&
          part.indexOf('..') < 0 &&
          !part.endsWith('.') &&
          !part.endsWith('.lock');
      })) result.ref = ref;
    }
    if (typeof commit === 'string' && COMMIT_PATTERN.test(commit)) result.commit = commit.toLowerCase();
    return Object.keys(result).length ? result : undefined;
  }

  function assertActivityTransition(existing, incoming) {
    if (!isObject(existing) || !isObject(incoming)) fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
    if (existing.requestId !== incoming.requestId ||
        existing.activityId !== incoming.activityId ||
        existing.tool !== incoming.tool) {
      fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
    }

    var canRefineWebAction = existing.tool === 'web_search' &&
      existing.phase === 'started' && existing.action === 'unknown' &&
      (incoming.phase === 'completed' || incoming.phase === 'interrupted') &&
      (incoming.action === 'search' || incoming.action === 'open_page');
    if (existing.action !== incoming.action && !canRefineWebAction) {
      fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
    }

    if (existing.phase === 'started') {
      if (!hasEnumMember(PHASES, incoming.phase)) fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
      if (incoming.phase === 'started' && existing.outcome !== incoming.outcome) {
        fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
      }
    } else {
      fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
    }

    var optionalFields = ['targetSourceId', 'targetDisplayUrl', 'targetRedacted', 'targetUrl'];
    optionalFields.forEach(function(field) {
      if (hasOwn(existing, field) && hasOwn(incoming, field) && existing[field] !== incoming[field]) {
        fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
      }
    });
    if (hasOwn(existing, 'context') && hasOwn(incoming, 'context')) {
      var contextFields = ['owner', 'repo', 'path', 'ref', 'commit'];
      contextFields.forEach(function(field) {
        if (hasOwn(existing.context, field) && hasOwn(incoming.context, field) &&
            existing.context[field] !== incoming.context[field]) {
          fail('RECEIPT_INCOMPATIBLE_ACTIVITY');
        }
      });
    }
    return true;
  }

  function normalizeSource(source, activity, sourceIds) {
    if (!isObject(source) ||
        !isFixedId(source.requestId, 39, REQUEST_ID_PATTERN) ||
        source.requestId !== activity.requestId ||
        !isActivityId(source.activityId) ||
        source.activityId !== activity.activityId ||
        !isFixedId(source.sourceId, 67, SOURCE_ID_PATTERN) ||
        sourceIds[source.sourceId]) fail('RECEIPT_INVALID_SOURCE');
    if (!isSafePublicUrl(source.displayUrl) || typeof source.redacted !== 'boolean') {
      fail('RECEIPT_INVALID_SOURCE');
    }
    if (source.redacted) {
      if (hasOwn(source, 'url')) fail('RECEIPT_INVALID_SOURCE');
    } else if (!isSafePublicUrl(source.url) || source.url !== source.displayUrl) {
      fail('RECEIPT_INVALID_SOURCE');
    }
    if (activity.tool === 'github_mcp') {
      if (source.linkKind !== 'constructed' || !isGithubConstructedUrl(source.displayUrl) ||
          (!source.redacted && !isGithubConstructedUrl(source.url))) {
        fail('RECEIPT_INVALID_SOURCE');
      }
    } else if (hasOwn(source, 'linkKind')) {
      fail('RECEIPT_INVALID_SOURCE');
    }

    var result = {
      requestId: activity.requestId,
      activityId: activity.activityId,
      sourceId: source.sourceId,
      displayUrl: source.displayUrl,
      redacted: source.redacted
    };
    if (!source.redacted) result.url = source.url;
    if (source.title !== undefined) {
      if (!isBoundedString(source.title, MAX_TITLE_BYTES, false)) fail('RECEIPT_INVALID_SOURCE');
      if (source.title) result.title = source.title;
    }
    if (source.refId !== undefined) {
      if (!isRefId(source.refId)) fail('RECEIPT_INVALID_SOURCE');
      result.refId = source.refId;
    }
    if (activity.tool === 'github_mcp') result.linkKind = 'constructed';
    var context = normalizeContext(source.context);
    if (context) result.context = context;
    sourceIds[source.sourceId] = true;
    return result;
  }

  function normalizeActivity(activity, requestId, activityIds, options) {
    if (!isObject(activity) ||
        !isFixedId(activity.requestId, 39, REQUEST_ID_PATTERN) ||
        activity.requestId !== requestId ||
        !isActivityId(activity.activityId) ||
        activityIds[activity.activityId] ||
        (activity.tool !== 'web_search' && activity.tool !== 'github_mcp') ||
        !hasEnumMember(PHASES, activity.phase) ||
        typeof activity.outcome !== 'string') fail('RECEIPT_INVALID_ACTIVITY');

    if (activity.tool === 'github_mcp') {
      if (options.profile !== PROFILE) {
        fail(options.profile === undefined ? 'RECEIPT_PROFILE_REQUIRED' : 'RECEIPT_PROFILE_UNSUPPORTED');
      }
      if (!hasEnumMember(GITHUB_ACTIONS, activity.action)) fail('RECEIPT_INVALID_ACTIVITY');
      if (activity.phase === 'started' || activity.phase === 'interrupted') {
        if (activity.outcome !== 'unknown') fail('RECEIPT_INVALID_ACTIVITY');
      } else if (activity.outcome !== 'unknown' && activity.outcome !== 'failed') {
        fail('RECEIPT_INVALID_ACTIVITY');
      }
    } else {
      if (!hasEnumMember(WEB_ACTIONS, activity.action) || activity.outcome !== 'unknown') {
        fail('RECEIPT_INVALID_ACTIVITY');
      }
    }

    if (activity.phase === 'completed') {
      if (!hasEnumMember(SOURCE_STATES, activity.sources)) fail('RECEIPT_INVALID_ACTIVITY');
      if (hasOwn(activity, 'reason') &&
          !(activity.tool === 'github_mcp' && activity.outcome === 'failed' && activity.reason === 'tool_failed')) {
        fail('RECEIPT_INVALID_ACTIVITY');
      }
    } else if (activity.phase === 'interrupted') {
      if (!hasEnumMember(INTERRUPT_REASONS, activity.reason)) fail('RECEIPT_INVALID_ACTIVITY');
      if (hasOwn(activity, 'sources')) fail('RECEIPT_INVALID_ACTIVITY');
    } else {
      if (hasOwn(activity, 'sources') || hasOwn(activity, 'reason')) fail('RECEIPT_INVALID_ACTIVITY');
    }

    var targetKeys = ['targetSourceId', 'targetDisplayUrl', 'targetRedacted', 'targetUrl'];
    var hasTarget = targetKeys.some(function(key) { return hasOwn(activity, key); });
    if (hasTarget && !(activity.tool === 'web_search' && activity.action === 'open_page')) {
      fail('RECEIPT_INVALID_ACTIVITY');
    }
    if (hasTarget) {
      if (!isFixedId(activity.targetSourceId, 67, SOURCE_ID_PATTERN) ||
          !isSafePublicUrl(activity.targetDisplayUrl) ||
          typeof activity.targetRedacted !== 'boolean') fail('RECEIPT_INVALID_ACTIVITY');
      if (activity.targetRedacted) {
        if (hasOwn(activity, 'targetUrl')) fail('RECEIPT_INVALID_ACTIVITY');
      } else if (!isSafePublicUrl(activity.targetUrl) || activity.targetUrl !== activity.targetDisplayUrl) {
        fail('RECEIPT_INVALID_ACTIVITY');
      }
    }

    if (!Array.isArray(activity.sourceCards) ||
        activity.sourceCards.length > MAX_SOURCES_PER_ACTIVITY ||
        activity.phase !== 'completed' && activity.sourceCards.length) {
      fail('RECEIPT_INVALID_ACTIVITY');
    }

    var result = {
      requestId: requestId,
      activityId: activity.activityId,
      tool: activity.tool,
      phase: activity.phase,
      action: activity.action,
      outcome: activity.outcome
    };
    if (hasTarget) {
      result.targetSourceId = activity.targetSourceId;
      result.targetDisplayUrl = activity.targetDisplayUrl;
      result.targetRedacted = activity.targetRedacted;
      if (!activity.targetRedacted) result.targetUrl = activity.targetUrl;
    }
    var context = normalizeContext(activity.context);
    if (context) result.context = context;
    if (activity.phase === 'completed') result.sources = activity.sources;
    if ((activity.phase === 'interrupted' || activity.outcome === 'failed') &&
        hasOwn(activity, 'reason')) result.reason = activity.reason;
    var sourceIds = {};
    result.sourceCards = activity.sourceCards.map(function(item) {
      return normalizeSource(item, result, sourceIds);
    });
    activityIds[activity.activityId] = true;
    return result;
  }

  function normalizeRaw(receipts, options) {
    options = options || {};
    if (options.profile !== undefined && options.profile !== PROFILE) fail('RECEIPT_PROFILE_UNSUPPORTED');
    if (!isObject(receipts) || !Array.isArray(receipts.activities) ||
        receipts.activities.length > MAX_ACTIVITIES) fail('RECEIPT_INVALID_ACTIVITY');
    if (receipts.omitted !== undefined && typeof receipts.omitted !== 'boolean') {
      fail('RECEIPT_INVALID_OMISSION');
    }
    if (receipts.omittedSources !== undefined &&
        !isSafeNonNegativeInteger(receipts.omittedSources)) {
      fail('RECEIPT_INVALID_OMISSION');
    }
    if (receipts.omittedSources > 0 && receipts.omitted !== true) fail('RECEIPT_INVALID_OMISSION');

    var requestId = null;
    var activityIds = {};
    var result = { activities: receipts.activities.map(function(item) {
      if (!requestId) requestId = item && item.requestId;
      return normalizeActivity(item, requestId, activityIds, options);
    }) };
    if (receipts.omitted === true) {
      result.omitted = true;
      result.omittedSources = receipts.omittedSources || 0;
    }
    return result;
  }

  function copySourceForCompaction(source) {
    var result = {
      requestId: source.requestId,
      activityId: source.activityId,
      sourceId: source.sourceId,
      displayUrl: source.displayUrl,
      redacted: source.redacted
    };
    if (!source.redacted) result.url = source.url;
    if (source.linkKind === 'constructed') result.linkKind = 'constructed';
    return result;
  }

  function copyForCompaction(canonical) {
    var activities = canonical.activities.map(function(activity) {
      var result = {
        requestId: activity.requestId,
        activityId: activity.activityId,
        tool: activity.tool,
        phase: activity.phase,
        action: activity.action,
        outcome: activity.outcome
      };
      if (activity.phase === 'completed') result.sources = activity.sources;
      if ((activity.phase === 'interrupted' || activity.outcome === 'failed') && hasOwn(activity, 'reason')) {
        result.reason = activity.reason;
      }
      result.sourceCards = activity.sourceCards.map(copySourceForCompaction);
      return result;
    });
    var priorOmittedSources = canonical.omittedSources === undefined ? 0 : canonical.omittedSources;
    if (!isSafeNonNegativeInteger(priorOmittedSources)) fail('RECEIPT_INVALID_OMISSION');
    return {
      activities: activities,
      omitted: true,
      omittedSources: priorOmittedSources
    };
  }

  function compactCanonical(canonical) {
    if (jsonBytes(canonical) <= MAX_RECEIPT_BYTES) return canonical;
    var result = copyForCompaction(canonical);
    var summarySources = result.activities.map(function(activity) {
      var cards = activity.sourceCards;
      activity.sourceCards = [];
      return cards;
    });
    if (jsonBytes(result) > MAX_RECEIPT_BYTES) fail('RECEIPT_CAPACITY_EXCEEDED');
    var allSources = canonical.activities.reduce(function(total, activity) {
      return total + activity.sourceCards.length;
    }, 0);
    var keptSources = 0;
    var priorOmittedSources = result.omittedSources;
    var stop = false;
    for (var activityIndex = 0; activityIndex < canonical.activities.length && !stop; activityIndex++) {
      var sourceCards = summarySources[activityIndex];
      for (var sourceIndex = 0; sourceIndex < sourceCards.length; sourceIndex++) {
        result.activities[activityIndex].sourceCards.push(sourceCards[sourceIndex]);
        keptSources++;
        result.omittedSources = addOmittedSources(priorOmittedSources, allSources, keptSources);
        if (jsonBytes(result) > MAX_RECEIPT_BYTES) {
          result.activities[activityIndex].sourceCards.pop();
          keptSources--;
          result.omittedSources = addOmittedSources(priorOmittedSources, allSources, keptSources);
          stop = true;
          break;
        }
      }
    }
    if (jsonBytes(result) > MAX_RECEIPT_BYTES) fail('RECEIPT_CAPACITY_EXCEEDED');
    return result;
  }

  function normalizeReceiptSet(receipts, options) {
    return compactCanonical(normalizeRaw(receipts, options));
  }

  function compactReceiptSet(receipts, options) {
    return compactCanonical(normalizeRaw(receipts, options));
  }

  return Object.freeze({
    PROFILE: PROFILE,
    MAX_ACTIVITIES: MAX_ACTIVITIES,
    MAX_SOURCES_PER_ACTIVITY: MAX_SOURCES_PER_ACTIVITY,
    MAX_RECEIPT_BYTES: MAX_RECEIPT_BYTES,
    MAX_URL_BYTES: MAX_URL_BYTES,
    MAX_TITLE_BYTES: MAX_TITLE_BYTES,
    MAX_REF_ID_BYTES: MAX_REF_ID_BYTES,
    ReceiptContractError: ReceiptContractError,
    assertActivityTransition: assertActivityTransition,
    normalizeReceiptSet: normalizeReceiptSet,
    compactReceiptSet: compactReceiptSet
  });
}));
