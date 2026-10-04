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

  function getTimeInfo(message, fallbackDate) {
    message = message || {};
    var parsed = parseDateTime(message.createdAt);
    if (!parsed) parsed = parseLocalParts(message.date, message.time);
    if (!parsed) parsed = parseFullTime(message.time);
    if (!parsed && fallbackDate) parsed = parseLocalParts(fallbackDate, message.time);
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

  function sortMessages(messages, fallbackDate) {
    return (Array.isArray(messages) ? messages : [])
      .map(function(message, index) {
        return { message: message, index: index, info: getTimeInfo(message, fallbackDate) };
      })
      .sort(function(a, b) {
        if (!a.info || !b.info) return a.index - b.index;
        return a.info.sortValue - b.info.sortValue || a.index - b.index;
      })
      .map(function(entry) { return entry.message; });
  }

  return {
    createMessage: createMessage,
    getTimeInfo: getTimeInfo,
    sortMessages: sortMessages
  };
})();

AppCore.register('chatTime', ChatTimeModule);
