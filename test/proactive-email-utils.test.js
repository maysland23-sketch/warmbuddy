const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseProactiveReply,
  claimTodoWake,
  processProactiveEmail,
  sanitizeFailedEmailMessage
} = require('../proactive-email-utils');

test('parses one explicit email marker and removes it from visible content', () => {
  const parsed = parseProactiveReply('我想起你了。[[EMAIL:晚安|早点休息]]');

  assert.equal(parsed.actionType, 'email');
  assert.equal(parsed.actions.email, '晚安|早点休息');
  assert.equal(parsed.message, '我想起你了。');
});

test('ordinary text and email-looking code blocks do not trigger an email', () => {
  assert.equal(parseProactiveReply('这只是普通文本，提到了 EMAIL: 但不是一行标记').actions.email, undefined);
  const parsed = parseProactiveReply('```text\n[[EMAIL:不要发|代码示例]]\n```');
  assert.equal(parsed.actions.email, undefined);
  assert.match(parsed.message, /\[\[EMAIL:不要发\|代码示例\]\]/);
  const rawParsed = parseProactiveReply('```text\nEMAIL:不要发|代码示例\n```');
  assert.equal(rawParsed.actions.email, undefined);
  assert.match(rawParsed.message, /EMAIL:不要发\|代码示例/);
});

test('multiple email markers send only the first and remove all actionable markers', () => {
  const parsed = parseProactiveReply('[[EMAIL:第一封|正文1]]\n[[EMAIL:第二封|正文2]]');

  assert.equal(parsed.actions.email, '第一封|正文1');
  assert.equal(parsed.message, '');
});

test('TODO and desire callers can use the same parsed email action, with one send maximum', async () => {
  const parsed = parseProactiveReply('[[EMAIL:第一封|正文1]]\n[[EMAIL:第二封|正文2]]');
  const requests = [];
  const outcome = await processProactiveEmail({
    parsed,
    source: 'todo',
    requestId: 'todo-email',
    emailService: {
      send: async request => {
        requests.push(request);
        return { emailId: 'todo-email-id', source: request.source };
      }
    }
  });

  assert.equal(outcome.sent, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    source: 'todo',
    requestId: 'todo-email',
    subject: '第一封',
    body: '正文1'
  });
});

test('raw EMAIL line remains compatible outside code blocks', () => {
  const parsed = parseProactiveReply('一句话\nEMAIL:主题|正文');

  assert.equal(parsed.actions.email, '主题|正文');
  assert.equal(parsed.message, '一句话');
});

test('proactive email failure is returned as a failed action without throwing away the message', async () => {
  const parsed = parseProactiveReply('我还是想告诉你一声。[[EMAIL:主题|正文]]');
  const outcome = await processProactiveEmail({
    parsed,
    source: 'desire',
    requestId: 'failed-proactive',
    emailService: {
      send: async () => { throw new Error('send failed'); }
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.sent, false);
  assert.equal(outcome.emailId, undefined);
  assert.equal(parsed.message, '我还是想告诉你一声。');
});

test('failed email display removes a model success claim without hiding unrelated text', () => {
  assert.equal(
    sanitizeFailedEmailMessage('我已经把邮件发出去了。我们晚点再聊。'),
    '我们晚点再聊。'
  );
  assert.equal(
    sanitizeFailedEmailMessage(''),
    '邮件内容已生成，但暂时没有送出去。'
  );
});

test('an atomic TODO claim lets only one concurrent scan win', async () => {
  let claimed = false;
  const fakeSupabase = {
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: async () => {
              if (claimed) return { data: [], error: null };
              claimed = true;
              return { data: [{ id: 'todo-1' }], error: null };
            }
          })
        })
      })
    })
  };

  const results = await Promise.all([
    claimTodoWake(fakeSupabase, 'todo-1'),
    claimTodoWake(fakeSupabase, 'todo-1')
  ]);

  assert.deepEqual(results.sort(), [false, true]);
});
