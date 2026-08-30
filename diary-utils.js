'use strict';

function isDiaryVisibleToChat(diary, projectId, chatId, existingChatIds) {
  if (!diary || !projectId || !chatId) return false;
  if (diary.visibility_mode === 'public') {
    return Array.isArray(existingChatIds) && existingChatIds.includes(chatId);
  }
  return Array.isArray(diary.visible_chat_ids) && diary.visible_chat_ids.includes(chatId);
}

function createDiaryDelivery(diaryId, targetProjectId, targetChatId, deliveryType) {
  return {
    id: 'dd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    diary_id: diaryId,
    target_project_id: targetProjectId,
    target_chat_id: targetChatId,
    delivery_type: deliveryType || 'share',
    status: 'pending',
    created_at: new Date().toISOString(),
    consumed_at: null
  };
}

function buildDiaryInjection(diary) {
  const author = diary.author === 'ai' ? (diary.authorName || 'AI') : 'user';
  const sourceWindow = diary.sourceWindow ? ' / ' + diary.sourceWindow : '';
  return [
    '【分享日记】',
    '标题：' + (diary.title || '无标题'),
    '心情：' + (diary.mood || '平静'),
    '时间：' + (diary.date || '') + (diary.time ? ' ' + diary.time : ''),
    '落款：' + author + sourceWindow,
    '正文：' + (diary.content || '')
  ].join('\n');
}

module.exports = { isDiaryVisibleToChat, createDiaryDelivery, buildDiaryInjection };
