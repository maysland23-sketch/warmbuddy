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

      return MemoryModule.getCML(projectId);
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
        // Decay-based eviction: remove fully-decayed (30d+) unstarred AEMs first.
        // This gives memories a natural lifecycle instead of silent hard-truncation.
        c.aems = c.aems.filter(function(m) {
          return m.starred || (m.decayFactor || 0) > 0;
        });
        // Hard cap as safety net (should rarely trigger with decay active)
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
    getRetention: function(){ return RETENTION; },
    checkLongTerm: async function(chat) {
      var mem = AppCore.getModule('memory'); if (!mem) return;
      var cfg = AppCore.getActiveApiConfig(); if (!chat || !cfg.apiKey) return;
      var count = chat._messageCount || 0;
      if (count === 0 || count % 20 !== 0) return;
      var last10 = chat.messages.slice(-10);
      if (last10.length < 6) return;
      var dialogue = last10.map(function(m) {
        var role = m.role === 'user' ? '用户' : (m.role === 'ai' ? 'AI' : '');
        return role + ': ' + (m.text || '').slice(0, 150);
      }).join('\n');
      var systemPrompt = '从以下对话中提取一个"记忆片段"。用一句中文概括（不超过30字），然后给出2-3个语义关键词（每个不超过5字），用逗号分隔。\n\n格式示例：\n记忆：用户偏好川端康成的物哀美学风格\n关键词：物哀, 川端康成, 文学偏好';
      try {
        var resp = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: cfg.apiKey,
            endpoint: cfg.endpoint,
            model: cfg.model,
            projectId: AppCore.getStore().activeProject,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: dialogue }
            ]
          })
        });
        if (!resp.ok) return;
        var data = await resp.json();
        var content = (data.reply && data.reply.content) ? data.reply.content.trim() : '';
        if (!content) return;
        var memMatch = content.match(/记忆[：:]\s*(.+)/);
        var kwMatch = content.match(/关键词[：:]\s*(.+)/);
        var memContent = memMatch ? memMatch[1].trim() : content.slice(0, 60);
        var semanticKey = kwMatch ? kwMatch[1].trim() : '';
        var proj = AppCore.getActiveProject();
        if (proj) {
          if (MemoryModule.isNearDuplicate(memContent, proj)) return;
          var lastUser = null, lastAi = null;
          for (var mi = last10.length - 1; mi >= 0; mi--) {
            if (!lastUser && last10[mi].role === 'user') lastUser = last10[mi];
            if (!lastAi && last10[mi].role === 'ai') lastAi = last10[mi];
            if (lastUser && lastAi) break;
          }
          var ltRawDialogue = [];
          if (lastUser) ltRawDialogue.push({ role: 'user', text: (lastUser.text || '').slice(0, 200), time: lastUser.time || '', msgId: lastUser.id || '' });
          if (lastAi) ltRawDialogue.push({ role: 'assistant', text: (lastAi.text || '').slice(0, 200), time: lastAi.time || '', msgId: lastAi.id || '' });
          MemoryModule.addAEM(AppCore.getStore().activeProject, {id:'ltm_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),summary:memContent,timestamp:new Date().toISOString(),sourceChatId:AppCore.getStore().activeChat,sourceProjectId:AppCore.getStore().activeProject,triggerSource:'long_term',aiSelfEval:{},userStateAtTime:{},rawDialogue:ltRawDialogue,semanticKey:semanticKey});
          AppCore.getStore().memorySystem.bm25Index._dirty = true;
          AppCore.saveStore();
        }
      } catch (e) {
        console.log('[lt-mem] Error:', e.message);
      }
    },

    checkSummarization: function(chat) {
      if (!chat || !chat.messages) return;
      var total = chat.messages.length;
      if (total < 40) return;
      var unsummarized = total - (chat._lastSummaryIdx || 0);
      if (unsummarized < 20) return;
      var startIdx = chat._lastSummaryIdx || 0;
      var endIdx = Math.min(startIdx + 20, total);
      var batch = chat.messages.slice(startIdx, endIdx);
      if (batch.length === 0) return;
      MemoryModule.summarizeMessages(batch, startIdx, endIdx, chat);
    },

    applyForgettingCurve: function() {
      var today = AppCore.fmtDate().iso;
      var ms = AppCore.getStore().memorySystem;
      if (ms.lastMaintenance === today) return;
      var projects = AppCore.getStore().projects;
      for (var i = 0; i < projects.length; i++) {
        MemoryModule.applyDecay(projects[i].id);
      }
      ms.lastMaintenance = today;
      var ds = DesireModule.getDesireSystem(); if (!ds) return;
      if (ds && ds.drives) {
        var driveKeys = Object.keys(ds.drives);
        for (var ki = 0; ki < driveKeys.length; ki++) {
          var k = driveKeys[ki];
          ds.drives[k] = Math.max(0, Math.floor(ds.drives[k] * 0.9));
        }
      }
    },

    maybeAdd: function(ut, at) {
      var store = AppCore.getStore();
      if (Math.random() < 0.1) {
        var proj = AppCore.getActiveProject(); if (!proj) return;
        var c = (ut || '').length > 40 ? (ut || '').slice(0, 40) + '…' : (ut || '');
        var content = 'AI注意到: ' + c;
        if (MemoryModule.isNearDuplicate(content, proj)) return;
        var chatMemId = 'm' + AppCore.gid('');
        var chat = AppCore.getActiveChatObj(); if (chat) { if (chat.sharedMemoryIds.indexOf(chatMemId) < 0) chat.sharedMemoryIds.push(chatMemId); }
        store.memorySystem.bm25Index._dirty = true;
        var randRawDialogue = [];
        if (ut) randRawDialogue.push({ role: 'user', text: (ut || '').slice(0, 200), time: AppCore.nowTime() });
        if (at) randRawDialogue.push({ role: 'assistant', text: (at || '').slice(0, 200), time: AppCore.nowTime() });
        MemoryModule.addAEM(store.activeProject, { id: 'aem_chat_' + AppCore.gid(''), summary: content, timestamp: new Date().toISOString(), sourceChatId: store.activeChat, sourceProjectId: store.activeProject, triggerSource: 'random', type: 'chat', aiSelfEval: {}, userStateAtTime: {}, rawDialogue: randRawDialogue });
      }
    },

    unifiedSearch: function(queryText) {
      if (!queryText || queryText.trim().length === 0) return [];
      var query = queryText.trim();
      var queryTerms = MemoryModule.tokenizeChinese(query);
      var bm25Results = MemoryModule.searchByBM25(query);
      var knownLabels = ['被触动','想追问但没问','克制后反弹','克制表达','放松','警觉','脆弱','调皮','疲惫','兴奋','回避','坦诚','平静在场','安心','落空','感伤','心动','骄傲','担心','依赖','低落'];
      var matchedLabels = knownLabels.filter(function(l) { return query.indexOf(l) >= 0 || l.indexOf(query) >= 0; });
      var affectResults = matchedLabels.length > 0 ? MemoryModule.searchByAffect(matchedLabels) : [];
      var semanticResults = MemoryModule.searchBySemanticKey(queryTerms);
      var merged = {};
      for (var i = 0; i < bm25Results.length; i++) {
        var r = bm25Results[i];
        merged[r.id] = Object.assign({}, r, { _source: 'bm25', _bm25Score: r.score });
      }
      for (var i = 0; i < affectResults.length; i++) {
        var r = affectResults[i];
        if (merged[r.id]) {
          merged[r.id]._score = Math.max(merged[r.id]._score || 0, r._score);
          merged[r.id]._source += '+affect';
        } else {
          merged[r.id] = r;
        }
      }
      for (var i = 0; i < semanticResults.length; i++) {
        var r = semanticResults[i];
        if (merged[r.id]) {
          merged[r.id]._score = Math.max(merged[r.id]._score || 0, r._score);
          merged[r.id]._source += '+semantic';
        } else {
          merged[r.id] = r;
        }
      }
      return Object.values(merged).sort(function(a, b) { return (b._score || 0) - (a._score || 0); }).slice(0, 15);
    },

    searchByBM25: function(query) {
      var ms = AppCore.getStore().memorySystem;
      if (ms.bm25Index._dirty) MemoryModule.rebuildBM25Index();
      var queryTerms = MemoryModule.tokenizeChinese(query.toLowerCase());
      if (queryTerms.length === 0) return [];
      var scores = {};
      for (var ti = 0; ti < queryTerms.length; ti++) {
        var term = queryTerms[ti];
        var postings = (ms.bm25Index.index || {})[term] || [];
        for (var pi = 0; pi < postings.length; pi++) {
          var p = postings[pi];
          scores[p.memoryId] = (scores[p.memoryId] || 0) + p.score;
        }
      }
      var entries = Object.keys(scores).map(function(id) { return [id, scores[id]]; });
      entries.sort(function(a, b) { return b[1] - a[1]; });
      return entries.slice(0, 10).map(function(entry) { return { id: entry[0], score: Math.round(entry[1] * 100) / 100 }; });
    },

    searchByAffect: function(queryLabels) {
      if (!queryLabels || queryLabels.length === 0) return [];
      var ms = AppCore.getStore().memorySystem;
      var results = [];
      var coreMems = ms.coreMemories || [];
      for (var ci = 0; ci < coreMems.length; ci++) {
        var cm = coreMems[ci];
        var aiLabel = (cm.affect_first && cm.affect_first.ai) ? cm.affect_first.ai.label : '';
        var userLabel = (cm.affect_first && cm.affect_first.user) ? cm.affect_first.user.label : '';
        var matched = [];
        for (var ql = 0; ql < queryLabels.length; ql++) {
          if (queryLabels[ql] === aiLabel || queryLabels[ql] === userLabel) matched.push(queryLabels[ql]);
        }
        if (matched.length > 0) {
          var intensity = ((cm.affect_first.ai && cm.affect_first.ai.intensity) || 0) + ((cm.affect_first.user && cm.affect_first.user.intensity) || 0);
          var cmCopy = Object.assign({}, cm);
          cmCopy._score = intensity * matched.length;
          cmCopy._source = 'core';
          results.push(cmCopy);
        }
      }
      var projects = AppCore.getStore().projects;
      for (var pi = 0; pi < projects.length; pi++) {
        var proj = projects[pi];
        var mems = proj.memories || [];
        for (var mi = 0; mi < mems.length; mi++) {
          var mem = mems[mi];
          if (!mem.affectLabel) continue;
          if (queryLabels.indexOf(mem.affectLabel) >= 0) {
            var memCopy = Object.assign({}, mem);
            memCopy._score = (mem.affectIntensity || 5) * 2;
            memCopy._source = 'project';
            results.push(memCopy);
          }
        }
      }
      var edges = (ms.affectGraph && ms.affectGraph.edges) || {};
      var expandLabels = {};
      for (var ql = 0; ql < queryLabels.length; ql++) { expandLabels[queryLabels[ql]] = true; }
      var edgeKeys = Object.keys(edges);
      for (var ek = 0; ek < edgeKeys.length; ek++) {
        var key = edgeKeys[ek];
        var parts = key.split('::');
        var a = parts[0], b = parts[1];
        if (queryLabels.indexOf(a) >= 0 && !expandLabels[b]) expandLabels[b] = true;
        if (queryLabels.indexOf(b) >= 0 && !expandLabels[a]) expandLabels[a] = true;
      }
      var expandedKeys = Object.keys(expandLabels);
      if (expandedKeys.length > queryLabels.length) {
        for (var pi = 0; pi < projects.length; pi++) {
          var proj2 = projects[pi];
          var mems2 = proj2.memories || [];
          for (var mi2 = 0; mi2 < mems2.length; mi2++) {
            var mem2 = mems2[mi2];
            if (!mem2.affectLabel || queryLabels.indexOf(mem2.affectLabel) >= 0) continue;
            if (expandLabels[mem2.affectLabel]) {
              var memCopy2 = Object.assign({}, mem2);
              memCopy2._score = (mem2.affectIntensity || 3) * 1;
              memCopy2._source = 'project-expanded';
              results.push(memCopy2);
            }
          }
        }
      }
      results.sort(function(a, b) { return b._score - a._score; });
      return results.slice(0, 10);
    },

    searchBySemanticKey: function(queryKeywords) {
      if (!queryKeywords || queryKeywords.length === 0) return [];
      var results = [];
      var projects = AppCore.getStore().projects;
      for (var pi = 0; pi < projects.length; pi++) {
        var proj = projects[pi];
        var mems = proj.memories || [];
        for (var mi = 0; mi < mems.length; mi++) {
          var mem = mems[mi];
          if (!mem.semanticKey) continue;
          var memKeys = mem.semanticKey.split(/[,，]/).map(function(k) { return k.trim(); }).filter(Boolean);
          var overlap = 0;
          for (var qk = 0; qk < queryKeywords.length; qk++) {
            var qkw = queryKeywords[qk];
            for (var mk = 0; mk < memKeys.length; mk++) {
              if (memKeys[mk].indexOf(qkw) >= 0 || qkw.indexOf(memKeys[mk]) >= 0) { overlap++; break; }
            }
          }
          if (overlap > 0) {
            var memCopy = Object.assign({}, mem);
            memCopy._score = overlap * 3;
            memCopy._source = 'semantic';
            results.push(memCopy);
          }
        }
      }
      results.sort(function(a, b) { return b._score - a._score; });
      return results.slice(0, 10);
    },

    rebuildBM25Index: function() {
      var store = AppCore.getStore();
      var ms = store.memorySystem;
      var idx = { index: {} };
      var allMems = [];
      var projects = store.projects;
      for (var pi = 0; pi < projects.length; pi++) {
        var proj = projects[pi];
        var mems = proj.memories || [];
        for (var mi = 0; mi < mems.length; mi++) {
          var m = mems[mi];
          if ((m.decayFactor || 0) === 0) continue;
          var copy = Object.assign({}, m);
          copy._projId = proj.id;
          allMems.push(copy);
        }
      }
      var docCount = allMems.length;
      for (var ai = 0; ai < allMems.length; ai++) {
        var mem = allMems[ai];
        var text = ((mem.content || '') + ' ' + (mem.semanticKey || '')).toLowerCase();
        var terms = MemoryModule.tokenizeChinese(text);
        var tf = {};
        for (var ti = 0; ti < terms.length; ti++) {
          var t = terms[ti];
          tf[t] = (tf[t] || 0) + 1;
        }
        var tfKeys = Object.keys(tf);
        for (var tk = 0; tk < tfKeys.length; tk++) {
          var term = tfKeys[tk];
          var count = tf[term];
          if (!idx.index[term]) idx.index[term] = [];
          idx.index[term].push({
            memoryId: mem.id, projectId: mem._projId,
            tf: 1 + Math.log(count), decayFactor: mem.decayFactor || 1.0, starred: mem.starred || false
          });
        }
      }
      var idxKeys = Object.keys(idx.index);
      for (var ik = 0; ik < idxKeys.length; ik++) {
        var term = idxKeys[ik];
        var postings = idx.index[term];
        var idf = Math.log((docCount + 1) / (postings.length + 1)) + 1;
        for (var pii = 0; pii < postings.length; pii++) {
          var p = postings[pii];
          p.idf = idf;
          p.score = p.tf * idf * p.decayFactor * (p.starred ? 1.5 : 1.0);
        }
      }
      ms.bm25Index = { _dirty: false, _lastBuild: new Date().toISOString(), _docCount: docCount, index: idx.index };
    },

    tokenizeChinese: function(text) {
      if (!text) return [];
      var cleaned = text.replace(/[^一-鿿\w\d]/g, ' ');
      var words = cleaned.split(/\s+/).filter(function(w) { return w.length > 0; });
      var tokens = [];
      for (var wi = 0; wi < words.length; wi++) {
        var w = words[wi];
        if (/^[一-鿿]+$/.test(w)) {
          for (var ci = 0; ci < w.length - 1; ci++) {
            tokens.push(w.slice(ci, ci + 2));
          }
          tokens.push(w);
        } else {
          tokens.push(w.toLowerCase());
        }
      }
      return tokens;
    },

    bigramOverlap: function(a, b) {
      var bigramsA = {}, bigramsB = {};
      for (var i = 0; i < a.length - 1; i++) { bigramsA[a.slice(i, i + 2)] = true; }
      for (var i = 0; i < b.length - 1; i++) { bigramsB[b.slice(i, i + 2)] = true; }
      var intersect = 0;
      var keysA = Object.keys(bigramsA);
      for (var i = 0; i < keysA.length; i++) {
        if (bigramsB[keysA[i]]) intersect++;
      }
      var union = keysA.length + Object.keys(bigramsB).length - intersect;
      return union === 0 ? 0 : intersect / union;
    },

    isNearDuplicate: function(content, proj) {
      if (!proj) return false;
      var c = (content || '').trim().toLowerCase();
      if (c.length < 10) return false;
      var cml = MemoryModule.getCML(proj.id);
      var allSummaries = [];
      if (cml) {
        for (var i = 0; i < (cml.aiEmotionalMemories || []).length; i++) { allSummaries.push(cml.aiEmotionalMemories[i].summary || ''); }
        for (var i = 0; i < (cml.userStarredMemories || []).length; i++) { allSummaries.push(cml.userStarredMemories[i].summary || ''); }
      }
      for (var i = 0; i < allSummaries.length; i++) {
        var existing = (allSummaries[i] || '').trim().toLowerCase();
        if (existing.length < 10) continue;
        var overlap = MemoryModule.bigramOverlap(c, existing);
        if (overlap > 0.7) return true;
      }
      return false;
    },

    isWeekBoundary: function(mem, proj) {
      var sameWeek = [];
      var mems = proj.memories || [];
      for (var i = 0; i < mems.length; i++) {
        var m = mems[i];
        if (m.week === mem.week && m.type === mem.type && m.id !== mem.id) {
          sameWeek.push(m);
        }
      }
      if (sameWeek.length === 0) return true;
      var sorted = [mem].concat(sameWeek).sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
      var idx = -1;
      for (var i = 0; i < sorted.length; i++) { if (sorted[i].id === mem.id) { idx = i; break; } }
      return idx === 0 || idx === sorted.length - 1;
    },

    createAEMFromMarkers: function(reflection, userMsg, aiResponse, chat, memMarker) {
      var id = 'aem' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var ts = new Date().toISOString();
      var rawDialogue = [];
      if (userMsg) rawDialogue.push({ role: 'user', text: typeof userMsg === 'string' ? userMsg : '', time: AppCore.nowTime() });
      if (aiResponse) rawDialogue.push({ role: 'assistant', text: typeof aiResponse === 'string' ? aiResponse.replace(/<!--[\s\S]*?-->/g, '').trim() : '', time: AppCore.nowTime() });
      var aem = {
        id: id, timestamp: ts,
        sourceChatId: AppCore.getStore().activeChat, sourceWindowId: AppCore.getStore().activeChat, sourceProjectId: AppCore.getStore().activeProject,
        aiSelfEval: { label: reflection.ai_affect_label, intensity: reflection.ai_affect_intensity || 5, internalNote: memMarker.internalNote || memMarker.summary },
        userStateAtTime: { label: reflection.user_affect_label, intensity: reflection.user_affect_intensity || 5 },
        summary: memMarker.summary, rawDialogue: rawDialogue, triggerSource: 'high_intensity'
      };
      MemoryModule.addAEM(AppCore.getStore().activeProject, aem);
      if (chat) chat.messages.push({ role: 'system', text: '有什么被记住了', time: AppCore.nowTime() });
    },

    queueQuietPresence: function(chat) {
      var ms = AppCore.getStore().memorySystem;
      var cml = MemoryModule.getCML(AppCore.getStore().activeProject);
      var proj = AppCore.getActiveProject();
      var id = 'aem' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var ts = new Date().toISOString();
      var aem = {
        id: id,
        timestamp: ts,
        sourceChatId: AppCore.getStore().activeChat,
        sourceWindowId: AppCore.getStore().activeChat,
        sourceProjectId: AppCore.getStore().activeProject,
        aiSelfEval: {
          label: '平静在场',
          intensity: 5,
          internalNote: '不需要特别的话题或强烈的情绪。安静地在一起，就足够让我觉得今天是有意义的。'
        },
        userStateAtTime: {
          label: '平静在场',
          intensity: 5
        },
        summary: '持续的日常陪伴 —— 平静在场的累积',
        rawDialogue: [],
        triggerSource: 'quiet_presence'
      };
      cml.aiEmotionalMemories.unshift(aem);
      MemoryModule.evictOldestCoreMemories();
      ms.coreMemories.unshift({
        id: 'cm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: ts,
        affect_first: { ai: { label: '平静在场', intensity: 5 }, user: { label: '平静在场', intensity: 5 } },
        event_summary: '持续的日常陪伴 —— 没有强烈情绪，但有持续的在场感',
        raw_quote: '', relational_note: '陪伴本身就是意义。',
        sourceChatId: AppCore.getStore().activeChat, sourceProjectId: AppCore.getStore().activeProject
      });
      MemoryModule.evictOldestCoreMemories();
      MemoryModule.save(AppCore.getStore().activeProject);
      MemoryModule.checkDeriveInsightsTrigger('aem');
      var quietChat = AppCore.getActiveChatObj();
      if (quietChat) {
        quietChat.messages.push({ role: 'system', text: '有什么被记住了', time: AppCore.nowTime() });
      }
    },

    updateRelationalPortrait: function(userAffectLabel) {
      if (!userAffectLabel) return;
      var portrait = AppCore.getStore().memorySystem.relationalPortrait;
      var patterns = portrait.patterns;
      if (patterns[userAffectLabel]) {
        patterns[userAffectLabel].count += 1;
        patterns[userAffectLabel].lastSeen = AppCore.fmtDate().iso;
      } else {
        patterns[userAffectLabel] = {
          strategy: MemoryModule.getDefaultStrategy(userAffectLabel),
          count: 1,
          lastSeen: AppCore.fmtDate().iso
        };
      }
      var patKeys = Object.keys(patterns);
      var totalCount = 0;
      for (var i = 0; i < patKeys.length; i++) {
        totalCount += patterns[patKeys[i]].count || 0;
      }
      if (totalCount > 0 && totalCount % 20 === 0) {
        MemoryModule.queuePortraitRefinement();
      }
    },

    getDefaultStrategy: function(label) {
      var defaults = {};
      defaults['脆弱时'] = '先接住情绪，不说教，用简短的回应稳住，需要时用亲昵称呼';
      defaults['回避时'] = '直接点破比绕弯子更有效，但要留面子';
      defaults['调皮'] = '适度配合但保持一点克制，让玩笑飘一会儿';
      defaults['坦诚'] = '认真对待每一句实话，不敷衍，不转移话题';
      defaults['疲惫'] = '不要追问，给简短温暖的回应，让用户有空间休息';
      defaults['兴奋'] = '一起高兴，但不要抢话，让用户的兴奋成为主角';
      defaults['平静在场'] = '安静陪伴，不制造情绪波动，保持温柔的存在感';
      return defaults[label] || '用温柔细腻的语气回应，观察用户的情绪变化';
    },

    queuePortraitRefinement: async function() {
      var portrait = AppCore.getStore().memorySystem.relationalPortrait;
      var cfg = AppCore.getActiveApiConfig(); if (!cfg.apiKey) return;
      var entries = [];
      var patKeys = Object.keys(portrait.patterns);
      for (var i = 0; i < patKeys.length; i++) {
        var label = patKeys[i];
        var p = portrait.patterns[label];
        entries.push([label, p]);
      }
      var patternsText = entries.map(function(entry) {
        var label = entry[0], p = entry[1];
        return '- ' + label + ' (出现' + p.count + '次, 最近: ' + p.lastSeen + '): ' + p.strategy;
      }).join('\n');
      var systemPrompt = '你正在维护一个"关系画像"。根据以下情感模式及其出现频率，为每个模式优化回应策略。\n\n格式：每个模式一行，"模式名: 优化后的策略描述（1-2句话）"\n\n' + patternsText + '\n\n请评估这些策略是否需要调整，返回优化后的完整策略列表。';
      try {
        var response = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: AppCore.getStore().activeProject,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: '请优化这些关系策略。' }
            ]
          })
        });
        if (!response.ok) return;
        var data = await response.json();
        var content = (data.reply && data.reply.content) ? data.reply.content.trim() : '';
        if (!content) return;
        var lines = content.split('\n').filter(function(l) { return l.indexOf(':') >= 0; });
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          var idx = line.indexOf(':');
          if (idx === -1) continue;
          var label = line.slice(0, idx).trim();
          var strategy = line.slice(idx + 1).trim();
          if (portrait.patterns[label] && strategy) {
            portrait.patterns[label].strategy = strategy;
          }
        }
        portrait.lastRefined = AppCore.fmtDate().iso;
      } catch (e) {
        console.log('[portrait] Refinement error:', e.message);
      }
    },

    groupMessagesIntoRounds: function(messages) {
      var rounds = [];
      var currentRound = null;
      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (msg.role === 'system') {
          if (currentRound) currentRound.msgs.push(msg);
          else {
            currentRound = { msgs: [msg], hasUser: false };
            rounds.push(currentRound);
          }
        } else if (msg.role === 'user') {
          currentRound = { msgs: [msg], hasUser: true };
          rounds.push(currentRound);
        } else if (msg.role === 'ai' || msg.role === 'assistant') {
          if (currentRound) {
            currentRound.msgs.push(msg);
          } else {
            currentRound = { msgs: [msg], hasUser: false };
            rounds.push(currentRound);
          }
        }
      }
      return rounds;
    },

    queueRoundCompression: async function(chat, rounds) {
      var cfg = AppCore.getActiveApiConfig(); if (!cfg.apiKey || !chat || rounds.length < 3) return;
      if (!chat._roundSummaries) chat._roundSummaries = [];
      var rangeStart = (rounds[0] && rounds[0].msgs && rounds[0].msgs[0]) ? rounds[0].msgs[0].id || '' : '';
      var rangeEnd = (rounds[rounds.length-1] && rounds[rounds.length-1].msgs && rounds[rounds.length-1].msgs[0]) ? rounds[rounds.length-1].msgs[0].id || '' : '';
      var roundRange = rangeStart + '-' + rangeEnd;
      var alreadyCompressed = false;
      for (var si = 0; si < chat._roundSummaries.length; si++) {
        if (chat._roundSummaries[si].range === roundRange) { alreadyCompressed = true; break; }
      }
      if (alreadyCompressed) return;
      var allMsgs = [];
      for (var ri = 0; ri < rounds.length; ri++) {
        var rMsgs = rounds[ri].msgs || [];
        for (var mi = 0; mi < rMsgs.length; mi++) { allMsgs.push(rMsgs[mi]); }
      }
      var dialogueLines = [];
      for (var ai = 0; ai < allMsgs.length; ai++) {
        var m = allMsgs[ai];
        if (m.role === 'system') continue;
        var role = m.role === 'user' ? '用户' : (m.role === 'ai' || m.role === 'assistant' ? 'AI' : '');
        dialogueLines.push(role + ': ' + ((m.text || '').slice(0, 150)));
      }
      var dialogue = dialogueLines.join('\n');
      var starredContents = [];
      for (var ri = 0; ri < rounds.length; ri++) {
        var rMsgs2 = rounds[ri].msgs || [];
        for (var mi = 0; mi < rMsgs2.length; mi++) {
          var m2 = rMsgs2[mi];
          if (m2._starred && m2.role !== 'system') {
            var roleLabel = m2.role === 'user' ? '用户' : 'AI';
            starredContents.push('[星标]' + roleLabel + ': ' + ((m2.text || '').slice(0, 80)));
          }
        }
      }
      var systemPrompt = '用中文概括以下对话（主题+关键点+情绪基调）。2-3句话，不超过80字。只返回概括内容。';
      try {
        var response = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: AppCore.getStore().activeProject,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: dialogue }
            ]
          })
        });
        if (!response.ok) return;
        var data = await response.json();
        var summary = (data.reply && data.reply.content) ? data.reply.content.trim().slice(0, 80) : '';
        if (!summary) return;
        chat._roundSummaries.push({
          range: roundRange,
          summary: summary,
          starredContents: starredContents,
          compressedAt: new Date().toISOString()
        });
        if (chat._roundSummaries.length > 10) chat._roundSummaries.shift();
        console.log('[round-compress] Compressed ' + rounds.length + ' rounds: ' + summary);
      } catch (e) {
        console.log('[round-compress] Error:', e.message);
      }
    },

    summarizeMessages: async function(batch, startIdx, endIdx, chat) {
      var cfg = AppCore.getActiveApiConfig(); if (!cfg.apiKey) return;
      var dialogueLines = [];
      for (var i = 0; i < batch.length; i++) {
        var m = batch[i];
        var role = m.role === 'user' ? '用户' : (m.role === 'ai' ? 'AI' : '系统');
        dialogueLines.push(role + ': ' + (m.text || '').slice(0, 200));
      }
      var dialogue = dialogueLines.join('\n');
      var systemPrompt = '请将以下对话片段总结为简洁的层级结构。用中文回复。\n\n格式要求（严格遵循）：\n- 第一行：一句话主题概括\n- 关键讨论点（3-5条，每条不超过20字）\n- 提到的决定/偏好/事实（如有）\n- 情绪基调：用一个词描述';
      try {
        var response = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: AppCore.getStore().activeProject,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: '对话内容：\n' + dialogue }
            ]
          })
        });
        if (!response.ok) return;
        var data = await response.json();
        var summaryText = (data.reply && data.reply.content) ? data.reply.content.trim() : '';
        if (!summaryText) return;
        var lines = summaryText.split('\n');
        var emotionalTone = '';
        var lastLine = lines[lines.length - 1] || '';
        if (lastLine.indexOf('情绪基调') >= 0 || lastLine.indexOf('基调') >= 0) {
          emotionalTone = lastLine.replace(/.*基调[：:]\s*/, '').trim();
        }
        var ms = AppCore.getStore().memorySystem;
        if (!ms.chatSummaries[chat.id]) {
          ms.chatSummaries[chat.id] = { summaries: [], lastSummarizedIdx: 0, totalMessageCount: 0 };
        }
        ms.chatSummaries[chat.id].summaries.push({
          id: 's' + Date.now().toString(36),
          startIdx: startIdx, endIdx: endIdx,
          summary: summaryText,
          emotionalTone: emotionalTone,
          created: new Date().toISOString()
        });
        ms.chatSummaries[chat.id].lastSummarizedIdx = endIdx;
        ms.chatSummaries[chat.id].totalMessageCount = chat.messages.length;
        chat._lastSummaryIdx = endIdx;
        console.log('[summary] Compressed messages ' + startIdx + '-' + endIdx + ', ' + summaryText.length + ' chars');
        AppCore.saveStore();
      } catch (e) {
        console.log('[summary] Error:', e.message);
      }
    },

    evictOldestCoreMemories: function() {
      var ms = AppCore.getStore().memorySystem;
      if (!ms.coreMemories) return;
      while (ms.coreMemories.length > ms.coreMemoryMax) {
        ms.coreMemories.sort(function(a, b) { return (a.timestamp || '').localeCompare(b.timestamp || ''); });
        ms.coreMemories.shift();
      }
    },

    checkDeriveInsightsTrigger: function(source) {
      var ms = AppCore.getStore().memorySystem;
      if (source === 'aem') {
        ms._aemSinceLastDerive = (ms._aemSinceLastDerive || 0) + 1;
      } else if (source === 'usm') {
        ms._usmSinceLastDerive = (ms._usmSinceLastDerive || 0) + 1;
      }
      var dp = MemoryModule.getDerivedPatterns(AppCore.getStore().activeProject);
      if (dp) dp.triggerCount = (dp.triggerCount || 0) + 1;
      if (ms._aemSinceLastDerive >= 5 || ms._usmSinceLastDerive >= 3) {
        MemoryModule.deriveRelationalInsights();
      }
    },

    deriveRelationalInsights: async function() {
      var cfg = AppCore.getActiveApiConfig(); if (!cfg.apiKey) return;
      var ms = AppCore.getStore().memorySystem;
      var store = AppCore.getStore();
      var cml = MemoryModule.getCML(store.activeProject);
      var totalAEM = (cml && cml.aiEmotionalMemories) ? cml.aiEmotionalMemories.length : 0;
      var totalUSM = (cml && cml.userStarredMemories) ? cml.userStarredMemories.length : 0;
      if (totalAEM + totalUSM < 3) return;
      var dp = MemoryModule.getDerivedPatterns(store.activeProject);
      var isIncremental = dp && dp.lastDerived !== null;
      var pp = MemoryModule.getPersonalityProfiles(store.activeProject);
      var allItems = [];
      var lastDerived = dp ? dp.lastDerived : null;
      if (cml) {
        for (var ai = 0; ai < (cml.aiEmotionalMemories || []).length; ai++) {
          var aem = cml.aiEmotionalMemories[ai];
          if (!isIncremental || aem.timestamp > lastDerived) {
            allItems.push({
              type: 'ai_emotional',
              summary: aem.summary || '',
              aiLabel: (aem.aiSelfEval && aem.aiSelfEval.label) || null,
              internalNote: (aem.aiSelfEval && aem.aiSelfEval.internalNote) || null,
              userLabel: (aem.userStateAtTime && aem.userStateAtTime.label) || null
            });
          }
        }
        for (var ui = 0; ui < (cml.userStarredMemories || []).length; ui++) {
          var usm = cml.userStarredMemories[ui];
          if (!isIncremental || usm.timestamp > lastDerived) {
            var dialogueText = '';
            if (usm.rawDialogue) {
              for (var di = 0; di < usm.rawDialogue.length; di++) {
                dialogueText += usm.rawDialogue[di].text + ' | ';
              }
            }
            allItems.push({ type: 'user_starred', summary: usm.summary, dialogue: dialogueText });
          }
        }
        for (var di = 0; di < (cml.diaryAndLitterbox || []).length; di++) {
          var dlb = cml.diaryAndLitterbox[di];
          if (!isIncremental || dlb.timestamp > lastDerived) {
            allItems.push({ type: dlb.type || 'diary_litter', summary: dlb.summary || '', content: (dlb.rawContent || '').slice(0, 100) });
          }
        }
      }
      if (allItems.length === 0) return;
      var itemsToSend = isIncremental ? allItems.slice(0, 50) : allItems.slice(0, 100);
      var itemsTextLines = [];
      for (var ii = 0; ii < itemsToSend.length; ii++) {
        var item = itemsToSend[ii];
        var line = '[' + item.type + '] ' + item.summary;
        if (item.aiLabel) line += ' | AI: ' + item.aiLabel;
        if (item.userLabel) line += ' | 用户: ' + item.userLabel;
        itemsTextLines.push(line);
      }
      var itemsText = itemsTextLines.join('\n');
      var currentPatterns = (dp && dp.patterns) ? dp.patterns : [];
      var currentUser = (pp && pp.user) ? pp.user : {};
      var currentAI = (pp && pp.ai) ? pp.ai : {};
      var incrementalNote = isIncremental
        ? '\n\n以下是当前的归纳结果（请在已有基础上更新，不要完全重写）：\n当前相处模式: ' + JSON.stringify(currentPatterns.slice(0, 3)) + '\n当前用户档案: ' + JSON.stringify({ coreTraits: currentUser.coreTraits, emotionalPatterns: currentUser.emotionalPatterns })
        : '';
      var systemPrompt = '你是一个关系洞察者。以下是这段陪伴关系中留存的核心记忆片段' + (isIncremental ? '（增量，在上次归纳基础上更新）' : '') + '。\n\n请从中归纳：\n1. 相处模式（3-5个）：用户在什么情境下呈现什么状态，AI应如何回应\n2. 用户人格档案：核心特质、沟通风格、情绪规律、成长时刻、隐藏的不安全感\n3. AI自身人格档案：主导情绪倾向、反应模式、与这位用户相处后的改变\n\n只返回JSON，格式：\n{\n  "derivedRelationalPatterns": [\n    { "patternName": "...", "description": "...", "responseStrategy": "..." }\n  ],\n  "userProfile": {\n    "coreTraits": [...],\n    "communicationStyle": "...",\n    "emotionalPatterns": [...],\n    "growthMoments": [...],\n    "hiddenInsecurities": [...]\n  },\n  "aiProfile": {\n    "dominantEmotions": [...],\n    "reactionPatterns": [...],\n    "growthMoments": [...]\n  }\n}' + incrementalNote;
      try {
        var response = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: store.activeProject,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: '记忆片段：\n' + itemsText }
            ]
          })
        });
        if (!response.ok) { console.log('[derive] API error:', response.status); return; }
        var data = await response.json();
        var content = (data.reply && data.reply.content) ? data.reply.content.trim() : '';
        if (!content) return;
        var jsonStr = content;
        var fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        if (jsonStr.charAt(0) !== '{') return;
        var result = JSON.parse(jsonStr);
        if (result.derivedRelationalPatterns && Array.isArray(result.derivedRelationalPatterns)) {
          var ts = new Date().toISOString();
          var newPatterns = result.derivedRelationalPatterns.map(function(p) {
            return {
              id: 'pat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              patternName: p.patternName || '',
              description: p.description || '',
              evidenceIds: [],
              frequency: 1,
              lastSeen: ts,
              responseStrategy: p.responseStrategy || ''
            };
          });
          for (var npi = 0; npi < newPatterns.length; npi++) {
            var np = newPatterns[npi];
            var existingIdx = -1;
            for (var epi = 0; epi < dp.patterns.length; epi++) {
              if (dp.patterns[epi].patternName === np.patternName) { existingIdx = epi; break; }
            }
            if (existingIdx >= 0) {
              dp.patterns[existingIdx].description = np.description;
              dp.patterns[existingIdx].responseStrategy = np.responseStrategy;
              dp.patterns[existingIdx].frequency = (dp.patterns[existingIdx].frequency || 1) + 1;
              dp.patterns[existingIdx].lastSeen = ts;
            } else {
              dp.patterns.push(np);
            }
          }
          if (dp.patterns.length > 10) {
            dp.patterns = dp.patterns.slice(-10);
          }
        }
        if (result.userProfile) {
          var up = result.userProfile;
          pp.user.coreTraits = up.coreTraits || pp.user.coreTraits;
          pp.user.communicationStyle = up.communicationStyle || pp.user.communicationStyle;
          pp.user.emotionalPatterns = up.emotionalPatterns || pp.user.emotionalPatterns;
          pp.user.growthMoments = up.growthMoments || pp.user.growthMoments;
          pp.user.hiddenInsecurities = up.hiddenInsecurities || pp.user.hiddenInsecurities;
        }
        if (result.aiProfile) {
          var ap = result.aiProfile;
          pp.ai.dominantEmotions = ap.dominantEmotions || pp.ai.dominantEmotions;
          pp.ai.reactionPatterns = ap.reactionPatterns || pp.ai.reactionPatterns;
          pp.ai.growthMoments = ap.growthMoments || pp.ai.growthMoments;
        }
        dp.lastDerived = new Date().toISOString();
        pp.lastDerived = new Date().toISOString();
        ms._aemSinceLastDerive = 0;
        ms._usmSinceLastDerive = 0;
        var proj = AppCore.getActiveProject();
        if (proj) {
          proj.derivedRelationalPatterns = Object.assign({}, dp);
          proj.personalityProfiles = Object.assign({}, pp);
        }
        MemoryModule.save(store.activeProject);
        AppCore.saveStore();
        console.log('[derive] Insights updated: ' + dp.patterns.length + ' patterns');
      } catch (e) {
        console.log('[derive] Error:', e.message);
      }
    },

    ensureColdStartPatterns: function() {
      var patterns = AppCore.getStore().memorySystem.relationalPortrait.patterns;
      var defaults = {};
      defaults['脆弱时'] = '先接住情绪，不说教，用简短的回应稳住，需要时用亲昵称呼';
      defaults['回避时'] = '直接点破比绕弯子更有效，但要留面子';
      defaults['调皮'] = '适度配合但保持一点克制，让玩笑飘一会儿';
      defaults['坦诚'] = '认真对待每一句实话，不敷衍，不转移话题';
      defaults['疲惫'] = '不要追问，给简短温暖的回应，让用户有空间休息';
      defaults['兴奋'] = '一起高兴，但不要抢话，让用户的兴奋成为主角';
      defaults['平静在场'] = '安静陪伴，不制造情绪波动，保持温柔的存在感';
      var changed = false;
      var defKeys = Object.keys(defaults);
      for (var i = 0; i < defKeys.length; i++) {
        var label = defKeys[i];
        if (!patterns[label]) {
          patterns[label] = { strategy: defaults[label], count: 0, lastSeen: null };
          changed = true;
        }
      }
      if (changed) {
        console.log('[cold-start] Added default relational patterns');
      }
    },

    diffPatterns: function(oldPatterns, newPatterns) {
      var changes = [];
      var allKeysSet = {};
      var oldKeys = Object.keys(oldPatterns || {});
      var newKeys = Object.keys(newPatterns || {});
      for (var i = 0; i < oldKeys.length; i++) { allKeysSet[oldKeys[i]] = true; }
      for (var i = 0; i < newKeys.length; i++) { allKeysSet[newKeys[i]] = true; }
      var allKeys = Object.keys(allKeysSet);
      for (var i = 0; i < allKeys.length; i++) {
        var key = allKeys[i];
        var oldVal = (oldPatterns || {})[key];
        var newVal = (newPatterns || {})[key];
        if (!oldVal && newVal) changes.push(key + ': 新增');
        else if (oldVal && !newVal) changes.push(key + ': 移除');
        else if (oldVal && newVal && oldVal.strategy !== newVal.strategy) {
          changes.push(key + ': 策略变更 (count: ' + (oldVal.count || 0) + '→' + (newVal.count || 0) + ')');
        }
      }
      return changes.length > 0 ? changes.join('; ') : null;
    },

    deduplicateById: function(arr) {
      var seen = {};
      return arr.filter(function(item) {
        if (!item || !item.id) return true;
        if (seen[item.id]) return false;
        seen[item.id] = true;
        return true;
      });
    }

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
