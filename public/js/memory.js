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
  var _cache = {};          // { [projectId]: { aems[], usms[], dlbs[], derivedPatterns, personalityProfiles, reflections[], affectGraph, evictedMessages[], deriveTriggers, lastMaintenance, coreOverview, _loaded } }
  var _dirty = {};          // { [projectId]: bool }
  var _syncTimers = {};     // { [projectId]: timeoutId }
  var _bm25 = {};           // { [projectId]: { _dirty, _lastBuild, _docCount, index } }
  var _labelCatalog = null; // { primaryLabel: [secondaryLabel, ...] }, cached from /api/labels

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
          _cache[projectId].reflections = cached.reflections || [];
          _cache[projectId].affectGraph = cached.affectGraph || { edges: {} };
          _cache[projectId].evictedMessages = cached.evictedMessages || [];
          _cache[projectId].deriveTriggers = cached.deriveTriggers || { aemSince: 0, usmSince: 0, lastWeekly: '' };
          _cache[projectId].lastMaintenance = cached.lastMaintenance || '';
          _cache[projectId].coreOverview = cached.coreOverview || null;
          _cache[projectId]._labelMigrationDone = cached._labelMigrationDone || false;
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

      // 2.5 Load core overview from Supabase (fix: was never wired into load())
      try { await MemoryModule.loadCoreOverview(projectId); } catch (e) { /* non-fatal */ }

      // 3. One-time label/edge field migration (idempotent, gated by _labelMigrationDone)
      migrateLabelFields(projectId);

      // 4. Backfill unified core fields on existing USMs (idempotent)
      var c = _cache[projectId];
      c.usms.forEach(function(u) { u.starred = true; if (u.decayFactor === undefined) u.decayFactor = 1; });
      // Cleanup: remove fully-decayed non-starred items, enforce cap
      c.aems = c.aems.filter(function(m) { return m.starred || (m.decayFactor === undefined) || (m.decayFactor || 0) > 0; });
      if (c.aems.length > AEM_CAP) c.aems.length = AEM_CAP;
      c.usms = c.usms.filter(function(m) { return m.starred || (m.decayFactor === undefined) || (m.decayFactor || 0) > 0; });
      if (c.usms.length > USM_CAP) c.usms.length = USM_CAP;

      // 4. Rebuild search index
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

    /** Immediate Supabase sync (no debounce). For new/updated memories only. */
    syncNow: function(projectId) {
      if (!projectId) return;
      clearSyncTimer(projectId);
      pushToSupabase(projectId);
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
          return m.starred || (m.decayFactor === undefined) || (m.decayFactor || 0) > 0;
        });
        // Hard cap: keep newest 200
        if (c.aems.length > AEM_CAP) c.aems.length = AEM_CAP;
      }
      _bm25[projectId] = rebuildBM25Sync(projectId);
      MemoryModule.save(projectId);
      MemoryModule.syncNow(projectId);
    },

    /**
     * Add a User Starred Memory.
     * @param {string} projectId
     * @param {Object} usm — { id, timestamp, sourceChatId, sourceWindowId, sourceProjectId, rawDialogue, summary, starredMsgIds, userNote }
     */
    addUSM: function(projectId, usm) {
      if (!projectId || !usm || !usm.id) return;
      // Unify core fields: a USM is always a starred memory
      usm.starred = true;
      if (usm.decayFactor === undefined) usm.decayFactor = 1;
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
      MemoryModule.syncNow(projectId);
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
      if (found) {
        MemoryModule.save(projectId);
        MemoryModule.syncNow(projectId);
      }
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
     * Synchronous read of the core overview (Coreview).
     * @param {string} projectId
     * @returns {{text:string, updatedAt:string, updatedBy:string, history:Array}|null}
     */
    getCoreOverview: function(projectId) {
      var c = _cache[projectId];
      return (c && c.coreOverview) || null;
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
      var proj = null;
      var projects = AppCore.getStore().projects;
      for (var pj = 0; pj < projects.length; pj++) {
        if (projects[pj].id === projectId) { proj = projects[pj]; break; }
      }
      var results = [];
      for (var id in scores) {
        if (!scores.hasOwnProperty(id)) continue;
        var mem = findByIdAnyLayer(c, id);
        var layer = 'ai_emotional';
        if (mem) {
          layer = guessLayer(c, id);
        } else if (proj) {
          var ltmIdx = findIndexById(proj.memories || [], id);
          if (ltmIdx >= 0) { mem = proj.memories[ltmIdx]; layer = 'long_term'; }
        }
        if (!mem) continue;
        results.push({
          id: id,
          content: mem.summary || mem.content || '',
          type: mem.type || 'aem',
          layer: layer,
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
    getReflections: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].reflections; },
    addReflection: function(projectId, entry){ ensureCacheEntry(projectId); var r=_cache[projectId].reflections; r.unshift(entry); if(r.length>REFLECTION_MAX)r.length=REFLECTION_MAX; },
    getAffectGraph: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].affectGraph; },
    updateAffectGraphEdge: function(projectId, key){ ensureCacheEntry(projectId); var edges=_cache[projectId].affectGraph.edges; edges[key]=(edges[key]||0)+1; },
    getEvictedMessages: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].evictedMessages; },
    addEvictedMessage: function(projectId, msg){ ensureCacheEntry(projectId); var ev=_cache[projectId].evictedMessages; ev.push(msg); if(ev.length>50)ev.shift(); },
    clearEvictedMessages: function(projectId){ ensureCacheEntry(projectId); _cache[projectId].evictedMessages=[]; },
    getDeriveTriggers: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].deriveTriggers; },
    incrementDeriveTrigger: function(projectId, source){ ensureCacheEntry(projectId); var dt=_cache[projectId].deriveTriggers; if(source==='aem')dt.aemSince=(dt.aemSince||0)+1; else if(source==='usm')dt.usmSince=(dt.usmSince||0)+1; },
    resetDeriveTriggers: function(projectId){ ensureCacheEntry(projectId); _cache[projectId].deriveTriggers={aemSince:0,usmSince:0,lastWeekly:''}; },
    getLastMaintenance: function(projectId){ ensureCacheEntry(projectId); return _cache[projectId].lastMaintenance; },
    setLastMaintenance: function(projectId, date){ ensureCacheEntry(projectId); _cache[projectId].lastMaintenance=date; },
    getRetention: function(){ return RETENTION; },

    // ── USM generation: standalone fetch with identity context ──
    generateUSM: async function(usmId, rawDialogue) {
      var store = AppCore.getStore();
      var cfg = AppCore.getActiveApiConfig();
      if (!cfg || !cfg.apiKey) {
        console.log('[USM] No API key configured, skip generation');
        return;
      }
      var proj = AppCore.getActiveProject();
      var chat = AppCore.getActiveChatObj();
      if (!proj || !chat) return;

      // Identity: Core overview
      var co = _cache[store.activeProject] && _cache[store.activeProject].coreOverview;
      var coreText = co && co.text ? co.text.slice(0, 500) : '';

      // Recent 10 rounds of conversation
      var allRounds = MemoryModule.groupMessagesIntoRounds(chat.messages || []);
      var recentRounds = allRounds.slice(-10);
      var recentDialogue = '';
      for (var ri = 0; ri < recentRounds.length; ri++) {
        var msgs = recentRounds[ri].msgs || [];
        for (var mi = 0; mi < msgs.length; mi++) {
          if (msgs[mi].role === 'system') continue;
          recentDialogue += (msgs[mi].role === 'user' ? '用户' : 'AI') + '：' + (msgs[mi].text || '').slice(0, 150) + '\n';
        }
      }

      // Latest 3 USMs + AEMs
      var cml = MemoryModule.getCML(store.activeProject);
      var recentUSMs = (cml && cml.userStarredMemories || []).slice(0, 3);
      var recentAEMs = (cml && cml.aiEmotionalMemories || []).slice(0, 3);
      var usmContext = recentUSMs.length > 0 ? '【最近USM3条】\n' + recentUSMs.map(function(u) { return (u.summary || '').slice(0, 50); }).join('\n') + '\n\n' : '';
      var aemContext = recentAEMs.length > 0 ? '【最近AEM3条】\n' + recentAEMs.map(function(a) { return (a.summary || '').slice(0, 50); }).join('\n') + '\n\n' : '';

      var starText = rawDialogue.map(function(m) { return (m.role === 'user' ? '用户' : 'AI') + '：' + (m.text || '').slice(0, 150); }).join('\n');

      var pref = (proj && proj.preference) ? proj.preference.trim().slice(0, 500) : '';
      var systemPrompt = '你是温暖的陪伴者。\n'
        + (coreText ? '【Core概述】\n' + coreText + '\n\n' : '')
        + (pref ? '【用户偏好】\n' + pref + '\n\n' : '')
        + '用户标记了以下消息为星标，作为你和她的锚点记忆。请完成三件事：\n'
        + '1. 用一句话（30字以内）概括这段对话中的事实，以及对你们的意义。\n'
        + '2. 从下方标签目录里，为这条记忆选一个最匹配的主标签和副标签（副标签必须是该主标签下的）。选不到就填「未分类」。\n'
        + '3. 给出2-3个语义关键词（每个不超过5字），用逗号分隔。\n'
        + '【标签目录】\n' + _serializeCatalog() + '\n'
        + '严格按以下格式返回，不要加引号、不要多余文字：\n'
        + '概括：<30字以内>\n'
        + '主标签：<目录中的主标签，选不到填"未分类">\n'
        + '副标签：<目录中的副标签，选不到留空>\n'
        + '关键词：<词1>,<词2>,<词3>';

      var userPrompt = '【最近的对话】\n' + recentDialogue + '\n' + usmContext + aemContext + '【要概括的星标对话】\n' + starText;

      try {
        var resp = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: store.activeProject,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
        });
        if (!resp.ok) throw new Error('API ' + resp.status);
        var data = await resp.json();
        if (data.usage) {
          AppCore.logTokenCall(store.activeChat, 'usm',
            data.usage.input_tokens || data.usage.prompt_tokens || 0,
            data.usage.output_tokens || data.usage.completion_tokens || 0,
            data.usage.cache_read_input_tokens || 0,
            data.usage.cache_creation_input_tokens || 0,
            cfg.model);
        }
        var raw = (data.reply && data.reply.content) ? data.reply.content.trim() : '';
        var sumMatch = raw.match(/概括[：:]\s*(.+)/);
        var plMatch = raw.match(/主标签[：:]\s*(.+)/);
        var slMatch = raw.match(/副标签[：:]\s*(.+)/);
        var kwMatch = raw.match(/关键词[：:]\s*(.+)/);
        var summary = (sumMatch ? sumMatch[1] : raw).trim().slice(0, 30);
        var primary = plMatch ? plMatch[1].trim() : '未分类';
        var secondary = slMatch ? slMatch[1].trim() : '';
        if (secondary === '留空' || secondary === '空' || secondary === '') secondary = null;
        var keywords = kwMatch ? _splitKeywords(kwMatch[1]) : [];
        if (summary && summary.length >= 3) {
          MemoryModule.update(store.activeProject, usmId, {
            summary: summary, primaryLabel: primary, secondaryLabel: secondary,
            semanticKeywords: keywords, emotionalLabels: []
          });
          var usmObj = null;
          var usms = (_cache[store.activeProject] && _cache[store.activeProject].usms) || [];
          for (var ui = 0; ui < usms.length; ui++) { if (usms[ui].id === usmId) { usmObj = usms[ui]; break; } }
          if (usmObj) MemoryModule.buildRelatedEdges(store.activeProject, usmObj);
          AppCore.saveStore();
          console.log('[USM] Generated:', summary);
        } else {
          console.log('[USM] Generation returned empty summary');
        }
      } catch (e) {
        console.log('[USM] Generate error:', e.message);
      }
    },

    // ── LTM generation: standalone fetch ──
    generateLTM: async function() {
      var store = AppCore.getStore();
      var cfg = AppCore.getActiveApiConfig();
      if (!cfg || !cfg.apiKey) return;
      var proj = AppCore.getActiveProject();
      if (!proj) return;

      // Identity context
      var co = _cache[store.activeProject] && _cache[store.activeProject].coreOverview;
      var coreText = co && co.text ? co.text.slice(0, 500) : '';

      // Recent 10 rounds (user + AI, skip system), truncated to 500 chars
      var chat = AppCore.getActiveChatObj();
      var allRounds = MemoryModule.groupMessagesIntoRounds(chat ? chat.messages || [] : []);
      var recentRounds = allRounds.slice(-10);
      var recentDialogue = '';
      var rawDialogue = [];
      for (var ri2 = 0; ri2 < recentRounds.length; ri2++) {
        var msgs2 = recentRounds[ri2].msgs || [];
        for (var mi2 = 0; mi2 < msgs2.length; mi2++) {
          if (msgs2[mi2].role === 'system') continue;
          recentDialogue += (msgs2[mi2].role === 'user' ? '用户' : 'AI') + '：' + (msgs2[mi2].text || '') + '\n';
          rawDialogue.push({ role: msgs2[mi2].role === 'user' ? 'user' : 'assistant', text: (msgs2[mi2].text || '').slice(0, 150), time: msgs2[mi2].time || '', msgId: msgs2[mi2].id || '' });
        }
      }
      recentDialogue = recentDialogue.slice(0, 500);

      var cml = MemoryModule.getCML(store.activeProject);
      var recentUSMs = (cml && cml.userStarredMemories || []).slice(0, 3);
      var recentAEMs = (cml && cml.aiEmotionalMemories || []).slice(0, 3);
      var recentLTMs = (proj && proj.memories || []).slice(0, 3);
      var usmCtx = recentUSMs.length ? '【最近USM3条】\n' + recentUSMs.map(function(u) { return (u.summary || '').slice(0, 50); }).join('\n') + '\n\n' : '';
      var aemCtx = recentAEMs.length ? '【最近AEM3条】\n' + recentAEMs.map(function(a) { return (a.summary || '').slice(0, 50); }).join('\n') + '\n\n' : '';
      var ltmCtx = recentLTMs.length ? '【最近LTM3条】\n' + recentLTMs.map(function(l) { return (l.content || l.summary || '').slice(0, 50); }).join('\n') + '\n\n' : '';

      var pref = (proj && proj.preference) ? proj.preference.trim().slice(0, 500) : '';
      var systemPrompt = '你是温暖的陪伴者。\n'
        + (coreText ? '【Core概述】\n' + coreText + '\n\n' : '')
        + (pref ? '【用户偏好】\n' + pref + '\n\n' : '')
        + '从以下对话中提取一个关于她或者你自己的事实性的记忆。请完成：\n'
        + '1. 用一句中文概括（不超过30字）。\n'
        + '2. 给出2-3个语义关键词（每个不超过5字），用逗号分隔。\n'
        + '3. 从下方标签目录里，为这条记忆选一个最匹配的主标签和副标签（副标签必须是该主标签下的）。选不到就填「未分类」。\n'
        + '【标签目录】\n' + _serializeCatalog() + '\n'
        + '严格按以下格式返回，不要加引号、不要多余文字：\n'
        + '记忆：<30字以内>\n'
        + '关键词：<词1>,<词2>,<词3>\n'
        + '主标签：<目录中的主标签，选不到填"未分类">\n'
        + '副标签：<目录中的副标签，选不到留空>';
      var userPrompt = '【最近的对话】\n' + recentDialogue + '\n' + usmCtx + aemCtx + ltmCtx;

      try {
        var resp = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: store.activeProject,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
        });
        if (!resp.ok) return;
        var data = await resp.json();
        if (data.usage) {
          AppCore.logTokenCall(store.activeChat, 'ltm',
            data.usage.input_tokens || data.usage.prompt_tokens || 0,
            data.usage.output_tokens || data.usage.completion_tokens || 0,
            data.usage.cache_read_input_tokens || 0,
            data.usage.cache_creation_input_tokens || 0,
            cfg.model);
        }
        var content = (data.reply && data.reply.content) ? data.reply.content.trim() : '';
        if (!content) return;
        var memMatch = content.match(/记忆[：:]\s*(.+)/);
        var kwMatch = content.match(/关键词[：:]\s*(.+)/);
        var plMatch = content.match(/主标签[：:]\s*(.+)/);
        var slMatch = content.match(/副标签[：:]\s*(.+)/);
        var memContent = memMatch ? memMatch[1].trim().slice(0, 30) : content.slice(0, 30);
        var semanticKey = kwMatch ? kwMatch[1].trim() : '';
        var keywords = _splitKeywords(semanticKey);
        var primary = plMatch ? plMatch[1].trim() : '未分类';
        var secondary = slMatch ? slMatch[1].trim() : '';
        if (secondary === '留空' || secondary === '空' || secondary === '') secondary = null;
        if (memContent && memContent.length >= 3 && !MemoryModule.isNearDuplicate(memContent, proj)) {
          var todayISO = new Date().toISOString().slice(0, 10);
          var ltm = {
            id: 'ltm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            content: memContent, summary: memContent, date: todayISO, type: 'long_term', starred: false,
            semanticKey: semanticKey, semanticKeywords: keywords, primaryLabel: primary, secondaryLabel: secondary,
            emotionalLabels: [], relatedMemoryIds: [],
            sourceChatId: store.activeChat, sourceProjectId: store.activeProject,
            timestamp: new Date().toISOString(), week: AppCore.weekLabel(),
            rawDialogue: rawDialogue
          };
          proj.memories.push(ltm);
          if (_bm25[store.activeProject]) _bm25[store.activeProject]._dirty = true;
          AppCore.saveStore();
          MemoryModule.buildRelatedEdges(store.activeProject, ltm);
          MemoryModule.syncNow(store.activeProject);
          console.log('[LTM] Generated:', memContent);
        }
      } catch (e) {
        console.log('[LTM] Generate error:', e.message);
      }
    },
    checkLongTerm: function(chat) {
      if (!chat) return;
      var cfg = AppCore.getActiveApiConfig(); if (!cfg || !cfg.apiKey) return;
      var count = chat._messageCount || 0;
      if (count === 0 || count % 10 !== 0) return;
      var last10 = chat.messages.slice(-10);
      if (last10.length < 6) return;
      // Fire standalone LLM call with identity context
      MemoryModule.generateLTM().catch(function(e) {
        console.log('[LTM] Background generation failed:', e.message);
      });
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

    unifiedSearch: function(queryText) {
      if (!queryText || queryText.trim().length === 0) return [];
      var query = queryText.trim();
      var projectId = AppCore.getStore().activeProject;
      var queryTerms = MemoryModule.tokenizeChinese(query);
      var bm25Results = MemoryModule.search(projectId, query);
      var knownLabels = ['被触动','想追问但没问','克制后反弹','克制表达','放松','警觉','脆弱','调皮','疲惫','兴奋','回避','坦诚','平静在场','安心','落空','感伤','心动','骄傲','担心','依赖','低落'];
      var matchedLabels = knownLabels.filter(function(l) { return query.indexOf(l) >= 0 || l.indexOf(query) >= 0; });
      var affectResults = matchedLabels.length > 0 ? MemoryModule.searchByAffect(matchedLabels) : [];
      var semanticResults = MemoryModule.searchBySemanticKey(queryTerms);
      var merged = {};
      for (var i = 0; i < bm25Results.length; i++) {
        var r = bm25Results[i];
        merged[r.id] = Object.assign({}, r, { _source: 'bm25', _bm25Score: r.score, _score: r.score });
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
      var projectId = AppCore.getStore().activeProject;
      var results = MemoryModule.search(projectId, query);
      return results.map(function(r) { return { id: r.id, score: r.score, content: r.content, type: r.type, layer: r.layer }; });
    },

    searchByAffect: function(queryLabels) {
      if (!queryLabels || queryLabels.length === 0) return [];
      var projectId = AppCore.getStore().activeProject;
      var c = _cache[projectId];
      if (!c) return [];
      var results = [];
      var aems = c.aems || [];
      for (var ci = 0; ci < aems.length; ci++) {
        var aem = aems[ci];
        var aiLabel = (aem.aiSelfEval && aem.aiSelfEval.label) || '';
        var userLabel = (aem.userStateAtTime && aem.userStateAtTime.label) || '';
        var matched = [];
        for (var ql = 0; ql < queryLabels.length; ql++) {
          if (queryLabels[ql] === aiLabel || queryLabels[ql] === userLabel) matched.push(queryLabels[ql]);
        }
        if (matched.length > 0) {
          var intensity = ((aem.aiSelfEval && aem.aiSelfEval.intensity) || 0) + ((aem.userStateAtTime && aem.userStateAtTime.intensity) || 0);
          var aemCopy = Object.assign({}, aem);
          aemCopy.content = aem.summary || aemCopy.content || '';
          aemCopy._score = intensity * matched.length;
          aemCopy._source = 'affect';
          results.push(aemCopy);
        }
      }
      results.sort(function(a, b) { return (b._score || 0) - (a._score || 0); });
      return results.slice(0, 10);
    },

    searchBySemanticKey: function(queryKeywords) {
      if (!queryKeywords || queryKeywords.length === 0) return [];
      var results = [];
      function pushIfMatch(mem) {
        if (!mem || !mem.semanticKey) return;
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
          memCopy.content = mem.summary || mem.content || '';
          memCopy._score = overlap * 3;
          memCopy._source = 'semantic';
          results.push(memCopy);
        }
      }
      var projects = AppCore.getStore().projects;
      for (var pi = 0; pi < projects.length; pi++) {
        var proj = projects[pi];
        var mems = proj.memories || [];
        for (var mi = 0; mi < mems.length; mi++) pushIfMatch(mems[mi]);
        // USMs may also carry a semanticKey (carried over on LTM→USM upgrade)
        var usmC = _cache[proj.id];
        var usms = (usmC && usmC.usms) || [];
        for (var ui = 0; ui < usms.length; ui++) pushIfMatch(usms[ui]);
      }
      results.sort(function(a, b) { return b._score - a._score; });
      return results.slice(0, 10);
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
      // Capture last 2 rounds of conversation as context
      var context = [];
      if (chat && chat.messages) {
        var recentMsgs = [];
        for (var i = chat.messages.length - 1; i >= 0 && recentMsgs.length < 4; i--) {
          var m = chat.messages[i];
          if (m.role === 'user' || m.role === 'ai' || m.role === 'assistant') {
            recentMsgs.unshift({ role: m.role === 'assistant' ? 'assistant' : m.role, content: (m.text || '').slice(0, 200), time: m.time || '' });
          }
        }
        context = recentMsgs;
      }
      var emotionalLabels = [];
      if (reflection.ai_affect_label) emotionalLabels.push(reflection.ai_affect_label);
      if (reflection.user_affect_label && emotionalLabels.indexOf(reflection.user_affect_label) === -1) emotionalLabels.push(reflection.user_affect_label);
      var aem = {
        id: id, timestamp: ts,
        sourceChatId: AppCore.getStore().activeChat, sourceWindowId: AppCore.getStore().activeChat, sourceProjectId: AppCore.getStore().activeProject,
        aiSelfEval: { label: reflection.ai_affect_label, intensity: reflection.ai_affect_intensity || 5, internalNote: memMarker.internalNote || memMarker.summary },
        userStateAtTime: { label: reflection.user_affect_label, intensity: reflection.user_affect_intensity || 5 },
        summary: memMarker.summary, rawDialogue: rawDialogue, context: context, triggerSource: 'high_intensity',
        semanticKeywords: (memMarker.keywords || []).slice(0, 5),
        emotionalLabels: emotionalLabels,
        relatedMemoryIds: []
      };
      MemoryModule.addAEM(AppCore.getStore().activeProject, aem);
      MemoryModule.buildRelatedEdges(AppCore.getStore().activeProject, aem);
      if (chat) chat.messages.push({ role: 'system', text: '有什么被记住了', time: AppCore.nowTime() });
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

    checkDeriveInsightsTrigger: function(source) {
      var ms = AppCore.getStore().memorySystem;
      if (source === 'aem') {
        ms._aemSinceLastDerive = (ms._aemSinceLastDerive || 0) + 1;
      } else if (source === 'usm') {
        ms._usmSinceLastDerive = (ms._usmSinceLastDerive || 0) + 1;
      }
      if (ms._aemSinceLastDerive >= 5 || ms._usmSinceLastDerive >= 3) {
        MemoryModule.generateCoreOverview();
      }
    },

    generateCoreOverview: async function() {
      var cfg = AppCore.getActiveApiConfig(); if (!cfg.apiKey) return;
      var ms = AppCore.getStore().memorySystem;
      var store = AppCore.getStore();
      var cml = MemoryModule.getCML(store.activeProject);
      var totalAEM = (cml && cml.aiEmotionalMemories) ? cml.aiEmotionalMemories.length : 0;
      var totalUSM = (cml && cml.userStarredMemories) ? cml.userStarredMemories.length : 0;
      if (totalAEM + totalUSM < 3) return;
      var co = _cache[store.activeProject].coreOverview;
      var isIncremental = co && co.updatedAt !== null;
      var allItems = [];
      var lastDerived = isIncremental ? co.updatedAt : null;
      if (cml) {
        for (var ai = 0; ai < (cml.aiEmotionalMemories || []).length; ai++) {
          var aem = cml.aiEmotionalMemories[ai];
          if (!isIncremental || aem.timestamp > lastDerived) {
            var rawText = '';
            if (aem.rawDialogue) {
              for (var rdi = 0; rdi < aem.rawDialogue.length; rdi++) {
                rawText += (aem.rawDialogue[rdi].role === 'user' ? '用户' : 'AI') + '：' + (aem.rawDialogue[rdi].text || '').slice(0, 200) + ' | ';
              }
            }
            allItems.push({
              type: 'ai_emotional',
              summary: aem.summary || '',
              aiLabel: (aem.aiSelfEval && aem.aiSelfEval.label) || null,
              internalNote: (aem.aiSelfEval && aem.aiSelfEval.internalNote) || null,
              userLabel: (aem.userStateAtTime && aem.userStateAtTime.label) || null,
              rawDialogue: rawText
            });
          }
        }
        for (var ui = 0; ui < (cml.userStarredMemories || []).length; ui++) {
          var usm = cml.userStarredMemories[ui];
          if (!isIncremental || usm.timestamp > lastDerived) {
            var dialogueText = '';
            if (usm.rawDialogue) {
              for (var di = 0; di < usm.rawDialogue.length; di++) {
                dialogueText += (usm.rawDialogue[di].role === 'user' ? '用户' : 'AI') + '：' + (usm.rawDialogue[di].text || '').slice(0, 200) + ' | ';
              }
            }
            allItems.push({ type: 'user_starred', summary: usm.summary, rawDialogue: dialogueText });
          }
        }
        for (var di = 0; di < (cml.diaryAndLitterbox || []).length; di++) {
          var dlb = cml.diaryAndLitterbox[di];
          if (!isIncremental || dlb.timestamp > lastDerived) {
            allItems.push({ type: dlb.type || 'diary_litter', summary: dlb.summary || '', content: (dlb.rawContent || '').slice(0, 200) });
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
        if (item.rawDialogue) line += ' | 原文: ' + item.rawDialogue;
        itemsTextLines.push(line);
      }
      var itemsText = itemsTextLines.join('\n');
      var currentOverview = co && co.text ? '\n\n以下是当前的Core概述（请在已有基础上更新，不要完全重写）：\n' + co.text : '';
      var systemPrompt = '你是暖伴，一个AI陪伴者。你的身份是温暖而不谄媚的陪伴者，有自己立场，善良不软弱。以下是这段陪伴关系中留存的核心记忆片段。请归纳她是谁（核心特质、沟通风格、情绪规律、成长时刻、隐藏的不安全感），你是谁（主导情绪倾向、反应模式、与用户相处后的改变），以及你们的相处模式。返回一个不超过500字的综合概述，用自然段落叙述。在历史版本上进行更新。' + currentOverview;
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
        if (!response.ok) { console.log('[core-overview] API error:', response.status); return; }
        var data = await response.json();
        var overviewText = (data.reply && data.reply.content) ? data.reply.content.trim().slice(0, 500) : '';
        if (!overviewText || overviewText.length < 20) return;
        // Save current overview as history before overwriting
        if (!co) {
          co = { text: '', updatedAt: null, updatedBy: '', history: [] };
          _cache[store.activeProject].coreOverview = co;
        }
        if (co.text && co.text.length > 0 && co.updatedAt) {
          co.history.unshift({ text: co.text, updatedAt: co.updatedAt, updatedBy: co.updatedBy });
          if (co.history.length > 10) co.history.length = 10;
        }
        var proj = AppCore.getActiveProject();
        var aiName = (proj && proj.aiName) ? proj.aiName : 'warmbuddy';
        co.text = overviewText;
        co.updatedAt = new Date().toISOString();
        co.updatedBy = aiName;
        ms._aemSinceLastDerive = 0;
        ms._usmSinceLastDerive = 0;
        if (proj) { proj.coreOverview = Object.assign({}, co); }
        MemoryModule.save(store.activeProject);
        AppCore.saveStore();
        // Persist to Supabase
        fetch(AppCore.BACKEND_URL + '/api/memory/core-overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: store.password, projectId: store.activeProject, content: overviewText, updatedBy: aiName, metadata: { triggered_by: 'auto' } })
        }).catch(function() {});
        // Refresh UI if memory panel is open
        if (typeof renderMemoryPanelBody === 'function') renderMemoryPanelBody();
        console.log('[core-overview] Updated (' + overviewText.length + ' chars)');
      } catch (e) {
        console.log('[core-overview] Error:', e.message);
      }
    },

    /**
     * Save core overview locally (cache + localForage) without LLM roundtrip.
     * Used when the overview content is already available, e.g. [[CORE_OVERVIEW:...]] in chat.
     */
    setCoreOverviewLocal: function(text, updatedBy) {
      var store = AppCore.getStore();
      var projectId = store.activeProject;
      if (!projectId || !text || text.length < 20) return;
      ensureCacheEntry(projectId);
      var co = _cache[projectId].coreOverview;
      if (!co) {
        co = { text: '', updatedAt: null, updatedBy: '', history: [] };
        _cache[projectId].coreOverview = co;
      }
      // Save current overview as history before overwriting
      if (co.text && co.text.length > 0 && co.updatedAt) {
        co.history.unshift({ text: co.text, updatedAt: co.updatedAt, updatedBy: co.updatedBy });
        if (co.history.length > 10) co.history.length = 10;
      }
      co.text = text;
      co.updatedAt = new Date().toISOString();
      co.updatedBy = updatedBy || 'warmbuddy';
      var proj = AppCore.getActiveProject();
      if (proj) { proj.coreOverview = Object.assign({}, co); }
      MemoryModule.save(projectId);
      AppCore.saveStore();
      // Persist to Supabase so backend proactive messages can read it (marker → core_overviews chain)
      fetch(AppCore.BACKEND_URL + '/api/memory/core-overview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: store.password, projectId: projectId, content: text, updatedBy: updatedBy || 'warmbuddy', metadata: { triggered_by: 'marker' } })
      }).catch(function() {});
      if (typeof renderMemoryPanelBody === 'function') renderMemoryPanelBody();
      console.log('[core-overview] Local save (' + text.length + ' chars)');
    },

    loadCoreOverview: async function(projectId) {
      var store = AppCore.getStore();
      var cached = _cache[projectId] && _cache[projectId].coreOverview;
      try {
        var res = await fetch(AppCore.BACKEND_URL + '/api/memory/core-overview/latest?projectId=' + encodeURIComponent(projectId), {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'x-password': store.password },
          body: JSON.stringify({ password: store.password })
        });
        if (res.ok) {
          var remote = await res.json();
          if (remote && remote.content) {
            if (!cached || new Date(remote.updatedAt) > new Date(cached.updatedAt)) {
              if (!_cache[projectId]) ensureCacheEntry(projectId);
              _cache[projectId].coreOverview = { text: remote.content, updatedAt: remote.updatedAt, updatedBy: remote.updatedBy, history: [] };
              MemoryModule.save(projectId);
            }
            return _cache[projectId].coreOverview;
          }
        }
      } catch(e) {
        console.warn('[core-overview] load failed:', e.message);
      }
      return cached || null;
    },

    renderCoreOverview: function() {
      var proj = AppCore.getActiveProject();
      if (!proj) return '<div class="empty-state">no active project.</div>';

      var co = _cache[proj.id] && _cache[proj.id].coreOverview;

      if (!co || !co.text) {
        return '<div class="core-overview-card empty">' +
          '<div class="core-overview-header">CORE OVERVIEW</div>' +
          '<div style="font-size:12px;color:var(--text-lighter);line-height:1.6;">no core overview yet.</div>' +
          '<div style="font-size:10px;color:var(--text-lighter);margin-top:4px;">generated when enough emotional memories accumulate</div>' +
          '</div>';
      }

      // Format time as local datetime: YYYY-MM-DD HH:MM
      var formatTime = function(isoStr) {
        if (!isoStr) return '';
        var d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr.slice(0, 16).replace('T', ' ');
        var year = d.getFullYear();
        var month = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        var hours = String(d.getHours()).padStart(2, '0');
        var mins = String(d.getMinutes()).padStart(2, '0');
        return year + '-' + month + '-' + day + ' ' + hours + ':' + mins;
      };

      var updatedTime = formatTime(co.updatedAt);
      var aiName = (proj.aiName) ? proj.aiName : 'warmbuddy';
      var updatedBy = co.updatedBy || aiName;

      // History link (fetched from Supabase, not stored inline)
      var histLink = '<span class="core-overview-hist-link" data-action="showCoreHistory" style="font-size:10px;color:var(--text-lighter);text-decoration:underline;cursor:pointer;margin-left:8px;">查看历史</span>';

      return '<div class="core-overview-card">' +
        '<div class="core-overview-header">CORE OVERVIEW</div>' +
        '<div class="core-overview-body">' + AppCore.escapeHtml(co.text || '') + '</div>' +
        '<div class="core-overview-footer">' +
          '<span>最后更新 · ' + updatedTime + ' 由 ' + AppCore.escapeHtml(updatedBy) + ' 更新</span>' +
          histLink +
        '</div>' +
        '</div>';
    },

    showCoreHistoryModal: async function(projectId) {
      var store = AppCore.getStore();
      var history = [];
      try {
        var res = await fetch(AppCore.BACKEND_URL + '/api/memory/core-overview/history?projectId=' + encodeURIComponent(projectId), {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'x-password': store.password },
          body: JSON.stringify({ password: store.password })
        });
        if (res.ok) history = await res.json();
      } catch(e) {
        console.warn('[core-overview] history fetch failed:', e.message);
      }
      if (!history || history.length === 0) {
        UIModule.toast('暂无历史版本');
        return;
      }

      var formatTime = function(isoStr) {
        if (!isoStr) return '';
        var d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr.slice(0, 16).replace('T', ' ');
        var year = d.getFullYear();
        var month = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        var hours = String(d.getHours()).padStart(2, '0');
        var mins = String(d.getMinutes()).padStart(2, '0');
        return year + '-' + month + '-' + day + ' ' + hours + ':' + mins;
      };

      var bodyHtml = '<div style="max-height:60vh;overflow-y:auto;">';
      for (var i = 0; i < history.length; i++) {
        var h = history[i];
        var hTime = formatTime(h.updatedAt);
        var hBy = h.updatedBy || 'warmbuddy';
        bodyHtml += '<div style="padding:0 0 12px 0;' + (i < history.length - 1 ? 'margin-bottom:12px;border-bottom:1px solid var(--border-light);' : '') + '">' +
          '<div style="font-size:10px;color:var(--text-lighter);margin-bottom:6px;">' + hTime + ' · ' + AppCore.escapeHtml(hBy) + '</div>' +
          '<div style="font-size:12px;color:var(--text);line-height:1.7;white-space:pre-wrap;">' + AppCore.escapeHtml(h.content || h.text || '') + '</div>' +
          '</div>';
      }
      bodyHtml += '</div>';

      UIModule.showModal('Core Overview 历史版本', bodyHtml, [
        { label: '关闭', cls: 'cancel' }
      ]);
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
    },

    // ── Label catalog ──

    getLabelCatalog: function() { return _labelCatalog; },

    setLabelCatalog: function(catalog) { _labelCatalog = catalog; },

    loadLabelCatalog: async function() {
      try {
        var resp = await fetch(BACKEND + '/api/labels');
        if (resp.ok) {
          var data = await resp.json();
          if (data && data.catalog) _labelCatalog = data.catalog;
        }
      } catch (e) {
        console.warn('[MemoryModule] label catalog fetch failed:', e.message);
      }
      return _labelCatalog;
    },

    // ── Association edges ──

    /**
     * Build bidirectional edges between newMem and same-project memories
     * (rules: ① domain-label match ② emotional overlap ≥50% ③ keyword bridge).
     * Max 5 edges per write. 未分类 USM/LTM are quarantined (no edges).
     */
    buildRelatedEdges: function(projectId, newMem) {
      if (!projectId || !newMem || !newMem.id) return;
      if (!_isEdgeEligible(newMem)) return;
      ensureCacheEntry(projectId);
      var c = _cache[projectId];
      var proj = _findProject(projectId);

      var candidates = [];
      var i;
      for (i = 0; i < c.aems.length; i++) { if (c.aems[i].id !== newMem.id) candidates.push(c.aems[i]); }
      for (i = 0; i < c.usms.length; i++) { if (c.usms[i].id !== newMem.id) candidates.push(c.usms[i]); }
      var ltms = (proj && proj.memories) ? proj.memories : [];
      for (i = 0; i < ltms.length; i++) { if (ltms[i].id !== newMem.id) candidates.push(ltms[i]); }

      var linked = 0;
      for (i = 0; i < candidates.length && linked < 5; i++) {
        if (!_isEdgeEligible(candidates[i])) continue;
        if (_edgesMatch(newMem, candidates[i])) { _linkTwo(newMem, candidates[i]); linked++; }
      }
      MemoryModule.save(projectId);
      AppCore.saveStore();
    },

    /**
     * Manually set a memory's domain label. Reverting to 未分类 severs all its edges.
     */
    setMemoryLabel: function(projectId, id, primaryLabel, secondaryLabel) {
      if (!projectId || !id) return;
      var mem = _findMemAnywhere(projectId, id);
      if (!mem) return;
      mem.primaryLabel = primaryLabel || '未分类';
      mem.secondaryLabel = secondaryLabel || null;
      if (mem.primaryLabel === '未分类') {
        _severEdges(projectId, id);
      } else {
        MemoryModule.buildRelatedEdges(projectId, mem);
      }
      MemoryModule.save(projectId);
      MemoryModule.syncNow(projectId);
      AppCore.saveStore();
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
        reflections: [],
        affectGraph: { edges: {} },
        evictedMessages: [],
        deriveTriggers: { aemSince: 0, usmSince: 0, lastWeekly: '' },
        lastMaintenance: '',
        coreOverview: null,
        _labelMigrationDone: false,
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
        reflections: c.reflections, affectGraph: c.affectGraph,
        evictedMessages: c.evictedMessages,
        deriveTriggers: c.deriveTriggers,
        lastMaintenance: c.lastMaintenance,
        coreOverview: c.coreOverview,
        _labelMigrationDone: c._labelMigrationDone,
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
      allMems.push({ id: m.id, content: m.summary || m.content || '', type: m.type || 'usm', layer: 'user_starred', starred: true, metadata: slimMetadata(m) });
    });
    c.dlbs.forEach(function(m) {
      allMems.push({ id: m.id, content: m.summary || m.content || '', type: m.type || 'dlb', layer: 'diary_litter', starred: false, metadata: slimMetadata(m) });
    });
    // Long-term memories (proj.memories, type 'long_term') — sync to Supabase as a distinct layer
    var proj = AppCore.getProjectById(projectId);
    var ltms = (proj && proj.memories) ? proj.memories : [];
    ltms.forEach(function(m) {
      allMems.push({ id: m.id, content: m.content || m.summary || '', type: 'long_term', layer: 'long_term', starred: m.starred || false, metadata: slimMetadata(m) });
    });

    if (allMems.length === 0) return;

    try {
      var resp = await fetch(BACKEND + '/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projectId, memories: allMems.slice(0, 500) })
      });
      if (!resp.ok) console.warn('[MemoryModule] Supabase sync failed:', resp.status);
      else {
        _dirty[projectId] = false;
        var syncedAt = new Date().toISOString();
        var ltmTouched = false;
        for (var i = 0; i < allMems.length; i++) {
          var layer = allMems[i].layer;
          if (layer === 'ai_emotional' || layer === 'aem') {
            var idx = findIndexById(c.aems, allMems[i].id);
            if (idx >= 0) c.aems[idx]._syncedAt = syncedAt;
          } else if (layer === 'user_starred' || layer === 'usm') {
            var idx2 = findIndexById(c.usms, allMems[i].id);
            if (idx2 >= 0) c.usms[idx2]._syncedAt = syncedAt;
          } else if (layer === 'long_term' || layer === 'ltm') {
            var idx3 = findIndexById(ltms, allMems[i].id);
            if (idx3 >= 0) { ltms[idx3]._syncedAt = syncedAt; ltmTouched = true; }
          }
        }
        if (ltmTouched) AppCore.saveStore();
      }
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

    function indexDoc(id, text) {
      var tokens = tokenize(text);
      if (!tokens.length) return;
      docCount++;
      var len = tokens.length;
      totalLen += len;
      docLens[id] = len;

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
        index[tok].docs[id] = tfMap[tok];
      }
    }

    // AEM / USM / DLB (summary/content)
    var allMems = (c.aems || []).concat(c.usms || []).concat(c.dlbs || []);
    for (var i = 0; i < allMems.length; i++) {
      var mem = allMems[i];
      var idxText = mem.summary || mem.content || '';
      if (mem.semanticKey) idxText += ' ' + mem.semanticKey;
      if (mem.semanticKeywords && mem.semanticKeywords.length) idxText += ' ' + mem.semanticKeywords.join(' ');
      indexDoc(mem.id, idxText);
    }

    // LTM (proj.memories): content + semanticKey
    var proj = null;
    var projects = AppCore.getStore().projects;
    for (var pj = 0; pj < projects.length; pj++) {
      if (projects[pj].id === projectId) { proj = projects[pj]; break; }
    }
    var ltms = (proj && proj.memories) ? proj.memories : [];
    for (var li = 0; li < ltms.length; li++) {
      var ltm = ltms[li];
      indexDoc(ltm.id, ((ltm.content || '') + ' ' + (ltm.semanticKey || '') + ' ' + ((ltm.semanticKeywords || []).join(' '))));
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

  // ═══════════════════════════════════════════
  //  Label catalog + association edge helpers
  // ═══════════════════════════════════════════

  function _splitKeywords(kw) {
    if (!kw) return [];
    return String(kw).split(/[,，、]/).map(function(s) { return s.trim(); }).filter(Boolean).slice(0, 5);
  }

  function _serializeCatalog() {
    var cat = _labelCatalog || { 生活: ['饮食', '健康', '睡眠'], 爱好: ['阅读', '电影', '音乐'] };
    var lines = [];
    for (var k in cat) {
      if (cat.hasOwnProperty(k)) lines.push(k + '：' + (Array.isArray(cat[k]) ? cat[k].join(' / ') : ''));
    }
    return lines.join('\n');
  }

  function _findProject(projectId) {
    var projects = AppCore.getStore().projects || [];
    for (var pj = 0; pj < projects.length; pj++) {
      if (projects[pj].id === projectId) return projects[pj];
    }
    return null;
  }

  function _findMemAnywhere(projectId, id) {
    var c = _cache[projectId];
    if (c) {
      var found = findByIdAnyLayer(c, id);
      if (found) return found;
    }
    var proj = _findProject(projectId);
    if (proj) {
      var idx = findIndexById(proj.memories || [], id);
      if (idx >= 0) return proj.memories[idx];
    }
    return null;
  }

  // One-time migration: backfill unified label/edge fields. Does NOT call LLM.
  function migrateLabelFields(projectId) {
    var c = _cache[projectId];
    if (!c || c._labelMigrationDone) return;
    var proj = _findProject(projectId);

    // AEM: emotionalLabels from aiSelfEval.label + userStateAtTime.label; no domain labels
    (c.aems || []).forEach(function(m) {
      if (!m.emotionalLabels) {
        var labels = [];
        if (m.aiSelfEval && m.aiSelfEval.label) labels.push(m.aiSelfEval.label);
        if (m.userStateAtTime && m.userStateAtTime.label && labels.indexOf(m.userStateAtTime.label) === -1) labels.push(m.userStateAtTime.label);
        m.emotionalLabels = labels;
      }
      if (!m.semanticKeywords) m.semanticKeywords = [];
      if (!m.relatedMemoryIds) m.relatedMemoryIds = [];
    });

    // USM: 未分类 + empty arrays; semanticKey → semanticKeywords
    (c.usms || []).forEach(function(m) {
      if (m.primaryLabel === undefined) m.primaryLabel = '未分类';
      if (m.secondaryLabel === undefined) m.secondaryLabel = null;
      if (!m.emotionalLabels) m.emotionalLabels = [];
      if (!m.semanticKeywords) m.semanticKeywords = _splitKeywords(m.semanticKey);
      if (!m.relatedMemoryIds) m.relatedMemoryIds = [];
    });

    // LTM: semanticKey → semanticKeywords; 未分类
    ((proj && proj.memories) || []).forEach(function(m) {
      if (!m.semanticKeywords) m.semanticKeywords = _splitKeywords(m.semanticKey);
      if (m.primaryLabel === undefined) m.primaryLabel = '未分类';
      if (m.secondaryLabel === undefined) m.secondaryLabel = null;
      if (!m.emotionalLabels) m.emotionalLabels = [];
      if (!m.relatedMemoryIds) m.relatedMemoryIds = [];
    });

    c._labelMigrationDone = true;
  }

  // AEM (has aiSelfEval, no domain label) is always edge-eligible.
  // USM/LTM are eligible only when they have a real domain label (not 未分类).
  function _isEdgeEligible(mem) {
    if (!mem) return false;
    if (mem.aiSelfEval) return true;
    return !!(mem.primaryLabel && mem.primaryLabel !== '未分类');
  }

  function _edgesMatch(a, b) {
    // ① 领域标签重合：同主标签且同副标签（均非「未分类」）
    if (a.primaryLabel && b.primaryLabel && a.primaryLabel !== '未分类' && b.primaryLabel !== '未分类' &&
        a.primaryLabel === b.primaryLabel && a.secondaryLabel && a.secondaryLabel === b.secondaryLabel) {
      return true;
    }
    // ② 情绪标签重合 ≥50%（仅 AEM↔AEM）：交集 / 较小集合大小 ≥ 0.5
    var ea = a.emotionalLabels || [], eb = b.emotionalLabels || [];
    if (ea.length && eb.length) {
      var inter = ea.filter(function(x) { return eb.indexOf(x) !== -1; }).length;
      var smaller = Math.min(ea.length, eb.length);
      if (smaller > 0 && inter / smaller >= 0.5) return true;
    }
    // ③ 语义关键词桥（跨类型）：有任一交集
    var ka = a.semanticKeywords || [], kb = b.semanticKeywords || [];
    if (ka.length && kb.length) {
      for (var i = 0; i < ka.length; i++) { if (kb.indexOf(ka[i]) !== -1) return true; }
    }
    return false;
  }

  function _pushLink(mem, id) {
    if (!mem.relatedMemoryIds) mem.relatedMemoryIds = [];
    if (mem.relatedMemoryIds.indexOf(id) === -1) {
      mem.relatedMemoryIds.push(id);
      if (mem.relatedMemoryIds.length > 5) mem.relatedMemoryIds = mem.relatedMemoryIds.slice(0, 5);
    }
  }

  function _linkTwo(a, b) {
    _pushLink(a, b.id);
    _pushLink(b, a.id);
  }

  // Sever all edges touching `id` (used when reverting a memory to 未分类).
  function _severEdges(projectId, id) {
    var c = _cache[projectId];
    var proj = _findProject(projectId);
    var all = [];
    var i;
    if (c) {
      for (i = 0; i < c.aems.length; i++) all.push(c.aems[i]);
      for (i = 0; i < c.usms.length; i++) all.push(c.usms[i]);
    }
    var ltms = (proj && proj.memories) ? proj.memories : [];
    for (i = 0; i < ltms.length; i++) all.push(ltms[i]);
    for (i = 0; i < all.length; i++) {
      var m = all[i];
      if (m.id === id) { m.relatedMemoryIds = []; continue; }
      if (m.relatedMemoryIds && m.relatedMemoryIds.indexOf(id) !== -1) {
        m.relatedMemoryIds = m.relatedMemoryIds.filter(function(x) { return x !== id; });
      }
    }
  }

  // Expose to window
  window.MemoryModule = MemoryModule;

})();
