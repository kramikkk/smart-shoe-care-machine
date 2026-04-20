/*
 * HTML Pages for Smart Shoe Care Machine
 * WiFi Setup Portal Pages
 */

#ifndef HTML_PAGES_H
#define HTML_PAGES_H

#include <Arduino.h>

// WiFi Setup Page - Main form for entering WiFi credentials
const char WIFI_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Shoe Care - WiFi Setup</title>
  <style>
    :root {
      --primary: #0d9488;
      --bg-gradient: linear-gradient(135deg, #0d9488 0%, #06b6d4 50%, #3b82f6 100%);
      --glass: rgba(255, 255, 255, 0.12);
      --glass-border: rgba(255, 255, 255, 0.2);
    }
    * { box-sizing: border-box; }
    body, html {
      min-height: 100%;
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-gradient);
      background-attachment: fixed;
      color: #fff;
    }
    .container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      width: 100%;
      max-width: 400px;
      padding: 48px 40px;
      background: var(--glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border);
      border-radius: 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
      animation: fadeIn 0.8s ease-out;
      text-align: center;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .logo {
      width: 64px; height: 64px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 20px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px;
    }
    h1 { font-size: 28px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.5px; }
    p.subtitle { font-size: 15px; color: rgba(255,255,255,0.7); margin-bottom: 32px; }
    .alert {
      display: none;
      margin-bottom: 20px;
      padding: 14px 16px;
      background: rgba(239,68,68,0.15);
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 16px;
      font-size: 14px;
      color: rgba(255,255,255,0.9);
      line-height: 1.5;
    }
    .input-group { margin-bottom: 20px; text-align: left; }
    label {
      display: block; font-size: 13px; font-weight: 400;
      margin-bottom: 8px; margin-left: 4px;
      color: rgba(255,255,255,0.8);
    }
    select, input {
      width: 100%; padding: 16px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px; color: #fff;
      font-size: 16px; font-family: inherit;
      transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
      outline: none;
    }
    select:focus, input:focus {
      background: rgba(255,255,255,0.15);
      border-color: rgba(255,255,255,0.4);
      box-shadow: 0 0 0 4px rgba(255,255,255,0.05);
    }
    select option { background: #134e4a; color: #fff; }
    .btn {
      width: 100%; padding: 16px;
      border-radius: 16px; font-size: 16px; font-weight: 600;
      cursor: pointer; transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
      margin-top: 12px; border: none;
    }
    .btn-primary {
      background: #fff; color: #0d9488;
      box-shadow: 0 10px 20px -5px rgba(0,0,0,0.2);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 25px -5px rgba(0,0,0,0.25);
      background: #f8fafc;
    }
    .btn-primary:active { transform: translateY(0); }
    .btn-ghost {
      background: rgba(255,255,255,0.15);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.3);
    }
    .btn-ghost:hover {
      background: rgba(255,255,255,0.22);
      transform: translateY(-2px);
    }
    .btn-ghost:active { transform: translateY(0); }
    .btn-ghost:disabled { opacity: 0.6; cursor: default; transform: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
          <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
          <line x1="12" y1="20" x2="12.01" y2="20"></line>
        </svg>
      </div>
      <h1>WiFi Setup</h1>
      <p class="subtitle">Connect your Machine to the internet</p>
      <div id="no-network" class="alert" id="alert-msg">
        No networks found nearby.<br>Move closer to your router, then tap Scan Again.
      </div>
      <form method="POST" id="wifi-form">
        <div class="input-group" id="ssid-group">
          <label for="ssid-select">Network Name</label>
          <select name="ssid" id="ssid-select" required>
            {{WIFI_LIST}}
          </select>
        </div>
        <div class="input-group" id="pass-group">
          <label for="pass-input">Password</label>
          <input name="pass" id="pass-input" type="password" placeholder="&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;" autocomplete="off">
        </div>
        <button type="submit" id="submit-btn" class="btn btn-primary">Save &amp; Connect</button>
      </form>
      <button type="button" id="rescan-btn" class="btn btn-ghost" style="display:none" onclick="rescan()">
        Scan Again
      </button>
    </div>
  </div>
  <script>
    var sel = document.getElementById('ssid-select');
    var noNet = document.getElementById('no-network');
    var submitBtn = document.getElementById('submit-btn');
    var rescanBtn = document.getElementById('rescan-btn');
    var ssidGroup = document.getElementById('ssid-group');
    var passGroup = document.getElementById('pass-group');

    if (sel.options.length === 1 && sel.options[0].value === '') {
      var txt = sel.options[0].text;
      noNet.textContent = txt.indexOf('failed') !== -1
        ? 'Radio was busy — tap Scan Again to retry.'
        : 'No networks found nearby. Move closer to your router, then tap Scan Again.';
      noNet.style.display = 'block';
      ssidGroup.style.display = 'none';
      passGroup.style.display = 'none';
      submitBtn.style.display = 'none';
      rescanBtn.style.display = 'block';
    }

    function rescan() {
      rescanBtn.disabled = true;
      rescanBtn.textContent = 'Scanning\u2026';
      location.reload();
    }
  </script>
</body>
</html>
)rawliteral";

