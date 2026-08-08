/**
 * WarmBuddy PWA Module
 * ── Service Worker registration and push notifications ──
 */

var PwaModule = (function() {
  'use strict';

  // ── Module-private state ──
  var pushSubscribed = false;
  var _pushPermissionRequested = false;

  // ═══════════════════════════════════════════
  //  Private: URL-safe base64 to Uint8Array
  // ═══════════════════════════════════════════

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // ═══════════════════════════════════════════
  //  Private: send subscription to server
  // ═══════════════════════════════════════════

  async function sendSubscriptionToServer(subscription) {
    try {
      await fetch(AppCore.BACKEND_URL + '/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() })
      });
      console.log('[PWA] Subscription sent to server');
    } catch (e) {
      console.log('[PWA] Subscription send error:', e.message);
    }
  }

  // ═══════════════════════════════════════════
  //  Public: register Service Worker
  // ═══════════════════════════════════════════

  async function registerSW() {
    if (!('serviceWorker' in navigator)) {
      console.log('[PWA] Service Worker not supported');
      return;
    }
    try {
      var registration = await navigator.serviceWorker.register('/service-worker.js');
      console.log('[PWA] SW registered:', registration.scope);

      if (navigator.storage && navigator.storage.persist) {
        var isPersisted = await navigator.storage.persist();
        console.log('[PWA] Persistent storage:', isPersisted ? 'granted' : 'denied');
      }

      var existingSubscription = await registration.pushManager.getSubscription();
      if (existingSubscription) {
        await sendSubscriptionToServer(existingSubscription);
        pushSubscribed = true;
      } else {
        console.log('[PWA] Not subscribed yet, will request on interaction');
      }
    } catch (e) {
      console.log('[PWA] SW registration failed:', e.message);
    }
  }

  // ═══════════════════════════════════════════
  //  Public: request push permission
  // ═══════════════════════════════════════════

  async function requestPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      UIModule.toast('Push notifications not supported on this device');
      return false;
    }

    var permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      UIModule.toast('Notification permission denied');
      return false;
    }

    try {
      var registration = await navigator.serviceWorker.ready;
      var subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(AppCore.VAPID_PUBLIC_KEY)
      });

      await sendSubscriptionToServer(subscription);
      pushSubscribed = true;
      UIModule.toast('🔔 通知已开启');
      return true;
    } catch (e) {
      console.log('[PWA] Push subscribe error:', e.message);
      UIModule.toast('通知订阅失败: ' + e.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════
  //  Public: send push notification via backend
  // ═══════════════════════════════════════════

  async function sendNotification(title, body, opts) {
    if (!pushSubscribed) return;
    opts = opts || {};
    try {
      await fetch(AppCore.BACKEND_URL + '/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          body: body,
          tag: opts.tag || 'warmbuddy-general',
          url: opts.url || '/',
          requireInteraction: opts.requireInteraction || false
        })
      });
    } catch (e) {
      console.log('[PWA] Push send error:', e.message);
    }
  }

  // ═══════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════

  function init() {
    // Request push permission on first user interaction (to avoid auto-block)
    document.addEventListener('click', function requestPushOnce() {
      if (_pushPermissionRequested) return;
      _pushPermissionRequested = true;
      setTimeout(function() { PwaModule.requestPush(); }, 2000);
    }, { once: true });

    console.log('[PwaModule] ✅ initialized');
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    init: init,
    registerSW: registerSW,
    requestPush: requestPush,
    sendNotification: sendNotification,
    isSubscribed: function() {
      return pushSubscribed;
    }
  };
})();

AppCore.register('pwa', PwaModule);
