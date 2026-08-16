/**
 * WarmBuddy TodoModule v1.0
 * ── Todo CRUD, reminders, goal tracking ──
 */

var TodoModule = (function() {
  'use strict';

  var todoTab = 'short';

  function init() {
    var store = AppCore.getStore();
    todoTab = store.todoTab || 'short';
    console.log('[TodoModule] ✅ initialized');
  }

  // ═══════════════════════════════════════════
  //  UI
  // ═══════════════════════════════════════════
  function switchTodoTab(tab, btn) {
    var store = AppCore.getStore();
    todoTab = tab; store.todoTab = tab;
    document.querySelectorAll('.todo-tab').forEach(function(x) { x.classList.remove('active'); });
    btn.classList.add('active');
    renderTodos();
  }

  function renderTodos() {
    var store = AppCore.getStore();
    var el = AppCore.$('todoList');
    var items = store.todos.filter(function(t) { return t.type === (todoTab === 'long' ? 'long' : 'short'); });
    if (items.length === 0) {
      el.innerHTML = '<div class="empty-state">' + (todoTab === 'long' ? 'no goals yet.' : 'nothing to do — enjoy the calm.') + '</div>';
      return;
    }
    el.innerHTML = items.map(function(t) {
      if (t.type === 'long') return renderGoalCard(t);
      return renderTodoCard(t);
    }).join('');
    attachSwipeListeners();
  }

  function renderTodoCard(t) {
    return '<div class="swipe-container" data-id="' + t.id + '"><div class="swipe-content card-todo" onclick="toggleTodo(\'' + t.id + '\')"><div class="todo-check ' + (t.done ? 'done' : '') + '">' + (t.done ? '✓' : '') + '</div><span class="todo-text ' + (t.done ? 'done' : '') + '">' + t.text + '</span>' + (t.time ? '<span class="todo-time">' + t.time + '</span>' : '') + '</div><div class="swipe-delete" onclick="deleteTodo(\'' + t.id + '\')">delete</div></div>';
  }

  function renderGoalCard(t) {
    var store = AppCore.getStore();
    var remain = AppCore.daysBetween(AppCore.fmtDate().iso, t.deadline);
    var urgent = remain <= 7;
    return '<div class="swipe-container" data-id="' + t.id + '"><div class="swipe-content" onclick="openGoalDetail(\'' + t.id + '\')" style="cursor:pointer;"><div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;"><div class="todo-check ' + (t.done ? 'done' : '') + '" onclick="event.stopPropagation();toggleTodo(\'' + t.id + '\')">' + (t.done ? '✓' : '') + '</div><span class="todo-text ' + (t.done ? 'done' : '') + '">' + t.text + '</span></div><div class="goal-meta"><div class="goal-progress-wrap"><div class="goal-progress-fill" style="width:' + t.progress + '%"></div></div><span style="font-family:var(--font-en);font-size:11px;color:var(--text-lighter);">' + t.progress + '%</span><span class="goal-deadline ' + (urgent ? 'urgent' : '') + '">' + (remain > 0 ? '剩余 ' + remain + ' 天' : (remain === 0 ? '今天到期' : '已过期')) + '</span></div></div><div class="swipe-delete" onclick="deleteTodo(\'' + t.id + '\')">delete</div></div>';
  }

  function attachSwipeListeners() {
    document.querySelectorAll('.swipe-container').forEach(function(el) {
      var startX = 0, startY = 0, currentX = 0;
      var content = el.querySelector('.swipe-content');
      if (content.dataset.swipeBound) return;
      content.dataset.swipeBound = '1';
      content.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; content.style.transition = 'none'; });
      content.addEventListener('touchmove', function(e) {
        var dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
        if (Math.abs(dy) > Math.abs(dx)) return;
        e.preventDefault(); currentX = Math.min(0, Math.max(-72, dx));
        content.style.transform = 'translateX(' + currentX + 'px)';
      });
      content.addEventListener('touchend', function() {
        content.style.transition = 'transform 0.25s ease';
        if (currentX < -36) content.style.transform = 'translateX(-72px)';
        else content.style.transform = 'translateX(0)';
        currentX = 0;
      });
      var md = false;
      content.addEventListener('mousedown', function(e) { md = true; startX = e.clientX; content.style.transition = 'none'; });
      content.addEventListener('mousemove', function(e) { if (!md) return; var dx2 = e.clientX - startX; currentX = Math.min(0, Math.max(-72, dx2)); content.style.transform = 'translateX(' + currentX + 'px)'; });
      content.addEventListener('mouseup', function() { if (!md) return; md = false; content.style.transition = 'transform 0.25s ease'; if (currentX < -36) content.style.transform = 'translateX(-72px)'; else content.style.transform = 'translateX(0)'; currentX = 0; });
      content.addEventListener('mouseleave', function() { if (!md) return; md = false; content.style.transition = 'transform 0.25s ease'; content.style.transform = 'translateX(0)'; currentX = 0; });
    });
  }

  function toggleTodo(id) {
    var store = AppCore.getStore();
    var t = store.todos.find(function(x) { return x.id === id; });
    if (!t) return;
    t.done = !t.done;
    renderTodos();
    fetch(AppCore.BACKEND_URL + '/api/todos/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: t.done })
    }).catch(function(e) { console.warn('[todo] PATCH failed:', e.message); });
  }

  function deleteTodo(id) {
    var store = AppCore.getStore();
    store.todos = store.todos.filter(function(x) { return x.id !== id; });
    renderTodos();
    UIModule.toast('Deleted');
    fetch(AppCore.BACKEND_URL + '/api/todos/' + encodeURIComponent(id), {
      method: 'DELETE'
    }).catch(function(e) { console.warn('[todo] DELETE failed:', e.message); });
  }

  function addTodo() {
    var store = AppCore.getStore();
    var isGoal = todoTab === 'long';
    UIModule.showModal(isGoal ? 'New Goal' : 'New To-Do',
      '<input class="modal-input" id="newTodoText" placeholder="' + (isGoal ? 'Goal description' : 'What needs to be done?') + '">' +
      (isGoal ? '<input class="modal-input" id="newTodoDeadline" placeholder="Deadline (YYYY-MM-DD)" value="2026-07-01">' : '<input class="modal-input" id="newTodoTime" placeholder="Time (e.g. 14:00)" value="' + String(new Date().getHours()).padStart(2,'0') + ':00">') +
      '<input type="hidden" id="newTodoType" value="' + todoTab + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'add', cls: 'confirm', onclick: saveTodo }]);
  }

  function saveTodo() {
    var store = AppCore.getStore();
    var text = AppCore.$('newTodoText').value.trim();
    var type = AppCore.$('newTodoType').value;
    if (!text) { UIModule.toast('Please enter text'); return; }
    var proj = AppCore.getActiveProject();
    var now = new Date();
    if (type === 'long') {
      var deadline = AppCore.$('newTodoDeadline').value.trim() || '2026-12-31';
      var id = 't' + AppCore.gid('');
      store.todos.unshift({ id: id, text: text, done: false, time: '', type: 'long', deadline: deadline, progress: 0, dailyLogs: [], creator: 'user', createdAt: now.toISOString() });
      fetch(AppCore.BACKEND_URL + '/api/todos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: proj ? proj.id : '', id: id, title: text, time: deadline + 'T23:59:00Z', creator: 'user' })
      }).catch(function(e) { console.warn('[todo] POST failed:', e.message); });
    } else {
      var time = AppCore.$('newTodoTime').value.trim();
      var id2 = 't' + AppCore.gid('');
      var isoTime = null;
      if (time && /^\d{1,2}:\d{2}$/.test(time)) {
        var parts = time.split(':'); var h = parseInt(parts[0]), m = parseInt(parts[1]);
        var today = new Date(); today.setHours(h, m, 0, 0); isoTime = today.toISOString();
      }
      store.todos.unshift({ id: id2, text: text, done: false, time: time || '--:--', type: 'short', creator: 'user', createdAt: now.toISOString() });
      fetch(AppCore.BACKEND_URL + '/api/todos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: proj ? proj.id : '', id: id2, title: text, time: isoTime || now.toISOString(), creator: 'user' })
      }).catch(function(e) { console.warn('[todo] POST failed:', e.message); });
    }
    store._importing = true;
    UIModule.closeModal();
    renderTodos();
    UIModule.toast('Added');
  }

  function openGoalDetail(id) {
    var store = AppCore.getStore();
    var t = store.todos.find(function(x) { return x.id === id; });
    if (!t || t.type !== 'long') return;
    var remain = AppCore.daysBetween(AppCore.fmtDate().iso, t.deadline);
    UIModule.showModal(t.text,
      '<div style="margin-bottom:12px;"><span class="goal-deadline ' + (remain <= 7 ? 'urgent' : '') + '">📅 ' + t.deadline + ' · ' + (remain > 0 ? '剩余 ' + remain + ' 天' : (remain === 0 ? '今天到期' : '已过期')) + '</span></div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><span style="font-size:13px;">Progress:</span><input class="modal-input" id="goalProgressInput" type="number" min="0" max="100" value="' + t.progress + '" style="width:60px;margin-bottom:0;text-align:center;"><span style="font-size:13px;">%</span></div>' +
      '<div class="goal-progress-wrap" style="margin-bottom:12px;"><div class="goal-progress-fill" style="width:' + t.progress + '%"></div></div>' +
      '<div style="font-family:var(--font-en);font-size:10px;color:var(--text-lighter);letter-spacing:0.08em;margin-bottom:8px;">DAILY LOG</div>' +
      ((t.dailyLogs || []).length === 0 ? '<div class="empty-state" style="padding:8px;">no logs yet.</div>' : '') +
      (t.dailyLogs || []).map(function(l) {
        return '<div class="goal-log-item"><div><div style="color:var(--text);">' + l.note + '</div><div class="goal-log-date">' + l.date + '</div></div><span style="font-size:12px;color:var(--text-lighter);">' + l.pct + '%</span></div>';
      }).join('') +
      '<input class="modal-input" id="goalLogNote" placeholder="Add daily log..." style="margin-top:10px;">' +
      '<input type="hidden" id="goalDetailId" value="' + id + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'save', cls: 'confirm', onclick: saveGoalDetail }]);
  }

  function saveGoalDetail() {
    var store = AppCore.getStore();
    var id = AppCore.$('goalDetailId').value;
    var t = store.todos.find(function(x) { return x.id === id; });
    if (!t) return;
    t.progress = Math.min(100, Math.max(0, parseInt(AppCore.$('goalProgressInput').value) || 0));
    var note = AppCore.$('goalLogNote').value.trim();
    if (note) t.dailyLogs.unshift({ date: AppCore.fmtDate().iso, note: note, pct: t.progress });
    store._importing = true;
    UIModule.closeModal();
    renderTodos();
    UIModule.toast('Goal updated');
  }

  return {
    init: init,
    switchTodoTab: switchTodoTab,
    renderTodos: renderTodos,
    toggleTodo: toggleTodo,
    deleteTodo: deleteTodo,
    addTodo: addTodo,
    saveTodo: saveTodo,
    openGoalDetail: openGoalDetail,
    saveGoalDetail: saveGoalDetail
  };
})();

AppCore.register('todo', TodoModule);
