'use strict';

const { randomUUID } = require('node:crypto');

class EmailSendError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name || 'email_send_error';
    this.httpStatus = options.httpStatus || 500;
    this.clientMessage = options.clientMessage || null;
    this.resendStatus = options.resendStatus ?? null;
  }
}

function createResendError(payload, status) {
  const details = payload && typeof payload.error === 'object' ? payload.error : payload || {};
  return new EmailSendError(
    details.message || payload?.message || `Resend API returned ${status}`,
    {
      name: details.name || payload?.name || `resend_http_${status}`,
      resendStatus: status,
      clientMessage: `发送失败: ${details.message || payload?.message || `Resend API returned ${status}`}`
    }
  );
}

function createMissingEmailIdError(status) {
  return new EmailSendError('Resend response did not include an email id', {
    name: 'missing_email_id',
    resendStatus: status,
    clientMessage: '发送失败: Resend response did not include an email id'
  });
}

function createConfigError(name, message, httpStatus) {
  return new EmailSendError(message, {
    name,
    httpStatus,
    clientMessage: message
  });
}

function todayFrom(now) {
  return new Date(now()).toISOString().slice(0, 10);
}

function createEmailService(options) {
  const state = options.state;
  const apiKey = String(options.apiKey || '').trim();
  const configuredFrom = String(options.from || '').trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const persistState = options.persistState || (async function() {});
  const logger = options.logger || console;
  const now = options.now || (() => new Date());
  let stateLock = Promise.resolve();

  function withStateLock(work) {
    const result = stateLock.then(work, work);
    stateLock = result.catch(() => {});
    return result;
  }

  function resetDailyInMemory() {
    const today = todayFrom(now);
    if (state.sentDate !== today) {
      state.sentToday = 0;
      state.sentDate = today;
      return true;
    }
    return false;
  }

  async function persist() {
    try {
      await persistState();
    } catch (error) {
      // Persistence failure must not turn an already accepted Resend request
      // into a reported send failure. The in-memory reservation remains the
      // source of truth until the next successful persistence.
      if (logger.error) {
        logger.error('[email] State persistence error', {
          errorName: error.name || 'Error',
          errorMessage: error.message || String(error)
        });
      }
    }
  }

  function logError(source, requestId, error) {
    if (!logger.error) return;
    logger.error('[email] Send error', {
      source,
      requestId,
      resendStatus: error.resendStatus ?? null,
      errorName: error.name || 'Error',
      errorMessage: error.message || String(error)
    });
  }

  async function reserve({ source, requestId, subject }) {
    return withStateLock(async () => {
      resetDailyInMemory();

      if (!apiKey) {
        throw createConfigError(
          'resend_api_key_missing',
          'Resend API Key 未配置 (环境变量 RESEND_API_KEY)',
          400
        );
      }
      if (!state.enabled) {
        throw createConfigError('email_disabled', '邮件功能已关闭', 403);
      }
      const recipient = typeof state.recipient === 'string' ? state.recipient.trim() : '';
      if (!recipient) {
        throw createConfigError('email_recipient_missing', '收件人邮箱未配置', 400);
      }
      const maxPerDay = Math.max(1, Number(state.maxPerDay) || 2);
      if (state.sentToday >= maxPerDay) {
        throw createConfigError('email_daily_limit_reached', `今日发送已达上限(${maxPerDay}封)`, 429);
      }
      if (!String(subject || '').trim()) {
        throw createConfigError('email_subject_missing', '缺少邮件主题', 400);
      }

      // Reserve before the network call. Other entrances see this reservation
      // while Resend is in flight, so concurrent sends cannot pass the cap.
      state.sentToday += 1;
      await persist();
      return {
        recipient,
        senderName: String(state.senderName || 'WarmBuddy').trim() || 'WarmBuddy',
        maxPerDay,
        reservedDate: state.sentDate,
        source,
        requestId
      };
    });
  }

  async function release(reservation) {
    await withStateLock(async () => {
      // If the calendar day rolled over while Resend was in flight, the daily
      // reset already discarded the previous day's count; do not decrement the
      // new day's count.
      if (state.sentDate === reservation.reservedDate && state.sentToday > 0) {
        state.sentToday -= 1;
        await persist();
      }
    });
  }

  async function send({ source = 'unknown', requestId = randomUUID(), subject, body }) {
    let reservation;
    try {
      reservation = await reserve({ source, requestId, subject });
    } catch (error) {
      logError(source, requestId, error);
      throw error;
    }

    const emailBody = String(body || '').trim() || String(subject).trim();
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: configuredFrom || `${reservation.senderName} <onboarding@resend.dev>`,
          to: reservation.recipient,
          subject: String(subject).trim(),
          text: emailBody
        })
      });
      const resendData = await response.json().catch(() => ({}));
      if (!response.ok) throw createResendError(resendData, response.status);
      const emailId = typeof resendData.id === 'string' ? resendData.id.trim() : '';
      if (!emailId) throw createMissingEmailIdError(response.status);

      if (logger.log) {
        logger.log('[email] Send accepted', {
          source,
          requestId,
          resendStatus: response.status,
          emailId
        });
      }
      return {
        source,
        requestId,
        resendStatus: response.status,
        emailId,
        sentToday: state.sentToday,
        maxPerDay: reservation.maxPerDay
      };
    } catch (error) {
      await release(reservation);
      logError(source, requestId, error);
      throw error;
    }
  }

  function getStatus() {
    resetDailyInMemory();
    return {
      configured: !!(apiKey && state.recipient),
      enabled: !!state.enabled,
      apiKeySet: !!apiKey,
      recipient: state.recipient,
      senderName: state.senderName,
      sentToday: state.sentToday,
      maxPerDay: Math.max(1, Number(state.maxPerDay) || 2)
    };
  }

  return { send, getStatus, resetDaily: resetDailyInMemory };
}

module.exports = {
  createEmailService,
  EmailSendError,
  createResendError,
  createMissingEmailIdError
};
