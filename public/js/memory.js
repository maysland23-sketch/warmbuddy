/**
 * WarmBuddy MemoryModule v3.0
 * ── Single-writer cache with Supabase authoritative + localforage read cache ──
 * All functions take explicit projectId — no dependency on getActiveProject().
 */

(function() {
  'use strict';

  // ── Configuration ──
  var BACKEND = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL : 'https://warmbuddy.onrender.com';
  var CACHE_KEY_PREFIX = 'mm_cache_';
  var CACHE_KEY_MIGRATED = 'mm_migrated_v3';
  var SYNC_DEBOUNCE_MS = 2000;
  var AEM_CAP = 200;
  var USM_CAP = 200;
  var DLB_CAP = 100;
  var REFLECTION_MAX = 50;
  var RETENTION = { full: 7, half: 14, quarter: 30 };

  // ── Internal state ──
  var _cache = {};          // { [projectId]: { aems[], usms[], dlbs[], derivedPatterns, personalityProfiles, relationalPortrait, reflections[], affectGraph, chatSummaries, pendingCoreMemories[], quietPresenceCount, evictedMessages[], deriveTriggers, lastMaintenance, _loaded } }
  var _dirty = {};          // { [projectId]: bool }
  var _syncTimers = {};     // { [projectId]: timeoutId }
  var _bm25 = {};           // { [projectId]: { _dirty, _lastBuild, _docCount, index } }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  var MemoryModule = {

    // ── Core CRUD ──

    /**
     * Load memories for a project. Tries localforage cache first, then Supabase.
     * Supabase data takes priority over cache for same-ID items.
     * @param {string} projectId
     * @returns {Promise<{aems:Array, usms:Array, dlbs:Array, derivedPatterns:Object, personalityProfiles:Object}>}
     */
    load: async function(projectId) {
      if (!projectId) throw new Error('projectId required');
      ensureCacheEntry(projectId);

      // 1. Try localforage cache (fast)
      try {
        var cached = await localforage.getItem(CACHE_KEY_PREFIX + projectId);
        if (cached && cached._version) {
          _cache[projectId].aems = cached.aems || [];
          _cache[projectId].usms = cached.usms || [];
          _cache[projectId].dlbs = cached.dlbs || [];
          _cache[projectId].derivedPatterns = cached.derivedPatterns || { lastDerived: null, triggerCount: 0, patterns: [] };
          _cache[projectId].personalityProfiles = cached.personalityProfiles || emptyPersonalityProfiles();
          _cache[projectId].relationalPortrait = cached.relationalPortrait || { patterns: {}, lastRefined: null };
          _cache[projectId].reflections = cached.reflections || [];
          _cache[projectId].affectGraph = cached.affectGraph || { edges: {} };
          _cache[projectId].chatSummaries = cached.chatSummaries || {};
          _cache[projectId].pendingCoreMemories = cached.pendingCoreMemories || [];
          _cache[projectId].quietPresenceCount = cached.quietPresenceCount || 0;
          _cache[projectId].evictedMessages = cached.evictedMessages || [];
          _cache[projectId].deriveTriggers = cached.deriveTriggers || { aemSince: 0, usmSince: 0, lastWeekly: '' };
          _cache[projectId].lastMaintenance = cached.lastMaintenance || '';
          _cache[projectId]._loaded = true;
        }
      } catch (e) { /* cache miss, continue to Supabase */ }

      // 2. Fetch from Supabase (authoritative)
      try {
        var resp = await fetch(BACKEND + '/api/memories/' + encodeURIComponent(projectId));
        if (resp.ok) {
          var data = await resp.json();
          if (data && data.aems) {
            mergeFromSupabase(projectId, data.aems || [], data.usms || [], data.dlbs || []);
            _cache[projectId]._loaded = true;
            // Persist merged data back to localforage
            await persistCache(projectId);
          }
        }
      } catch (e) {
        console.warn('[MemoryModule] Supabase fetch failed, using cache:', e.message);
        // Cache already loaded in step 1; proceed with what we have
        if (!_cache[projectId]._loaded) {
          _cache[projectId]._loaded = true; // mark loaded even if empty
        }
      }

      // 3. Rebuild search index
      _bm25[projectId] = { _dirty: true, _lastBuild: null, _docCount: 0, index: {} };

      return getCML(projectId);
    },

    /**
     * Save cached data: immediate localforage + debounced Supabase sync.
     * @param {string} projectId
     * @returns {Promise<void>}
     */
    save: async function(projectId) {
      if (!projectId) return;
      ensureCacheEntry(projectId);

      // Immediate: write to localforage cache
      await persistCache(projectId);

      // Debounced: schedule Supabase sync
      scheduleSync(projectId);
    },

    /**
     * Force immediate sync of cached data to Supabase.
     * @param {string} projectId
     * @returns {Promise<void>}
     */
    sync: async function(projectId) {
      if (!projectId) return;
      ensureCacheEntry(projectId);
      clearSyncTimer(projectId);
      await pushToSupabase(projectId);
    },

    /**
     * Add an AI Emotional Memory.
     * @param {string} projectId
     * @param {Object} aem — { id, timestamp, sourceChatId, sourceWindowId, sourceProjectId, aiSelfEval, userStateAtTime, summary, rawDialogue, triggerSource }
     */
    addAEM: function(projectId, aem) {
      if (!projectId || !aem || !aem.id) return;
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      // Dedup by ID
      var idx = findIndexById(c.aems, aem.id);
      if (idx >= 0) {
        c.aems[idx] = aem; // update
      } else {
        c.aems.unshift(aem);
        if (c.aems.length > AEM_CAP) c.aems.length = AEM_CAP;
      }
      _bm25[projectId] = rebuildBM25Sync(projectId);
      MemoryModule.save(projectId);
    },

    /**
     * Add a User Starred Memory.
     * @param {string} projectId
     * @param {Object} usm — { id, timestamp, sourceChatId, sourceWindowId, sourceProjectId, rawDialogue, summary, starredMsgIds, userNote }
     */
    addUSM: function(projectId, usm) {
      if (!projectId || !usm || !usm.id) return;
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      var idx = findIndexById(c.usms, usm.id);
      if (idx >= 0) {
        c.usms[idx] = usm;
      } else {
        c.usms.unshift(usm);
        if (c.usms.length > USM_CAP) c.usms.length = USM_CAP;
      }
      MemoryModule.save(projectId);
    },

    /**
     * Update fields on an existing memory.
     * @param {string} projectId
     * @param {string} id
     * @param {Object} data — fields to merge
     */
    update: function(projectId, id, data) {
      if (!projectId || !id) return;
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      var found = false;
      ['aems','usms','dlbs'].forEach(function(layer) {
        var idx = findIndexById(c[layer], id);
        if (idx >= 0) {
          Object.assign(c[layer][idx], data);
          found = true;
        }
      });
      if (found) MemoryModule.save(projectId);
    },

    /**
     * Remove a memory by ID from all layers.
     * @param {string} projectId
     * @param {string} id
     */
    remove: function(projectId, id) {
      if (!projectId || !id) return;
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      ['aems','usms','dlbs'].forEach(function(layer) {
        c[layer] = c[layer].filter(function(m) { return m.id !== id; });
      });
      // Also delete from Supabase
      fetch(BACKEND + '/api/memories/' + encodeURIComponent(id), { method: 'DELETE' }).catch(function(){});
      MemoryModule.save(projectId);
    },

    // ── Query ──

    /**
     * Synchronous read of all 3 memory layers.
     * @param {string} projectId
     * @returns {{aiEmotionalMemories:Array, userStarredMemories:Array, diaryAndLitterbox:Array}|null}
     */
    getCML: function(projectId) {
      var c = _cache[projectId];
      if (!c) return null;
      return {
        aiEmotionalMemories: c.aems || [],
        userStarredMemories: c.usms || [],
        diaryAndLitterbox: c.dlbs || []
      };
    },

    /**
     * Synchronous read of derived relational patterns.
     * @param {string} projectId
     * @returns {Object|null}
     */
    getDerivedPatterns: function(projectId) {
      var c = _cache[projectId];
      return c ? (c.derivedPatterns || null) : null;
    },

    /**
     * Synchronous read of personality profiles.
     * @param {string} projectId
     * @returns {Object|null}
     */
    getPersonalityProfiles: function(projectId) {
      var c = _cache[projectId];
      return c ? (c.personalityProfiles || null) : null;
    },

    /**
     * Full-text search across all memories using BM25.
     * @param {string} projectId
     * @param {string} query
     * @returns {Array<{id:string, content:string, type:string, layer:string, score:number}>}
     */
    search: function(projectId, query) {
      if (!projectId || !query || query.length < 2) return [];
      ensureCacheEntry(projectId);
      var bm = _bm25[projectId];
      if (!bm || bm._dirty) {
        bm = rebuildBM25Sync(projectId);
        _bm25[projectId] = bm;
      }
      var tokens = tokenize(query);
      if (!tokens.length) return [];

      var scores = {};
      var avgdl = bm._docCount > 0 ? bm._totalLen / bm._docCount : 1;
      var k1 = 1.2, b = 0.75;

      for (var ti = 0; ti < tokens.length; ti++) {
        var t = tokens[ti];
        var posting = bm.index[t];
        if (!posting) continue;
        var idf = Math.log(1 + (bm._docCount - posting.df + 0.5) / (posting.df + 0.5));
        var docs = posting.docs;
        for (var docId in docs) {
          if (!docs.hasOwnProperty(docId)) continue;
          var tf = docs[docId];
          var docLen = bm._docLens[docId] || 1;
          var score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl)));
          scores[docId] = (scores[docId] || 0) + score;
        }
      }

      // Sort by score, return top 10 with metadata
      var c = _cache[projectId];
      var results = [];
      for (var id in scores) {
        if (!scores.hasOwnProperty(id)) continue;
        var mem = findByIdAnyLayer(c, id);
        results.push({
          id: id,
          content: mem ? (mem.summary || mem.content || '') : '',
          type: mem ? (mem.type || 'aem') : 'aem',
          layer: mem ? guessLayer(c, id) : 'ai_emotional',
          score: scores[id]
        });
      }
      results.sort(function(a, b) { return b.score - a.score; });
      return results.slice(0, 10);
    },

    // ── Import / Export ──

    /**
     * Import memories from a v2.0 JSON export.
     * @param {string} projectId
     * @param {Object} data — v2.0 format { aiEmotionalMemories[], userStarredMemories[], diaryAndLitterbox[], derivedRelationalPatterns, personalityProfiles, schema_version, schemaVersion, exportMeta }
     * @returns {{added:number, updated:number, skipped:number, total:number}}
     */
    importJSON: function(projectId, data) {
      if (!projectId || !data) return { added: 0, updated: 0, skipped: 0, total: 0 };
      ensureCacheEntry(projectId);

      var isV2 = (data.schemaVersion === '2.0' || data.schema_version === '2.0' || !!data.exportMeta);
      var aemItems = [], usmItems = [], dlbItems = [];
      var result = { added: 0, updated: 0, skipped: 0, total: 0 };

      if (isV2) {
        aemItems = data.aiEmotionalMemories || [];
        usmItems = data.userStarredMemories || [];
        dlbItems = data.diaryAndLitterbox || [];
      } else if (Array.isArray(data)) {
        // legacy flat array
        aemItems = data;
      } else if (data.memories && Array.isArray(data.memories)) {
        aemItems = data.memories.map(function(m) { return { id: m.id, summary: m.content, type: m.type, timestamp: m.date, metadata: slimMetadata(m) }; });
      }

      var allItems = [
        { layer: 'aems', items: aemItems },
        { layer: 'usms', items: usmItems },
        { layer: 'dlbs', items: dlbItems }
      ];

      var c = _cache[projectId];
      var existingIds = {};
      ['aems','usms','dlbs'].forEach(function(layer) {
        (c[layer] || []).forEach(function(m) { existingIds[m.id] = layer; });
      });

      allItems.forEach(function(group) {
        group.items.forEach(function(item) {
          if (!item || !item.id) { result.skipped++; return; }
          result.total++;

          if (existingIds[item.id]) {
            // Update existing (upsert)
            var targetLayer = existingIds[item.id];
            var idx = findIndexById(c[targetLayer], item.id);
            if (idx >= 0) {
              // Preserve original ID — do not prefix with 'imported_'
              var merged = Object.assign({}, c[targetLayer][idx], item, { id: item.id });
              c[targetLayer][idx] = merged;
              result.updated++;
            } else {
              result.skipped++;
            }
          } else {
            // New — keep original ID
            var newItem = Object.assign({}, item, { id: item.id });
            c[group.layer].unshift(newItem);
            existingIds[item.id] = group.layer;
            result.added++;
          }
        });
      });

      // Cap layers
      if (c.aems.length > AEM_CAP) c.aems.length = AEM_CAP;
      if (c.usms.length > USM_CAP) c.usms.length = USM_CAP;
      if (c.dlbs.length > DLB_CAP) c.dlbs.length = DLB_CAP;

      // Import insights if newer
      if (data.derivedRelationalPatterns && data.derivedRelationalPatterns.lastDerived) {
        if (!c.derivedPatterns.lastDerived || data.derivedRelationalPatterns.lastDerived > c.derivedPatterns.lastDerived) {
          c.derivedPatterns = data.derivedRelationalPatterns;
        }
      }
      if (data.personalityProfiles && data.personalityProfiles.lastDerived) {
        if (!c.personalityProfiles.lastDerived || data.personalityProfiles.lastDerived > c.personalityProfiles.lastDerived) {
          c.personalityProfiles = data.personalityProfiles;
        }
      }

      _bm25[projectId] = rebuildBM25Sync(projectId);
      MemoryModule.save(projectId);
      MemoryModule.sync(projectId); // immediate sync for imports
      return result;
    },

    /**
     * Export all memories for a project in v2.0 format.
     * @param {string} projectId
     * @returns {Object} v2.0 export
     */
    exportJSON: function(projectId) {
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      var now = new Date().toISOString();
      return {
        exportMeta: {
          exportedAt: now,
          exportType: 'manual',
          week: weekLabel(new Date()),
          schema_version: '2.0',
          schemaVersion: '2.0',
          projectId: projectId
        },
        aiEmotionalMemories: (c.aems || []).slice(),
        userStarredMemories: (c.usms || []).slice(),
        diaryAndLitterbox: (c.dlbs || []).slice(),
        derivedRelationalPatterns: c.derivedPatterns || { lastDerived: null, triggerCount: 0, patterns: [] },
        personalityProfiles: c.personalityProfiles || emptyPersonalityProfiles()
      };
    },

    // ── Maintenance ──

    /**
     * Apply forgetting curve decay. Memories older than thresholds get reduced retention.
     * Starred and core memories are protected.
     * @param {string} projectId
     */
    applyDecay: function(projectId) {
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      var today = fmtDateISO();
      var RETENTION = { full: 7, half: 14, quarter: 30 };

      c.aems.forEach(function(mem) {
        if (mem.starred) return;
        if (!mem.timestamp) return;
        var age = daysBetween(mem.timestamp.slice(0, 10), today);
        if (age <= RETENTION.full) { mem.decayFactor = 1.0; }
        else if (age <= RETENTION.half) { mem.decayFactor = 0.5; }
        else if (age <= RETENTION.quarter) { mem.decayFactor = 0.25; }
        else { mem.decayFactor = 0; }
      });

      c.usms.forEach(function(mem) {
        if (mem.starred) return;
        if (!mem.timestamp) return;
        var age = daysBetween(mem.timestamp.slice(0, 10), today);
        if (age <= RETENTION.full) { mem.decayFactor = 1.0; }
        else if (age <= RETENTION.half) { mem.decayFactor = 0.5; }
        else if (age <= RETENTION.quarter) { mem.decayFactor = 0.25; }
        else { mem.decayFactor = 0; }
      });
    },

    /**
     * Trigger insights derivation check (placeholder — delegates to caller via callback).
     * @param {string} projectId
     * @returns {{aemCount:number, usmCount:number, shouldDerive:boolean}}
     */
    getDeriveStatus: function(projectId) {
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      var aemCount = (c.aems || []).length;
      var usmCount = (c.usms || []).length;
      return {
        aemCount: aemCount,
        usmCount: usmCount,
        shouldDerive: aemCount >= 5 || usmCount >= 3
      };
    },

    /**
     * Store derived patterns and personality profiles in cache.
     * @param {string} projectId
     * @param {Object} derivedPatterns
     * @param {Object} personalityProfiles
     */
    storeInsights: function(projectId, derivedPatterns, personalityProfiles) {
      if (!projectId) return;
      ensureCacheEntry(projectId);
      if (derivedPatterns) _cache[projectId].derivedPatterns = derivedPatterns;
      if (personalityProfiles) _cache[projectId].personalityProfiles = personalityProfiles;
      MemoryModule.save(projectId);
    },

    // ── Migration ──

    /**
     * One-time migration: read old-format data from localforage and push to Supabase.
     * Reads: warmbuddy-store (store.projects[].memories, coreMemoryLayers) +
     *        per-window memory files (warmbuddy-memory-{pid}-{wid})
     * @returns {Promise<{migrated:number, projects:number}>}
     */
    migrateFromLegacy: async function() {
      try {
        var alreadyMigrated = await localforage.getItem(CACHE_KEY_MIGRATED);
        if (alreadyMigrated) { console.log('[MemoryModule] Migration already done, skipping.'); return { migrated: 0, projects: 0 }; }
      } catch (e) {}

      var totalMigrated = 0;
      var projectIds = [];

      // 1. Read old warmbuddy-store
      try {
        var store = await localforage.getItem('warmbuddy-store');
        if (store && store.projects) {
          for (var i = 0; i < store.projects.length; i++) {
            var proj = store.projects[i];
            if (!proj.id) continue;
            projectIds.push(proj.id);

            var allMems = [];

            // 1a. proj.memories (v1 legacy array)
            if (proj.memories && proj.memories.length > 0) {
              proj.memories.forEach(function(m) {
                allMems.push({
                  id: m.id || ('m_' + randStr()),
                  project_id: proj.id,
                  content: m.content || '',
                  type: m.type || 'chat',
                  layer: m.starred ? 'user_starred' : 'ai_emotional',
                  starred: m.starred || false,
                  created_at: (m.date || '') + 'T00:00:00.000Z',
                  metadata: m
                });
              });
            }

            // 1b. proj.coreMemoryLayers
            var cml = proj.coreMemoryLayers;
            if (cml) {
              (cml.aiEmotionalMemories || []).forEach(function(aem) {
                allMems.push({
                  id: aem.id || ('aem_' + randStr()),
                  project_id: proj.id,
                  content: aem.summary || aem.content || '',
                  type: 'aem',
                  layer: 'ai_emotional',
                  starred: aem.starred || false,
                  created_at: aem.timestamp || new Date().toISOString(),
                  metadata: slimMetadata(aem)
                });
              });
              (cml.userStarredMemories || []).forEach(function(usm) {
                allMems.push({
                  id: usm.id || ('usm_' + randStr()),
                  project_id: proj.id,
                  content: usm.summary || usm.content || '',
                  type: 'usm',
                  layer: 'user_starred',
                  starred: true,
                  created_at: usm.timestamp || new Date().toISOString(),
                  metadata: slimMetadata(usm)
                });
              });
              (cml.diaryAndLitterbox || []).forEach(function(dlb) {
                allMems.push({
                  id: dlb.id || ('dlb_' + randStr()),
                  project_id: proj.id,
                  content: dlb.summary || dlb.content || '',
                  type: dlb.type || 'dlb',
                  layer: 'diary_litter',
                  starred: false,
                  created_at: dlb.timestamp || new Date().toISOString(),
                  metadata: slimMetadata(dlb)
                });
              });
            }

            // Sync this project's merged memories
            if (allMems.length > 0) {
              try {
                await fetch(BACKEND + '/api/memories/sync', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ projectId: proj.id, memories: allMems })
                });
                totalMigrated += allMems.length;
                console.log('[MemoryModule] Migrated', allMems.length, 'memories for project', proj.id);
              } catch (e) {
                console.warn('[MemoryModule] Migration failed for project', proj.id, ':', e.message);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[MemoryModule] warmbuddy-store read failed:', e.message);
      }

      // 2. Read old per-window memory files
      try {
        var allKeys = await localforage.keys();
        for (var k = 0; k < allKeys.length; k++) {
          var key = allKeys[k];
          if (!key || key.indexOf('warmbuddy-memory-') !== 0) continue;
          try {
            var file = await localforage.getItem(key);
            if (!file || !file.project_id) continue;

            var pid = file.project_id;
            var fileMems = [];

            (file.aiEmotionalMemories || []).forEach(function(aem) {
              fileMems.push({
                id: aem.id || ('aem_' + randStr()),
                project_id: pid,
                content: aem.summary || aem.content || '',
                type: 'aem',
                layer: 'ai_emotional',
                starred: false,
                created_at: aem.timestamp || new Date().toISOString(),
                metadata: aem
              });
            });
            (file.userStarredMemories || []).forEach(function(usm) {
              fileMems.push({
                id: usm.id || ('usm_' + randStr()),
                project_id: pid,
                content: usm.summary || '',
                type: 'usm',
                layer: 'user_starred',
                starred: true,
                created_at: usm.timestamp || new Date().toISOString(),
                metadata: usm
              });
            });
            (file.diaryAndLitterbox || []).forEach(function(dlb) {
              fileMems.push({
                id: dlb.id || ('dlb_' + randStr()),
                project_id: pid,
                content: dlb.summary || dlb.content || '',
                type: 'dlb',
                layer: 'diary_litter',
                starred: false,
                created_at: dlb.timestamp || new Date().toISOString(),
                metadata: dlb
              });
            });

            if (fileMems.length > 0) {
              try {
                await fetch(BACKEND + '/api/memories', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ projectId: pid, memories: fileMems })
                });
                totalMigrated += fileMems.length;
              } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}

      // Mark migration complete
      await localforage.setItem(CACHE_KEY_MIGRATED, true);
      console.log('[MemoryModule] Migration complete:', totalMigrated, 'total memories across', projectIds.length, 'projects');
      return { migrated: totalMigrated, projects: projectIds.length };
    },

    // ── Debug / Internal ──
    _cache: _cache,
    _dirty: _dirty,

    /**
     * Directly set patterns and profiles on project cache (used by migrateStore).
     * @param {string} projectId
     * @param {Object} patterns
     * @param {Object} profiles
     */
    setProjectMeta: function(projectId, patterns, profiles) {
      ensureCacheEntry(projectId);
      if (patterns) _cache[projectId].derivedPatterns = patterns;
      if (profiles) _cache[projectId].personalityProfiles = profiles;
    },

    // ── Runtime State (formerly store.memorySystem) ──
    getRelationalPortrait: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].relationalPortrait; },
    updateRelationalPortrait: function(projectId, data){ ensureCacheEntry(projectId); Object.assign(_cache[projectId].relationalPortrait, data); },
    getReflections: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].reflections; },
    addReflection: function(projectId, entry){ ensureCacheEntry(projectId); var r=_cache[projectId].reflections; r.unshift(entry); if(r.length>REFLECTION_MAX)r.length=REFLECTION_MAX; },
    getAffectGraph: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].affectGraph; },
    updateAffectGraphEdge: function(projectId, key){ ensureCacheEntry(projectId); var edges=_cache[projectId].affectGraph.edges; edges[key]=(edges[key]||0)+1; },
    getChatSummaries: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].chatSummaries; },
    getChatSummary: function(projectId, chatId){ ensureCacheEntry(projectId); return (_cache[projectId].chatSummaries||{})[chatId]||null; },
    setChatSummary: function(projectId, chatId, s){ ensureCacheEntry(projectId); _cache[projectId].chatSummaries[chatId]=s; },
    getPendingCoreMemories: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].pendingCoreMemories; },
    addPendingCoreMemory: function(projectId, item){ ensureCacheEntry(projectId); _cache[projectId].pendingCoreMemories.push(item); },
    shiftPendingCoreMemories: function(projectId, count){ ensureCacheEntry(projectId); return _cache[projectId].pendingCoreMemories.splice(0,count||3); },
    getQuietPresenceCount: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].quietPresenceCount; },
    incrementQuietPresence: function(projectId){ ensureCacheEntry(projectId); _cache[projectId].quietPresenceCount=(_cache[projectId].quietPresenceCount||0)+1; },
    resetQuietPresence: function(projectId){ ensureCacheEntry(projectId); _cache[projectId].quietPresenceCount=0; },
    getEvictedMessages: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].evictedMessages; },
    addEvictedMessage: function(projectId, msg){ ensureCacheEntry(projectId); var ev=_cache[projectId].evictedMessages; ev.push(msg); if(ev.length>50)ev.shift(); },
    clearEvictedMessages: function(projectId){ ensureCacheEntry(projectId); _cache[projectId].evictedMessages=[]; },
    getDeriveTriggers: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].deriveTriggers; },
    incrementDeriveTrigger: function(projectId, source){ ensureCacheEntry(projectId); var dt=_cache[projectId].deriveTriggers; if(source==='aem')dt.aemSince=(dt.aemSince||0)+1; else if(source==='usm')dt.usmSince=(dt.usmSince||0)+1; },
    resetDeriveTriggers: function(projectId){ ensureCacheEntry(projectId); _cache[projectId].deriveTriggers={aemSince:0,usmSince:0,lastWeekly:''}; },
    getLastMaintenance: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].lastMaintenance; },
    setLastMaintenance: function(projectId, date){ ensureCacheEntry(projectId); _cache[projectId].lastMaintenance=date; },
    getRetention: function(){ return RETENTION; }
  };

  // ═══════════════════════════════════════════
  //  Internal helpers
  // ═══════════════════════════════════════════

  function ensureCacheEntry(projectId) {
    if (!_cache[projectId]) {
      _cache[projectId] = {
        aems: [], usms: [], dlbs: [],
        derivedPatterns: { lastDerived: null, triggerCount: 0, patterns: [] },
        personalityProfiles: emptyPersonalityProfiles(),
        relationalPortrait: { patterns: {}, lastRefined: null },
        reflections: [],
        affectGraph: { edges: {} },
        chatSummaries: {},
        pendingCoreMemories: [],
        quietPresenceCount: 0,
        evictedMessages: [],
        deriveTriggers: { aemSince: 0, usmSince: 0, lastWeekly: '' },
        lastMaintenance: '',
        _loaded: false,
        _version: 1
      };
    }
    if (!_dirty[projectId]) _dirty[projectId] = false;
  }

  function emptyPersonalityProfiles() {
    return {
      lastDerived: null,
      user: { coreTraits: [], communicationStyle: '', emotionalPatterns: [], growthMoments: [], hiddenInsecurities: [], evidenceIds: [] },
      ai: { dominantEmotions: [], reactionPatterns: [], growthMoments: [], evidenceIds: [] }
    };
  }

  function findIndexById(arr, id) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) return i;
    }
    return -1;
  }

  function findByIdAnyLayer(c, id) {
    var found = null;
    ['aems','usms','dlbs'].forEach(function(layer) {
      var idx = findIndexById(c[layer], id);
      if (idx >= 0) found = c[layer][idx];
    });
    return found;
  }

  function guessLayer(c, id) {
    if (findIndexById(c.aems, id) >= 0) return 'ai_emotional';
    if (findIndexById(c.usms, id) >= 0) return 'user_starred';
    if (findIndexById(c.dlbs, id) >= 0) return 'diary_litter';
    return 'ai_emotional';
  }

  /**
   * Merge Supabase data into cache. Supabase is authoritative — same-ID items from
   * Supabase overwrite cache items.
   */
  function mergeFromSupabase(projectId, supAEMs, supUSMs, supDLBs) {
    var c = _cache[projectId];
    // Merge helper: Supabase data updates matching cache items,
    // but cache-only items (e.g. from importJSON) are preserved.
    function mergeLayer(layerName, supRows) {
      if (!supRows || supRows.length === 0) return; // no Supabase data → keep cache as-is
      var cacheMap = {};
      (c[layerName] || []).forEach(function(m, i) { cacheMap[m.id] = { idx: i, item: m }; });
      var merged = [];
      var seenIds = {};
      // Process Supabase rows
      supRows.forEach(function(row) {
        var mem = row.metadata || row;
        mem.id = row.id;
        mem.content = row.content;
        mem.type = row.type;
        mem.starred = row.starred;
        mem.created_at = row.created_at;
        mem.updated_at = row.updated_at;
        seenIds[row.id] = true;
        if (cacheMap[row.id]) {
          // Update: Supabase metadata wins, but preserve local-only fields
          var local = cacheMap[row.id].item;
          mem.rawDialogue = local.rawDialogue || mem.rawDialogue;
          mem.semanticKey = local.semanticKey || mem.semanticKey;
        }
        merged.push(mem);
      });
      // Append cache-only items (not in Supabase)
      (c[layerName] || []).forEach(function(m) {
        if (!seenIds[m.id]) merged.push(m);
      });
      c[layerName] = merged;
    }

    mergeLayer('aems', supAEMs);
    mergeLayer('usms', supUSMs);
    mergeLayer('dlbs', supDLBs);
  }

  async function persistCache(projectId) {
    var c = _cache[projectId];
    if (!c) return;
    // Only persist if loaded
    if (!c._loaded) return;
    try {
      await localforage.setItem(CACHE_KEY_PREFIX + projectId, {
        aems: c.aems, usms: c.usms, dlbs: c.dlbs,
        derivedPatterns: c.derivedPatterns,
        personalityProfiles: c.personalityProfiles,
        relationalPortrait: c.relationalPortrait,
        reflections: c.reflections, affectGraph: c.affectGraph,
        chatSummaries: c.chatSummaries,
        pendingCoreMemories: c.pendingCoreMemories,
        quietPresenceCount: c.quietPresenceCount,
        evictedMessages: c.evictedMessages,
        deriveTriggers: c.deriveTriggers,
        lastMaintenance: c.lastMaintenance,
        _version: 1
      });
    } catch (e) {
      console.warn('[MemoryModule] Cache write failed:', e.message);
    }
  }

  function scheduleSync(projectId) {
    clearSyncTimer(projectId);
    _syncTimers[projectId] = setTimeout(function() {
      delete _syncTimers[projectId];
      pushToSupabase(projectId);
    }, SYNC_DEBOUNCE_MS);
  }

  function clearSyncTimer(projectId) {
    if (_syncTimers[projectId]) {
      clearTimeout(_syncTimers[projectId]);
      delete _syncTimers[projectId];
    }
  }

  // Strip large fields (rawDialogue, raw_quote) from metadata before syncing to Supabase.
  // These fields are already cached client-side; syncing them wastes bandwidth and hits 413 limits.
  function slimMetadata(m) {
    if (!m || typeof m !== 'object') return m;
    var slim = {};
    for (var k in m) {
      if (k !== 'rawDialogue' && k !== 'raw_quote') slim[k] = m[k];
    }
    return slim;
  }

  async function pushToSupabase(projectId) {
    var c = _cache[projectId];
    if (!c || !c._loaded) return;

    var allMems = [];
    c.aems.forEach(function(m) {
      allMems.push({ id: m.id, content: m.summary || m.content || '', type: m.type || 'aem', layer: 'ai_emotional', starred: m.starred || false, metadata: slimMetadata(m) });
    });
    c.usms.forEach(function(m) {
      allMems.push({ id: m.id, content: m.summary || m.content || '', type: m.type || 'usm', layer: 'user_starred', starred: m.starred || false, metadata: slimMetadata(m) });
    });
    c.dlbs.forEach(function(m) {
      allMems.push({ id: m.id, content: m.summary || m.content || '', type: m.type || 'dlb', layer: 'diary_litter', starred: false, metadata: slimMetadata(m) });
    });

    if (allMems.length === 0) return;

    try {
      var resp = await fetch(BACKEND + '/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projectId, memories: allMems.slice(0, 500) })
      });
      if (!resp.ok) console.warn('[MemoryModule] Supabase sync failed:', resp.status);
      else _dirty[projectId] = false;
    } catch (e) {
      console.warn('[MemoryModule] Supabase sync error:', e.message);
    }
  }

  // ═══════════════════════════════════════════
  //  BM25 full-text search
  // ═══════════════════════════════════════════

  function tokenize(text) {
    if (!text) return [];
    text = String(text).toLowerCase();
    var tokens = [];
    // Chinese: character bigrams
    var cnChars = [];
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (/[一-鿿]/.test(ch)) {
        cnChars.push(ch);
      } else {
        // Flush Chinese buffer as bigrams
        for (var j = 0; j + 1 < cnChars.length; j++) {
          tokens.push(cnChars[j] + cnChars[j + 1]);
        }
        if (cnChars.length === 1) tokens.push(cnChars[0]);
        cnChars = [];
      }
    }
    // Flush remaining Chinese
    for (var j = 0; j + 1 < cnChars.length; j++) {
      tokens.push(cnChars[j] + cnChars[j + 1]);
    }
    if (cnChars.length === 1) tokens.push(cnChars[0]);

    // English words
    var words = text.match(/[a-z0-9]+/g);
    if (words) {
      for (var w = 0; w < words.length; w++) {
        if (words[w].length >= 2) tokens.push(words[w]);
      }
    }
    return tokens;
  }

  function rebuildBM25Sync(projectId) {
    var c = _cache[projectId];
    if (!c) return { _dirty: false, _lastBuild: new Date().toISOString(), _docCount: 0, _totalLen: 0, index: {}, _docLens: {} };

    var index = {};
    var docLens = {};
    var docCount = 0;
    var totalLen = 0;

    var allMems = (c.aems || []).concat(c.usms || []).concat(c.dlbs || []);

    for (var i = 0; i < allMems.length; i++) {
      var mem = allMems[i];
      var text = (mem.summary || mem.content || '');
      var tokens = tokenize(text);
      if (!tokens.length) continue;
      docCount++;
      var len = tokens.length;
      totalLen += len;
      docLens[mem.id] = len;

      // Count term frequencies per doc
      var tfMap = {};
      for (var t = 0; t < tokens.length; t++) {
        var tok = tokens[t];
        tfMap[tok] = (tfMap[tok] || 0) + 1;
      }

      // Update inverted index
      for (var tok in tfMap) {
        if (!tfMap.hasOwnProperty(tok)) continue;
        if (!index[tok]) index[tok] = { df: 0, docs: {} };
        index[tok].df++;
        index[tok].docs[mem.id] = tfMap[tok];
      }
    }

    return {
      _dirty: false,
      _lastBuild: new Date().toISOString(),
      _docCount: docCount,
      _totalLen: totalLen,
      index: index,
      _docLens: docLens
    };
  }

  // ═══════════════════════════════════════════
  //  Utility helpers
  // ═══════════════════════════════════════════

  function fmtDateISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function weekLabel(d) {
    d = d || new Date();
    var year = d.getFullYear();
    var jan1 = new Date(year, 0, 1);
    var dayOfYear = Math.floor((d - jan1) / 86400000);
    var weekNum = Math.ceil((dayOfYear + jan1.getDay() + 1) / 7);
    return year + '-W' + String(weekNum).padStart(2, '0');
  }

  function daysBetween(d1, d2) {
    if (!d1 || !d2) return 0;
    return Math.floor((new Date(d2) - new Date(d1)) / 86400000);
  }

  function randStr() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Expose to window
  window.MemoryModule = MemoryModule;

})();