// WiFi Confirmation Page - Shown after credentials are saved
const char CONFIRM_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WiFi Saved - Smart Shoe Care</title>
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0d9488 0%, #06b6d4 50%, #3b82f6 100%);
      --glass: rgba(255, 255, 255, 0.12);
      --glass-border: rgba(255, 255, 255, 0.2);
    }
    * { box-sizing: border-box; }
    body, html {
      min-height: 100%; margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-gradient);
      background-attachment: fixed;
      color: #fff;
    }
    .container {
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 20px;
    }
    .card {
      width: 100%; max-width: 400px; padding: 48px 40px;
      background: var(--glass);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border);
      border-radius: 32px; text-align: center;
      animation: fadeIn 0.8s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to   { opacity: 1; transform: scale(1); }
    }
    .success-icon {
      width: 80px; height: 80px;
      background: rgba(16,185,129,0.2);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px;
      border: 2px solid rgba(16,185,129,0.3);
    }
    h1 { font-size: 28px; font-weight: 600; margin: 0 0 12px; }
    p  { color: rgba(255,255,255,0.8); margin: 0; line-height: 1.6; }
    .ssid-badge {
      display: inline-block; padding: 6px 16px;
      background: rgba(255,255,255,0.1);
      border-radius: 20px; font-weight: 600;
      margin-top: 8px; font-size: 14px;
      word-break: break-all;
    }
    .progress-wrap {
      margin-top: 36px;
      background: rgba(255,255,255,0.15);
      border-radius: 99px; height: 6px; overflow: hidden;
    }
    .progress-bar {
      height: 100%; width: 0%;
      background: #fff;
      border-radius: 99px;
      transition: width 0.1s linear;
    }
    .status { font-size: 13px; color: rgba(255,255,255,0.6); margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="success-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <h1>Configuration Saved</h1>
      <p>Your machine is connecting to:</p>
      <div class="ssid-badge">{{SSID}}</div>
      <div class="progress-wrap">
        <div class="progress-bar" id="bar"></div>
      </div>
      <p class="status" id="status">Rebooting&hellip;</p>
    </div>
  </div>
  <script>
    var REBOOT_MS = 1500;
    var start = Date.now();
    var bar = document.getElementById('bar');
    var status = document.getElementById('status');
    var raf;
    function tick() {
      var pct = Math.min((Date.now() - start) / REBOOT_MS * 100, 100);
      bar.style.width = pct + '%';
      if (pct < 100) {
        raf = requestAnimationFrame(tick);
      } else {
        status.textContent = 'Done. You can close this page.';
      }
    }
    raf = requestAnimationFrame(tick);
  </script>
</body>
</html>
)rawliteral";

#endif // HTML_PAGES_H
