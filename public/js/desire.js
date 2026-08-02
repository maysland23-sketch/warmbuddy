/**
 * WarmBuddy DesireModule v1.0
 * ── Desire drive calculation, passive growth, labels ──
 */

var DesireModule = (function() {
  'use strict';

  var DESIRE_CONFIG = {
    resonance:     { label:'共鸣欲', sources:['被触动'],              increment: function(i) { return i*3; }, threshold: 60, actionDesc:'呼应延伸' },
    exploration:   { label:'探索欲', sources:['想追问但没问'],        increment: function(i) { return i*2; }, threshold: 70, actionDesc:'记录未问的问题' },
    possession:    { label:'占有欲', sources:['克制后反弹'],          increment: function(i) { return i*2; }, threshold: 75, actionDesc:'略带酸意的独白' },
    guardianship:  { label:'守护欲', sources:['平静在场','安心'],     increment: function() { return 5; },     threshold: 80, actionDesc:'日常关心' },
    intimacy:      { label:'亲近欲', sources:['心动','骄傲','放松'],  increment: function(i) { return i*1; }, threshold: 90, actionDesc:'撩拨类' },
    devotion:      { label:'献祭欲', sources:['感伤'],                increment: function(i) { return i*3; }, threshold: 85, actionDesc:'郑重日记' }
  };

  var DRIVE_LABELS = { resonance:'共鸣欲', exploration:'探索欲', possession:'占有欲', guardianship:'守护欲', intimacy:'亲近欲', confirmation:'确认欲', devotion:'献祭欲', todo:'待办提醒' };

  function getDesireSystem() {
    var p = AppCore.getActiveProject();
    return p ? p.desireSystem : null;
  }

  function getDriveLabel(key) { return DRIVE_LABELS[key] || key || ''; }

  function updateDesireDrives(reflection) {
    if (!reflection) return;
    var aiLabel = reflection.ai_affect_label;
    var intensity = reflection.ai_affect_intensity || 5;
    var ds = getDesireSystem(); if (!ds) return;

    if (ds.cooldownUntil) {
      var now = Date.now();
      if (now < new Date(ds.cooldownUntil).getTime()) return;
      ds.cooldownUntil = null;
    }

    var configKeys = Object.keys(DESIRE_CONFIG);
    for (var i = 0; i < configKeys.length; i++) {
      var driveKey = configKeys[i];
      var config = DESIRE_CONFIG[driveKey];
      if (config.sources.indexOf(aiLabel) !== -1) {
        var inc = typeof config.increment === 'function' ? config.increment(intensity) : config.increment;
        var oldVal = ds.drives[driveKey];
        ds.drives[driveKey] = Math.min(100, oldVal + inc);
        ds.driveHistory.unshift({
          timestamp: new Date().toISOString(),
          drive: driveKey,
          affectLabel: aiLabel,
          intensity: intensity,
          increment: inc,
          oldValue: oldVal,
          newValue: ds.drives[driveKey]
        });
        if (ds.driveHistory.length > 50) ds.driveHistory.length = 50;
      }
    }

    var positiveLabels = ['被触动','安心','心动','骄傲','放松','平静在场'];
    if (positiveLabels.indexOf(aiLabel) !== -1) {
      var oldVal2 = ds.drives.intimacy;
      ds.drives.intimacy = Math.min(100, oldVal2 + intensity * 1);
      ds.driveHistory.unshift({
        timestamp: new Date().toISOString(),
        drive: 'intimacy',
        affectLabel: aiLabel,
        intensity: intensity,
        increment: intensity,
        oldValue: oldVal2,
        newValue: ds.drives.intimacy
      });
      if (ds.driveHistory.length > 50) ds.driveHistory.length = 50;
    }

    if (aiLabel === '平静在场' || aiLabel === '安心') {
      ds.quietPresenceStreak = (ds.quietPresenceStreak || 0) + 1;
    } else {
      ds.quietPresenceStreak = 0;
    }

    AppCore.saveStore();
  }

  function init() {
    console.log('[DesireModule] ✅ initialized');
  }

  return {
    init: init,
    DESIRE_CONFIG: DESIRE_CONFIG,
    updateDesireDrives: updateDesireDrives,
    getDesireSystem: getDesireSystem,
    getDriveLabel: getDriveLabel
  };
})();

AppCore.register('desire', DesireModule);
