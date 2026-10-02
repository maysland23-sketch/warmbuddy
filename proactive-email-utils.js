'use strict';

function collectCodeFenceRanges(source) {
  const ranges = [];
  const fence = /```/g;
  let open = null;
  let match;
  while ((match = fence.exec(source)) !== null) {
    if (open === null) open = match.index;
    else {
      ranges.push([open, match.index + 3]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open, source.length]);
  return ranges;
}

function maskRanges(source, ranges) {
  const chars = source.split('');
  ranges.forEach(([start, end]) => {
    for (let i = start; i < end; i++) chars[i] = ' ';
  });
  return chars;
}

function removeRanges(source, ranges) {
  if (ranges.length === 0) return source;
  const merged = ranges
    .slice()
    .sort((a, b) => a[0] - b[0])
    .reduce((result, range) => {
      const previous = result[result.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else result.push(range.slice());
      return result;
    }, []);
  let result = source;
  for (let i = merged.length - 1; i >= 0; i--) {
    result = result.slice(0, merged[i][0]) + result.slice(merged[i][1]);
  }
  return result;
}

function parseProactiveReply(content) {
  const source = String(content || '');
  const actions = {};
  const removalRanges = [];
  const codeRanges = collectCodeFenceRanges(source);
  const searchable = maskRanges(source, codeRanges);

  // Explicit [[TYPE:...]] markers are authoritative. If a type appears more
  // than once, keep the first action and remove every marker from display.
  const markerRegex = /\[\[(\w+):([\s\S]*?)\]\]/gi;
  let match;
  while ((match = markerRegex.exec(searchable.join(''))) !== null) {
    const type = match[1].toLowerCase();
    const body = match[2].trim();
    if (!actions[type]) actions[type] = body;
    removalRanges.push([match.index, match.index + match[0].length]);
  }

  const fallbackSearchable = searchable.slice();
  removalRanges.forEach(([start, end]) => {
    for (let i = start; i < end; i++) fallbackSearchable[i] = ' ';
  });
  const fallbackTypes = ['LITTER', 'DIARY', 'MESSAGE', 'EMAIL', 'TODO', 'POKE', 'STATUS'];
  for (const fallbackType of fallbackTypes) {
    const fallbackRegex = new RegExp('(?:^|\\n)\\s*' + fallbackType + ':\\s*(.+?)(?=\\n|$)', 'im');
    const fallbackMatch = fallbackRegex.exec(fallbackSearchable.join(''));
    if (!fallbackMatch) continue;
    const type = fallbackType.toLowerCase();
    if (!actions[type]) actions[type] = fallbackMatch[1].trim();
    const start = fallbackMatch.index;
    removalRanges.push([start, start + fallbackMatch[0].length]);
    for (let i = start; i < start + fallbackMatch[0].length; i++) fallbackSearchable[i] = ' ';
  }

  if (actions.diary && typeof actions.diary === 'string') {
    const parts = actions.diary.split('|').map(part => part.trim());
    actions.diary = parts.length >= 3
      ? { title: parts[0].substring(0, 15), mood: parts[1] || '平静', body: parts.slice(2).join('|') }
      : { title: actions.diary.substring(0, 15), mood: '平静', body: actions.diary };
  }

  const message = removeRanges(source, removalRanges).trim();

  let actionType = 'message';
  if (actions.email) actionType = 'email';
  else if (actions.poke) actionType = 'poke';
  else if (actions.status) actionType = 'status';
  else if (actions.todo) actionType = 'todo';
  else if (actions.litter) actionType = 'litter';
  else if (actions.diary) actionType = 'diary';

  return { message, actionType, actions };
}

function splitEmailAction(value, fallbackBody) {
  const parts = String(value || '').split('|').map(part => part.trim());
  const subject = parts[0] || '来自暖伴';
  const body = parts.slice(1).join('\n') || String(fallbackBody || '').trim() || subject;
  return { subject, body };
}

async function processProactiveEmail({ parsed, source, requestId, emailService }) {
  if (!parsed || !parsed.actions || typeof parsed.actions.email !== 'string') {
    return { attempted: false, sent: false };
  }
  const email = splitEmailAction(parsed.actions.email, parsed.message);
  try {
    const result = await emailService.send({
      source,
      requestId,
      subject: email.subject,
      body: email.body
    });
    return { attempted: true, sent: true, subject: email.subject, ...result };
  } catch (error) {
    return { attempted: true, sent: false, subject: email.subject, error };
  }
}

function sanitizeFailedEmailMessage(message) {
  const source = String(message || '').trim();
  const claimPattern = /(?:邮件|信).{0,12}(?:已|已经|成功)?(?:地)?\s*(?:发送|发出|送达|寄出)|(?:已|已经|成功).{0,8}(?:发送|发出|送达|寄出).{0,8}(?:邮件|信)/i;
  if (!source) return '邮件内容已生成，但暂时没有送出去。';
  const visibleParts = source
    .split(/(?<=[。！？.!?])\s*|\n+/)
    .filter(part => !claimPattern.test(part));
  return visibleParts.join(' ').trim() || '邮件内容已生成，但暂时没有送出去。';
}

async function claimTodoWake(supabase, todoId) {
  const { data, error } = await supabase
    .from('project_todos')
    .update({ triggered: true })
    .eq('id', todoId)
    .eq('triggered', false)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

module.exports = {
  parseProactiveReply,
  processProactiveEmail,
  sanitizeFailedEmailMessage,
  claimTodoWake,
  splitEmailAction
};
