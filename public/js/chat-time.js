/**
 * WarmBuddy ChatTimeModule v1.0
 * ── Canonical chat-message timestamps, display parts, and stable ordering ──
 */

var ChatTimeModule = (function() {
  'use strict';

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function isValidDate(value) {
    return value instanceof Date && !isNaN(value.getTime());
  }

  function parseDateTime(value) {
    if (value instanceof Date) return isValidDate(value) ? new Date(value.getTime()) : null;
    if (value === undefined || value === null || value === '') return null;
    var parsed = new Date(value);
    return isValidDate(parsed) ? parsed : null;
  }

  function parseLocalParts(dateValue, timeValue) {
    var dateMatch = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var timeMatch = String(timeValue || '').match(/(\d{2}):(\d{2})/);
    if (!dateMatch || !timeMatch) return null;
    var parsed = new Date(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      Number(timeMatch[1]),
      Number(timeMatch[2]),
      0,
      0
    );
    return isValidDate(parsed) ? parsed : null;
  }

  function parseFullTime(timeValue) {
    var match = String(timeValue || '').match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
    return match ? parseLocalParts(match[1], match[2]) : null;
  }

  function dateString(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function timeString(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function getTimeInfo(message) {
    message = message || {};
    var parsed = parseDateTime(message.createdAt);
    if (!parsed) parsed = parseLocalParts(message.date, message.time);
    if (!parsed) parsed = parseFullTime(message.time);
    if (!parsed) return null;

    return {
      createdAt: parsed.toISOString(),
      date: dateString(parsed),
      time: timeString(parsed),
      sortValue: parsed.getTime()
    };
  }

  function createMessage(fields, timestamp) {
    var parsed = parseDateTime(timestamp);
    if (!parsed) {
      var existing = getTimeInfo(fields);
      parsed = existing ? new Date(existing.sortValue) : new Date();
    }
    var message = Object.assign({}, fields || {});
    message.createdAt = parsed.toISOString();
    message.date = dateString(parsed);
    message.time = timeString(parsed);
    return message;
  }

  function isOrderBarrier(message) {
    return !message || message.contentType === 'dateDivider' || !getTimeInfo(message);
  }

  function sortTrustedRun(messages, start, end) {
    if (end - start < 2) return;
    var run = messages.slice(start, end).map(function(message, index) {
      return { message: message, index: index, info: getTimeInfo(message) };
    });
    run.sort(function(a, b) {
      return a.info.sortValue - b.info.sortValue || a.index - b.index;
    });
    run.forEach(function(entry, index) {
      messages[start + index] = entry.message;
    });
  }

  // Sort only contiguous messages with trusted complete timestamps. Legacy
  // HH:mm rows and date-divider rows are order barriers, so no message can
  // cross them as a side effect of a later cloud pull or date normalization.
  function sortMessages(messages) {
    var result = Array.isArray(messages) ? messages.slice() : [];
    var runStart = 0;
    for (var i = 0; i <= result.length; i++) {
      if (i === result.length || isOrderBarrier(result[i])) {
        sortTrustedRun(result, runStart, i);
        runStart = i + 1;
      }
    }
    return result;
  }

  function findTrustedRuns(messages) {
    var runs = [];
    var start = 0;
    for (var i = 0; i <= messages.length; i++) {
      if (i === messages.length || isOrderBarrier(messages[i])) {
        if (i > start) {
          var values = messages.slice(start, i).map(function(message) {
            return getTimeInfo(message).sortValue;
          });
          runs.push({
            start: start,
            end: i,
            min: Math.min.apply(Math, values),
            max: Math.max.apply(Math, values)
          });
        }
        start = i + 1;
      }
    }
    return runs;
  }

  function insertionCandidate(messages, run, sortValue) {
    if (sortValue < run.min) {
      return { index: run.start, distance: run.min - sortValue };
    }
    if (sortValue > run.max) {
      return { index: run.end, distance: sortValue - run.max };
    }

    // The run may itself be old/scrambled. Do not repair it here; insert the
    // new row at the stable position before the first strictly later row.
    var index = run.start;
    while (index < run.end && getTimeInfo(messages[index]).sortValue <= sortValue) index++;
    return { index: index, distance: 0 };
  }

  // Existing rows are authoritative: this helper never sorts or rewrites
  // them. A trusted new row is inserted into the nearest trusted contiguous
  // run; unknown/date-divider barriers are never crossed. If no trusted run
  // exists, the row is appended in cloud response order.
  function mergeNewMessages(existingMessages, newMessages) {
    var result = Array.isArray(existingMessages) ? existingMessages.slice() : [];
    var incoming = Array.isArray(newMessages) ? newMessages : [];
    var knownIds = Object.create(null);
    result.forEach(function(message) {
      if (message && message.id) knownIds[message.id] = true;
    });

    incoming.forEach(function(message) {
      if (!message || (message.id && knownIds[message.id])) return;
      var info = getTimeInfo(message);
      if (!info || message.contentType === 'dateDivider') {
        result.push(message);
      } else {
        var runs = findTrustedRuns(result);
        if (!runs.length) {
          result.push(message);
        } else {
          var selected = null;
          runs.forEach(function(run) {
            var candidate = insertionCandidate(result, run, info.sortValue);
            if (!selected || candidate.distance < selected.distance ||
              (candidate.distance === selected.distance && candidate.index < selected.index)) {
              selected = candidate;
            }
          });
          result.splice(selected ? selected.index : result.length, 0, message);
        }
      }
      if (message && message.id) knownIds[message.id] = true;
    });
    return result;
  }

  return {
    createMessage: createMessage,
    getTimeInfo: getTimeInfo,
    sortMessages: sortMessages,
    mergeNewMessages: mergeNewMessages
  };
})();

AppCore.register('chatTime', ChatTimeModule);
