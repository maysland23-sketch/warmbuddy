/**
 * WarmBuddy Weather Module
 * ── Weather fetch via geolocation + backend proxy ──
 */

var WeatherModule = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Private: do the actual weather API fetch
  // ═══════════════════════════════════════════

  async function doWeatherFetch(lat, lon) {
    try {
      var resp = await fetch(AppCore.BACKEND_URL + '/api/weather', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: lat, lon: lon })
      });
      var data = await resp.json();
      AppCore.getStore().weather = { text: data.weather, updated: Date.now() };
      console.log('[weather] Updated:', data.weather);
    } catch (err) {
      console.log('[weather] Fetch error:', err.message);
      AppCore.getStore().weather = { text: '(天气不可用)', updated: Date.now() };
    }
  }

  // ═══════════════════════════════════════════
  //  Public: fetch weather
  // ═══════════════════════════════════════════

  async function fetchWeather() {
    if (!AppCore.getActiveChatAiSettings().autoWeather) return;
    var loc = null;
    try { loc = await localforage.getItem('userLocation'); } catch (e) {}

    if (!loc) {
      if (!navigator.geolocation) { UIModule.toast('浏览器不支持定位'); return; }
      navigator.geolocation.getCurrentPosition(
        async function(pos) {
          var newLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          localforage.setItem('userLocation', newLoc).catch(function() {});
          await doWeatherFetch(newLoc.lat, newLoc.lon);
        },
        function(err) {
          UIModule.toast('无法获取位置：' + (err.code === 1 ? '权限被拒绝' : err.message));
        },
        { timeout: 10000, maximumAge: 1800000 }
      );
      return;
    }
    await doWeatherFetch(loc.lat, loc.lon);
  }

  // ═══════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════

  function init() {
    console.log('[WeatherModule] ✅ initialized');
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    init: init,
    fetch: fetchWeather,
    getWeather: function() {
      return AppCore.getStore().weather;
    }
  };
})();

AppCore.register('weather', WeatherModule);
