/**
 * WarmBuddy Artifacts Module
 * ── File attachments, artifact extraction, inline viewing ──
 */

var ArtifactsModule = (function() {
  'use strict';

  // ── Module-private state ──
  var currentArtifactId = null;
  var _pendingFiles = [];

  // ═══════════════════════════════════════════
  //  Private: data URI to Blob
  // ═══════════════════════════════════════════

  function dataURItoBlob(dataURI, mimeType) {
    if (dataURI.startsWith('data:')) {
      var parts = dataURI.split(',');
      var byteStr = atob(parts[1]);
      var arr = new Uint8Array(byteStr.length);
      for (var i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
      return new Blob([arr], { type: mimeType || 'application/octet-stream' });
    }
    return new Blob([dataURI], { type: mimeType || 'text/html' });
  }

  // ═══════════════════════════════════════════
  //  Private: remove a pending file from preview
  // ═══════════════════════════════════════════

  function removePendingFile(fid) {
    _pendingFiles = _pendingFiles.filter(function(f) { return f !== fid; });
    ArtifactsModule.renderPreview();
  }

  // ═══════════════════════════════════════════
  //  Public: handle file attach from input
  // ═══════════════════════════════════════════

  function handleChatFileAttach(event) {
    var files = event.target.files;
    if (!files || files.length === 0) { event.target.value = ''; return; }
    var chat = AppCore.getActiveChatObj();
    if (!chat) { UIModule.toast('请先打开一个对话'); event.target.value = ''; return; }
    if (!chat.artifacts) chat.artifacts = [];
    var processed = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (file.size > 5 * 1024 * 1024) { UIModule.toast('"' + file.name + '" 超过 5MB 限制，已跳过'); continue; }
      var reader = new FileReader();
      reader.onload = (function(f) {
        return function(e) {
          var content = e.target.result;
          var artifact = {
            id: 'art_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            type: 'file',
            name: f.name,
            mimeType: f.type || 'application/octet-stream',
            content: content,
            size: f.size,
            source: 'user',
            sourceMsgId: null,
            createdAt: new Date().toISOString()
          };
          chat.artifacts.push(artifact);
          _pendingFiles.push(artifact.id);
          processed++;
          if (processed === files.length) {
            AppCore.saveStore();
            ArtifactsModule.renderPreview();
            UIModule.toast('已附加 ' + processed + ' 个文件');
          }
        };
      })(file);
      reader.readAsDataURL(file);
    }
    event.target.value = '';
  }

  // ═══════════════════════════════════════════
  //  Public: render file attachment preview
  // ═══════════════════════════════════════════

  function renderPreview() {
    var area = AppCore.$('fileAttachPreview');
    if (!area) return;
    if (_pendingFiles.length === 0) { area.innerHTML = ''; area.style.display = 'none'; return; }
    var chat = AppCore.getActiveChatObj();
    area.style.display = 'flex';
    area.innerHTML = _pendingFiles.map(function(fid) {
      var art = chat && chat.artifacts ? chat.artifacts.find(function(a) { return a.id === fid; }) : null;
      if (!art) return '';
      var isImg = art.mimeType && art.mimeType.startsWith('image/');
      return '<div class="file-attach-chip">' +
        (isImg ? '<img src="' + art.content + '" style="width:24px;height:24px;object-fit:cover;border-radius:4px;">' : '<span style="font-size:16px;">📎</span>') +
        '<span style="font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + AppCore.escapeHtml(art.name) + '</span>' +
        '<button data-action="removePendingFile" data-args="' + fid + '" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-lighter);">✕</button>' +
        '</div>';
    }).join('');
  }

  // ═══════════════════════════════════════════
  //  Public: inject file markers into text
  // ═══════════════════════════════════════════

  function injectMarkers(text) {
    if (_pendingFiles.length === 0) return text;
    var markers = _pendingFiles.map(function(fid) { return '[[FILE:' + fid + ']]'; }).join('');
    _pendingFiles = [];
    renderPreview();
    return text + markers;
  }

  // ═══════════════════════════════════════════
  //  Public: extract artifacts from AI response
  // ═══════════════════════════════════════════

  function extractFromText(text) {
    var artifacts = [];
    var chat = AppCore.getActiveChatObj();
    if (!chat) return { text: text, artifacts: artifacts };
    if (!chat.artifacts) chat.artifacts = [];
    var regex = /<!--ARTIFACT_START:(html|file):(.*?)-->([\s\S]*?)<!--ARTIFACT_END-->/g;
    var match;
    while ((match = regex.exec(text)) !== null) {
      var type = match[1];
      var name = match[2].trim();
      var content = match[3].trim();
      var id = 'art_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      var artifact = {
        id: id, type: type, name: name,
        mimeType: type === 'html' ? 'text/html' : 'application/octet-stream',
        content: content,
        size: new Blob([content]).size,
        source: 'ai',
        sourceMsgId: null,
        createdAt: new Date().toISOString()
      };
      chat.artifacts.push(artifact);
      artifacts.push(artifact);
    }
    var cleanedText = text.replace(regex, function(fullMatch, type, name, content) {
      var art = artifacts.shift();
      if (!art) return '';
      if (type === 'html') {
        var safeContent = content.replace(/"/g, '&quot;');
        return '<div class="artifact-card-inline" data-action="openArtifactById" data-args="' + art.id + '" style="margin:8px 0;border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;background:var(--bg);">' +
          '<iframe srcdoc="' + safeContent + '" sandbox="allow-scripts" style="width:100%;height:150px;border:none;pointer-events:none;" scrolling="no"></iframe>' +
          '<div style="padding:6px 10px;font-size:11px;color:var(--text-light);display:flex;justify-content:space-between;align-items:center;">' +
          '<span>📄 ' + AppCore.escapeHtml(name || 'HTML Card') + '</span><span style="color:var(--accent);font-size:10px;">点击放大</span>' +
          '</div></div>';
      }
      return '';
    });
    AppCore.saveStore();
    return { text: cleanedText, artifacts: artifacts };
  }

  // ═══════════════════════════════════════════
  //  Public: check if AI is generating an artifact
  // ═══════════════════════════════════════════

  function isGeneratingArtifact(text) {
    var starts = (text.match(/<!--ARTIFACT_START:/g) || []).length;
    var ends = (text.match(/<!--ARTIFACT_END-->/g) || []).length;
    return starts > ends;
  }

  // ═══════════════════════════════════════════
  //  Public: resolve [[FILE:xxx]] refs in text
  // ═══════════════════════════════════════════

  function resolveRefs(text) {
    if (!text) return text;
    var chat = AppCore.getActiveChatObj();
    var artifacts = chat ? (chat.artifacts || []) : [];
    if (artifacts.length === 0) return text;
    return text.replace(/\[\[FILE:([^\]]+)\]\]/g, function(fullMatch, artId) {
      var art = artifacts.find(function(a) { return a.id === artId; });
      if (!art) return fullMatch;
      if (art.mimeType && art.mimeType.startsWith('image/')) {
        return '<div class="artifact-msg-image" data-action="openArtifactById" data-args="' + art.id + '"><img src="' + art.content + '" style="max-width:200px;max-height:200px;border-radius:8px;cursor:pointer;" title="' + AppCore.escapeHtml(art.name) + '"><div style="font-size:10px;color:var(--text-lighter);margin-top:2px;">🖼 ' + AppCore.escapeHtml(art.name) + '</div></div>';
      }
      return '<div class="artifact-msg-file" data-action="openArtifactById" data-args="' + art.id + '" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg);margin:4px 0;">' +
        '<span style="font-size:18px;">📎</span>' +
        '<span style="font-size:11px;color:var(--text);">' + AppCore.escapeHtml(art.name) + '</span>' +
        '<span style="font-size:9px;color:var(--text-lighter);">' + (art.size > 1024 ? (art.size / 1024).toFixed(1) + 'KB' : art.size + 'B') + '</span>' +
        '</div>';
    });
  }

  // ═══════════════════════════════════════════
  //  Public: open artifact viewer
  // ═══════════════════════════════════════════

  function openViewer(id) {
    var chat = AppCore.getActiveChatObj();
    var artifact = chat && chat.artifacts ? chat.artifacts.find(function(a) { return a.id === id; }) : null;
    if (!artifact) return;
    currentArtifactId = id;
    AppCore.$('artifactToolbarTitle').textContent = artifact.name || 'Artifact';
    AppCore.$('artifactFrame').style.display = 'none';
    AppCore.$('artifactImgWrap').style.display = 'none';
    AppCore.$('artifactFileInfo').style.display = 'none';
    if (artifact.type === 'html') {
      AppCore.$('artifactFrame').style.display = 'block';
      AppCore.$('artifactFrame').srcdoc = artifact.content;
    } else if (artifact.mimeType && artifact.mimeType.startsWith('image/')) {
      AppCore.$('artifactImgWrap').style.display = 'flex';
      AppCore.$('artifactImg').src = artifact.content;
    } else {
      AppCore.$('artifactFileInfo').style.display = 'flex';
      AppCore.$('artifactFileName').textContent = artifact.name;
      AppCore.$('artifactFileSize').textContent = artifact.size > 1024 ? (artifact.size / 1024).toFixed(1) + ' KB' : artifact.size + ' B';
    }
    AppCore.$('artifactOverlay').classList.add('show');
  }

  // ═══════════════════════════════════════════
  //  Public: close artifact viewer
  // ═══════════════════════════════════════════

  function closeViewer() {
    AppCore.$('artifactOverlay').classList.remove('show');
    AppCore.$('artifactFrame').srcdoc = '';
    currentArtifactId = null;
  }

  // ═══════════════════════════════════════════
  //  Public: download artifact
  // ═══════════════════════════════════════════

  function downloadArtifact() {
    var chat = AppCore.getActiveChatObj();
    var artifact = chat && chat.artifacts ? chat.artifacts.find(function(a) { return a.id === currentArtifactId; }) : null;
    if (!artifact) return;
    var blob = dataURItoBlob(artifact.content, artifact.mimeType);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = artifact.name || 'artifact';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════
  //  Public: open artifact in new tab
  // ═══════════════════════════════════════════

  function openNewTab() {
    var chat = AppCore.getActiveChatObj();
    var artifact = chat && chat.artifacts ? chat.artifacts.find(function(a) { return a.id === currentArtifactId; }) : null;
    if (!artifact) return;
    var blob = dataURItoBlob(artifact.content, artifact.mimeType);
    var url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  }

  // ═══════════════════════════════════════════
  //  Public: delete artifact
  // ═══════════════════════════════════════════

  function deleteArtifact(id) {
    var chat = AppCore.getActiveChatObj();
    if (!chat || !chat.artifacts) return;
    chat.artifacts = chat.artifacts.filter(function(a) { return a.id !== id; });
    AppCore.saveStore();
    if (currentMemoryTab === 'artifacts') renderMemoryPanelBody();
    if (currentArtifactId === id) ArtifactsModule.closeViewer();
    UIModule.toast('Artifact 已删除');
  }

  // ═══════════════════════════════════════════
  //  Init — event delegation for artifact actions
  // ═══════════════════════════════════════════

  function init() {
    document.addEventListener('click', function(event) {
      var target = event.target.closest('[data-action]');
      if (!target) return;
      var action = target.getAttribute('data-action');
      var args = target.getAttribute('data-args') || '';

      switch (action) {
        case 'openArtifactById':
          ArtifactsModule.openViewer(args);
          break;
        case 'removePendingFile':
          removePendingFile(args);
          break;
      }
    });

    console.log('[ArtifactsModule] ✅ initialized');
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    init: init,
    injectMarkers: injectMarkers,
    extractFromText: extractFromText,
    resolveRefs: resolveRefs,
    isGeneratingArtifact: isGeneratingArtifact,
    openViewer: openViewer,
    closeViewer: closeViewer,
    download: downloadArtifact,
    openNewTab: openNewTab,
    deleteArtifact: deleteArtifact,
    renderPreview: renderPreview,
    handleChatFileAttach: handleChatFileAttach
  };
})();

AppCore.register('artifacts', ArtifactsModule);
