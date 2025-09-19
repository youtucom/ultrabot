// UltraBot combinado (OCR + WhatsApp + Macros + Status interno)
// Ajustes solicitados en este turno:
// 1) La bienvenida (mensaje + imagen de gato negro) se manda al INICIAR el bot (evento 'ready'), no al correr una macro.
// 2) Solo 'listo' puede solaparse: si llega 'listo' de nuevo, se cierra la instancia previa de UltraBot.ahk y vuelve a empezar.
// 3) Intervalo del reinicio automático ajustable por chat: 'auto reinicio 2h', 'auto reinicio 90m', 'auto reinicio on/off', 'ver auto reinicio'.
//    Por defecto: 3 horas.
//
// Requisitos opcionales:
// - Si quieres que envíe una foto real de un gato negro en la bienvenida, coloca un archivo en:
//   C:\Users\Jhoseph\whatsapp-bot\assets\black_cat.png
//   (si no existe, enviará un mensaje con 🐈‍⬛)
//
// Nota: Mantengo el resto de lógica y helpers como estaban en tu versión anterior,
// con correcciones mínimas necesarias para las nuevas funciones.

const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const clipboardy = require('clipboardy');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');

console.log("🚀 Iniciando cliente WhatsApp...");

/** Utilidad: esperar ms */
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/** Resolver Chrome/Chromium en Windows o usar Chromium de Puppeteer */
function resolveChromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome SxS\\Application\\chrome.exe'),
  ];
  for (const p of candidates) { try { if (p && fs.existsSync(p)) return p; } catch (_) {} }
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) { console.log("ℹ️ Usando Chromium de Puppeteer:", p); return p; }
  } catch (e) { console.log("ℹ️ No se pudo obtener executablePath de puppeteer:", e.message); }
  return null;
}
const chromePath = resolveChromePath();
if (!chromePath) console.log("⚠️ No se encontró Chrome/Chromium. Instala Chrome o ejecuta: npm i puppeteer");

// ===================== RUTAS AHK / SCRIPTS =====================
const AHK_SCRIPT   = 'C:\\Users\\Jhoseph\\whatsapp-bot\\macros\\UltraBot.ahk';
const AHK_TABS     = 'C:\\Users\\Jhoseph\\whatsapp-bot\\macros\\Tabs.ahk';
const REBOOT_SCRIPT= 'C:\\Users\\Jhoseph\\whatsapp-bot\\macros\\reboot.ahk';

const REINICIO_TOTAL_SCRIPT = 'C:\\Users\\Jhoseph\\whatsapp-bot\\macros\\reiniciototal.ahk';
const CAPTURE_SCRIPT        = 'C:\\Users\\Jhoseph\\whatsapp-bot\\macros\\capture.ahk';

// Imagen de gato para bienvenida (opcional)
const BLACK_CAT_IMG = 'C:\\Users\\Jhoseph\\whatsapp-bot\\assets\\black_cat.png';

// ===================== Watchdog de cliente (NUEVO) =====================
const BOOT_TIMEOUT_MS = 180 * 1000;          // 180 segundos para "agarrar"
const RESTART_DELAY_MS = 4000;               // pausa corta antes de reinit
const MAX_RESTART_ATTEMPTS = 5;              // máximo de reintentos
let bootTimer = null;
let restartingClient = false;
let restartAttempts = 0;
let emergencyTriggered = false;

function startBootTimeoutTimer() {
  clearBootTimer();
  bootTimer = setTimeout(() => {
    if (!waReady) {
      console.log('⏳ Boot timeout: WhatsApp no “agarró” en 180s. Reiniciando cliente…');
      safeRestartWhatsApp('boot-timeout');
    }
  }, BOOT_TIMEOUT_MS);
}
function clearBootTimer() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}
function runEmergencyBat(reason = 'max-retries') {
  if (emergencyTriggered) return;
  emergencyTriggered = true;
  console.log(`🆘 Límite de reintentos alcanzado (${reason}). Ejecutando limpiarcache.bat para forzar reinicio…`);
  try {
    const batPath = 'C:\\Users\\Jhoseph\\whatsapp-bot\\limpiarcache.bat';
    exec(`start "" "${batPath}"`, { shell: 'cmd.exe' });
  } catch (e) {
    console.log('No se pudo ejecutar el bat de emergencia:', e.message);
  }
}
async function safeRestartWhatsApp(tag = 'watchdog') {
  if (restartingClient) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    runEmergencyBat(tag);
    return;
  }
  restartingClient = true;
  try {
    waReady = false;
    clearBootTimer();

    restartAttempts += 1;
    console.log(`🔁 Reiniciando WhatsApp (${tag})… intento ${restartAttempts}/${MAX_RESTART_ATTEMPTS}`);

    try { await client.destroy(); } catch (_) {}
    await sleep(RESTART_DELAY_MS);
    client.initialize();
    startBootTimeoutTimer(); // volvemos a esperar hasta 180s
  } finally {
    setTimeout(() => { restartingClient = false; }, 1000);
  }
}

// ============== Localizador de AutoHotkey v1 ==============
function resolveAhkExe() {
  const candidates = [
    'C:\\Program Files\\AutoHotkey\\v1\\AutoHotkey.exe',
    'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe',
    'C:\\Program Files\\AutoHotkey\\AutoHotkeyU64.exe',
    'C:\\Program Files (x86)\\AutoHotkey\\AutoHotkey.exe',
    'C:\\Program Files (x86)\\AutoHotkey\\AutoHotkeyU32.exe',
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

// ============== helpers AHK (start/stop/espera estricta) ==============
function killAhkByScript(scriptPath) {
  return new Promise((resolve) => {
    try {
      const base = path.basename(scriptPath).replace(/'/g, "''");
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command `
        + `"$bn='${base}'; `
        + `Get-CimInstance Win32_Process `
        + `| Where-Object { $_.Name -like 'AutoHotkey*' -and $_.CommandLine -like ('*' + $bn + '*') } `
        + `| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"`;
      exec(cmd, { windowsHide: true }, () => resolve());
    } catch (_) { resolve(); }
  });
}

function isAhkScriptRunning(scriptPath) {
  return new Promise((resolve) => {
    try {
      const base = path.basename(scriptPath).replace(/'/g, "''");
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command `
        + `"$bn='${base}'; `
        + `$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'AutoHotkey*' -and $_.CommandLine -like ('*' + $bn + '*') }; `
        + `if($p){exit 0}else{exit 1}"`;
      exec(cmd, { windowsHide: true }, (err) => resolve(!err));
    } catch (_) { resolve(false); }
  });
}

async function waitForAhkStart(scriptPath, timeoutMs = 10000, pollMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isAhkScriptRunning(scriptPath)) return true;
    await sleep(pollMs);
  }
  return false;
}

async function waitForAhkStop(scriptPath, timeoutMs = 30 * 60 * 1000, pollMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const running = await isAhkScriptRunning(scriptPath);
    if (!running) return true;
    await sleep(pollMs);
  }
  return false;
}

/** Ejecutar y ESPERAR a que termine de verdad (independiente del método de lanzamiento) */
async function runAhkAndWait(scriptPath) {
  // Cerrar instancias previas del MISMO script
  await killAhkByScript(scriptPath);

  const ahkExe = resolveAhkExe();
  let launched = false;

  if (ahkExe) {
    await new Promise((resolve, reject) => {
      try {
        const proc = execFile(ahkExe, [scriptPath], { windowsHide: false });
        launched = true;
        proc.on('error', reject);
        proc.on('spawn', () => resolve());
      } catch (e) { reject(e); }
    });
  } else {
    await new Promise((resolve, reject) => {
      exec(`start "" "${scriptPath}"`, { shell: 'cmd.exe' }, (err) => {
        if (err) return reject(err);
        launched = true;
        resolve();
      });
    });
  }

  const started = await waitForAhkStart(scriptPath, 15000, 250);
  if (!started && launched) {
    const stopped = await isAhkScriptRunning(scriptPath);
    if (!stopped) return; // terminó ultrarrápido
  }

  await waitForAhkStop(scriptPath, 30 * 60 * 1000, 500);
}

// ============== Clipboard imaging helpers ==============
function probeClipboardHasImage() {
  return new Promise((resolve) => {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      $img = [System.Windows.Forms.Clipboard]::GetImage();
      if ($img -eq $null) { exit 1 } else { exit 0 }
    `;
    exec(`powershell -NoProfile -STA -ExecutionPolicy Bypass -Command "${ps.replace(/\n/g,' ')}"`, { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}
async function waitForClipboardImage(timeoutMs = 15000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await probeClipboardHasImage();
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}
async function exportClipboardImageToPng(tempPath) {
  return new Promise((resolve, reject) => {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      Add-Type -AssemblyName System.Drawing;
      $img = [System.Windows.Forms.Clipboard]::GetImage();
      if ($img -eq $null) { exit 2 }
      $file = '${tempPath.replace(/\\/g,'\\\\')}';
      $img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png);
    `;
    exec(`powershell -NoProfile -STA -ExecutionPolicy Bypass -Command "${ps.replace(/\n/g,' ')}"`, { windowsHide: true }, (err) => {
      if (err) return reject(new Error('No se pudo exportar la imagen del portapapeles'));
      resolve(tempPath);
    });
  });
}
async function sendClipboardImage(chat, caption) {
  try {
    const ok = await waitForClipboardImage(15000, 300); // espera hasta 15s
    if (!ok) throw new Error('Clipboard sin imagen');
    const tmp = path.join(os.tmpdir(), `ultra_clip_${Date.now()}.png`);
    await exportClipboardImageToPng(tmp);
    const media = MessageMedia.fromFilePath(tmp);
    await chat.sendMessage(media, { caption });
    try { fs.unlinkSync(tmp); } catch (_) {}
  } catch (e) {
    console.error("❌ Error enviando imagen:", e.message);
    await chat.sendMessage("⚠️ No se pudo obtener la imagen del portapapeles.");
  }
}

// ======================= STATUS interno (no AHK) =======================
const STATUS_REGION = { x1: 1624, y1: 196, x2: 1918, y2: 885 };

async function captureStatusRegionBase64() {
  const { x1, y1, x2, y2 } = STATUS_REGION;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const ps = `
    Add-Type -AssemblyName System.Drawing;
    $bmp = New-Object System.Drawing.Bitmap(${w}, ${h}, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb);
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.CopyFromScreen(${x1}, ${y1}, 0, 0, $bmp.Size);
    $g.Dispose();
    $ms = New-Object System.IO.MemoryStream;
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
    $bmp.Dispose();
    $bytes = $ms.ToArray();
    $ms.Dispose();
    [System.Convert]::ToBase64String($bytes)
  `;
  return new Promise((resolve) => {
    const cmd = `powershell -NoProfile -STA -ExecutionPolicy Bypass -Command "${ps.replace(/\n/g,' ')}"`;
    exec(cmd, { windowsHide: true }, (err, stdout) => {
      if (err) { console.error('⚠️ Error capturando Status (b64):', err.message); return resolve(null); }
      resolve((stdout || '').trim());
    });
  });
}
function captureStatusRegionToPng() {
  const { x1, y1, x2, y2 } = STATUS_REGION;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const tmp = path.join(os.tmpdir(), `status_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const tmpEsc = tmp.replace(/\\/g, '\\\\');
  const ps = `
    Add-Type -AssemblyName System.Drawing;
    $bmp = New-Object System.Drawing.Bitmap(${w}, ${h}, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb);
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.CopyFromScreen(${x1}, ${y1}, 0, 0, $bmp.Size);
    $g.Dispose();
    $bmp.Save('${tmpEsc}', [System.Drawing.Imaging.ImageFormat]::Png);
  `;
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -STA -ExecutionPolicy Bypass -Command "${ps.replace(/\n/g,' ')}"`, { windowsHide: true }, (err) => {
      if (err) { console.error('⚠️ Error capturando Status (file):', err.message); return resolve(null); }
      resolve(tmp);
    });
  });
}
async function sendStatusSelf(chat, caption = "📊 *Status Actual de Ultra* ✅") {
  try {
    const b64 = await captureStatusRegionBase64();
    if (b64) {
      const media = new MessageMedia('image/png', b64, 'status.png');
      await chat.sendMessage(media, { caption });
      return;
    }
    const file = await captureStatusRegionToPng();
    if (!file || !fs.existsSync(file)) {
      await chat.sendMessage("⚠️ No se pudo capturar *Status*.");
      return;
    }
    const media = MessageMedia.fromFilePath(file);
    await chat.sendMessage(media, { caption });
    try { fs.unlinkSync(file); } catch (_) {}
  } catch (e) {
    console.error("❌ Error enviando Status interno:", e.message);
    await chat.sendMessage("⚠️ Error al enviar *Status*.");
  }
}

// ======================= OCR watcher (zona cuentas) =======================
let SETTINGS = {
  REGION: { x1: 1781, y1: 767, x2: 1883, y2: 831 }, // ZONA OCR
  SCALE: 1.0,
  OFFSET: { dx: 0, dy: 0 },
  POLL_MS: 20000,
  CONFIRM_CHANGES: 1,
  COOLDOWN_MS: 0,
  SEND_SCREENSHOT: true,
  DEBUG: true,

  OCR_ON: true,               // 🔻 INICIA ENCENDIDO
  OCR_UPSCALE: 3,
  OCR_THRESHOLD: 200,
  OCR_INVERT: false,
  OCR_PSM: 7,
  OCR_WHITELIST: '0123456789',
  OCR_MIN_CONF: 35,

  OCR_AUTOTUNE: true,
  OCR_THRESHOLD_ALT: 160,
  OCR_UPSCALE_ALT: 4,

  ALERT_ON_INCREASE: true,
  ALERT_ON_DECREASE: false
};

const ALERT_TEMPLATE = (curr, prev) =>
  `🚨 *Se deslogueó una cuenta.*\n` +
  `📊 Conteo actual: *${curr}* (previo: ${prev}).\n` +
  `✅ Puedes iniciar otra cuando gustes. 🔄🙂`;

const TARGET_CHAT_ID   = "584121296982@c.us"; // +58 412 129 6982
const TARGET_CHAT_NAME = "jho";

// PowerShell helper
function runPS(psScript, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const cmd = `powershell -NoProfile -STA -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`;
    exec(cmd, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), err });
    });
  });
}
function applyScaleOffset(r) {
  const s = SETTINGS.SCALE || 1.0;
  const dx = SETTINGS.OFFSET.dx || 0, dy = SETTINGS.OFFSET.dy || 0;
  return {
    x1: Math.round(r.x1 * s) + dx,
    y1: Math.round(r.y1 * s) + dy,
    x2: Math.round(r.x2 * s) + dx,
    y2: Math.round(r.y2 * s) + dy
  };
}
async function captureRegionPNG(r) {
  const rr = applyScaleOffset(r);
  const { x1, y1, x2, y2 } = rr;
  const w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1);
  const out = path.join(os.tmpdir(), `ultra_region_${Date.now()}_${Math.random().toString(36).slice(2)}.png`).replace(/\\/g, '\\\\');
  const ps = `
    Add-Type -AssemblyName System.Drawing;
    $bmp = New-Object System.Drawing.Bitmap(${w}, ${h});
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.CopyFromScreen(${x1}, ${y1}, 0, 0, $bmp.Size);
    $bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);
    '${out}'
  `;
  const res = await runPS(ps);
  return res.ok ? res.stdout.replace(/\r?\n/g, '') : null;
}
async function preprocessForOCRCustom(inputPath, { upscale, threshold, invert }) {
  const suffix =
    (threshold < 0 ? `.gray` : `.thr${threshold}`) +
    (invert ? `.inv` : ``) +
    `.x${upscale}`;
  const outPath = inputPath.replace(/\.png$/i, `${suffix}.png`);

  const scale = Math.max(1, Math.min(5, Number(upscale) || 1));
  const thr = Number.isFinite(threshold) ? threshold : 200;
  const inv = invert ? '1' : '0';

  const ps = `
param($in,$out,$scale,$thr,$invert)
Add-Type -AssemblyName System.Drawing;
Add-Type -AssemblyName System.Drawing.Drawing2D;

$src = [System.Drawing.Bitmap]::FromFile($in);
$newW = [int][Math]::Round($src.Width * $scale);
$newH = [int][Math]::Round($src.Height * $scale);
if ($newW -lt 1) { $newW = 1 } ; if ($newH -lt 1) { $newH = 1 }
$dst = New-Object System.Drawing.Bitmap($newW, $newH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb);
$g = [System.Drawing.Graphics]::FromImage($dst);
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, 0, 0, $newW, $newH);
$g.Dispose(); $src.Dispose();

for ($y=0; $y -lt $dst.Height; $y++) {
  for ($x=0; $x -lt $dst.Width; $x++) {
    $c = $dst.GetPixel($x,$y);
    $lum = [int](0.299*$c.R + 0.587*$c.G + 0.114*$c.B);
    if ($thr -lt 0) {
      $val = $lum
      if ($invert -eq 1) { $val = 255 - $val }
      $dst.SetPixel($x,$y,[System.Drawing.Color]::FromArgb($val,$val,$val));
    } else {
      $bw = if ($lum -ge $thr) { 255 } else { 0 }
      if ($invert -eq 1) { $bw = 255 - $bw }
      $dst.SetPixel($x,$y,[System.Drawing.Color]::FromArgb($bw,$bw,$bw));
    }
  }
}
$dst.Save($out, [System.Drawing.Imaging.ImageFormat]::Png);
$dst.Dispose();
$out
`;
  const cmd = `powershell -NoProfile -STA -ExecutionPolicy Bypass -Command "${ps.replace(/\n/g,' ')}" -in '${inputPath.replace(/\\/g,'\\\\')}' -out '${outPath.replace(/\\/g,'\\\\')}' -scale ${scale} -thr ${thr} -invert ${inv}`;
  await runPS(cmd, 120000);
  return fs.existsSync(outPath) ? outPath : inputPath;
}
function normText(s) {
  if (!s) return '';
  if (/^[0-9]+$/.test(SETTINGS.OCR_WHITELIST || '')) {
    const m = s.match(/[0-9]+/g);
    return (m ? m.join('') : '').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}
async function recognizeText(prepPath, psm) {
  const options = {
    tessedit_char_whitelist: SETTINGS.OCR_WHITELIST,
    tessedit_pageseg_mode: String(psm ?? SETTINGS.OCR_PSM),
    user_defined_dpi: '300',
    preserve_interword_spaces: '1'
  };
  const { data } = await Tesseract.recognize(prepPath, 'eng', options);
  const text = normText(data?.text || '');
  const conf = Math.round((data?.confidence || 0));
  return { text, conf };
}
async function readRegionText() {
  const rawPath = await captureRegionPNG(SETTINGS.REGION);
  if (!rawPath || !fs.existsSync(rawPath)) return { text: '', conf: 0, raw: null, prep: null };

  const attempts = [];
  attempts.push({ label: 'A', params:{ upscale: SETTINGS.OCR_UPSCALE, threshold: SETTINGS.OCR_THRESHOLD,     invert: SETTINGS.OCR_INVERT }, psm: SETTINGS.OCR_PSM });
  if (SETTINGS.OCR_AUTOTUNE) {
    attempts.push({ label: 'B', params:{ upscale: SETTINGS.OCR_UPSCALE,     threshold: SETTINGS.OCR_THRESHOLD_ALT, invert: SETTINGS.OCR_INVERT }, psm: SETTINGS.OCR_PSM });
    attempts.push({ label: 'C', params:{ upscale: SETTINGS.OCR_UPSCALE_ALT, threshold: -1,                         invert: SETTINGS.OCR_INVERT }, psm: SETTINGS.OCR_PSM });
    attempts.push({ label: 'D', params:{ upscale: SETTINGS.OCR_UPSCALE_ALT, threshold: -1,                         invert: SETTINGS.OCR_INVERT }, psm: 8 });
  }

  let best = { text: '', conf: 0, prep: null, label: '' };
  for (const at of attempts) {
    const prep = await preprocessForOCRCustom(rawPath, at.params);
    const { text, conf } = await recognizeText(prep, at.psm);
    if (SETTINGS.DEBUG) console.log(`🔎 [${at.label}] OCR="${text}" conf=${conf}% (psm=${at.psm})`);
    if (conf > best.conf) best = { text, conf, prep, label: at.label };
    if (conf >= SETTINGS.OCR_MIN_CONF && text) break;
  }
  if (SETTINGS.DEBUG) console.log(`✅ Mejor intento: [${best.label || '-'}] text="${best.text}" conf=${best.conf}%`);
  return { text: best.text, conf: best.conf, raw: rawPath, prep: best.prep };
}

async function resolveAlertChat() {
  if (!waReady) return null;
  if (TARGET_CHAT_ID) { try { return await client.getChatById(TARGET_CHAT_ID); } catch {} }
  if (TARGET_CHAT_NAME) {
    try {
      const chats = await client.getChats();
      const found = chats.find(c => (c.name || '').toLowerCase() === TARGET_CHAT_NAME.toLowerCase());
      if (found) return found;
    } catch {}
  }
  if (lastKnownChatId) { try { return await client.getChatById(lastKnownChatId); } catch {} }
  const chats = await client.getChats();
  if (chats && chats.length) return chats[0];
  return null;
}
async function sendZonaActual(chat){
  const raw = await captureRegionPNG(SETTINGS.REGION);
  if (raw && fs.existsSync(raw)) {
    const best = await readRegionText();
    await chat.sendMessage("📍 *Región cruda*");
    await chat.sendMessage(MessageMedia.fromFilePath(raw));
    if (best.prep && fs.existsSync(best.prep)) {
      await chat.sendMessage("🧪 *Región preprocesada (mejor intento OCR)*");
      await chat.sendMessage(MessageMedia.fromFilePath(best.prep));
    }
    try { if (fs.existsSync(raw)) fs.unlinkSync(raw); } catch {}
  } else {
    await chat.sendMessage("⚠️ No se pudo capturar la región. Ajusta *scale/offset/region*.");
  }
}
async function sendAlert(chat, force=false, currNum=null, prevNum=null) {
  try {
    if (!chat) return;
    const msg = force
      ? "🧪 *Test de alerta*"
      : ALERT_TEMPLATE(currNum ?? "?", prevNum ?? "?");
    await chat.sendMessage(msg, { linkPreview: false });

    if (SETTINGS.SEND_SCREENSHOT) {
      const f = await captureRegionPNG(SETTINGS.REGION);
      if (f && fs.existsSync(f)) {
        const prep = await preprocessForOCRCustom(f, { upscale: SETTINGS.OCR_UPSCALE, threshold: SETTINGS.OCR_THRESHOLD, invert: SETTINGS.OCR_INVERT });
        const media = MessageMedia.fromFilePath(prep);
        await chat.sendMessage(media, { caption: `🖼️ *Zona monitoreada*\n🔢 OCR: ${currNum ?? "?"}` });
        try { if (fs.existsSync(f)) fs.unlinkSync(f); if (fs.existsSync(prep)) fs.unlinkSync(prep); } catch {}
      }
    }
  } catch (e) { console.log("sendAlert err:", e.message); }
}

// ===== Loop OCR =====
let monitoring = false;   // arranca apagado
let lastAlertAt = 0;
let busy = false;
let lastNum = null;
let lastNumPrev = null;
let stableCount = 0;
let ocrFailCount = 0;     // contador de fallos OCR
function resetState(){ lastNum=null; lastNumPrev=null; stableCount=0; }

async function tick() {
  if (busy) return;
  busy = true;
  try {
 if (!monitoring || !SETTINGS.OCR_ON) return;

const { text, conf } = await readRegionText();
const valid = (conf >= SETTINGS.OCR_MIN_CONF);
const currParsed = valid ? parseInt(text, 10) : NaN;

if (SETTINGS.DEBUG) {
  console.log(`📄 OCR="${text}" (conf=${conf}%, valid=${valid})  curr=${isNaN(currParsed)?'NaN':currParsed}  last=${lastNum===null?'null':lastNum}`);
}

if (!valid || isNaN(currParsed)) {
  ocrFailCount++;
  console.log(`⚠️ OCR inválido (${ocrFailCount}/5 intentos)`);

  if (ocrFailCount >= 5) {
    console.log("🆘 OCR falló 5 veces seguidas. Ejecutando limpiarcache.bat...");
    try {
      const batPath = "C:\\Users\\Jhoseph\\whatsapp-bot\\limpiarcache.bat";
      exec(`start "" "${batPath}"`, { shell: 'cmd.exe' });
    } catch (e) {
      console.error("Error ejecutando limpiarcache.bat:", e.message);
    }
    ocrFailCount = 0;
  }

  return;
}

// ✅ Si OCR es válido → reinicia contador
ocrFailCount = 0;

    let changed = false;
    let increased = false;

    if (lastNum === null) {
      lastNum = currParsed; stableCount = 1;
    } else if (currParsed === lastNum) {
      stableCount++;
    } else {
      changed = true;
      increased = currParsed > lastNum;
      lastNumPrev = lastNum;
      lastNum = currParsed;
      stableCount = 1;
    }

    let shouldAlert = false;
    if (changed && increased && SETTINGS.ALERT_ON_INCREASE && stableCount >= SETTINGS.CONFIRM_CHANGES) {
      shouldAlert = true;
    }

    const now = Date.now();
    if (shouldAlert) {
      if (!waReady) {
        if (SETTINGS.DEBUG) console.log('⏳ WhatsApp no está listo aún; alerta pospuesta.');
      } else if (now - lastAlertAt >= SETTINGS.COOLDOWN_MS) {
        const chat = await resolveAlertChat();
        await sendAlert(chat, false, lastNum, lastNumPrev);
        lastAlertAt = now;
        console.log('✅ Alerta enviada (incremento).');
      } else if (SETTINGS.DEBUG) {
        console.log('⏳ En cooldown, alerta suprimida.');
      }
    }

  } catch (e) {
    console.log('tick err:', e.message);
  } finally {
    busy = false;
  }
}

// ======================= WhatsApp client =======================
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'ultra-combined' }),
  puppeteer: {
    headless: false,
    executablePath: chromePath || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 10000,
  // ✅ CAMBIO MÍNIMO: fijar versión de WhatsApp Web compatible
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/wa_version.json'
  }
});

let waReady = false;
let lastKnownChatId = null;
let seenMsgIds = new Set(); // <- lo limpiamos en el auto-mantenimiento

client.on('qr', qr => { console.clear(); console.log("📲 Escanea este QR en WhatsApp Web:"); qrcode.generate(qr, { small: true }); });

// ===== Bienvenida al iniciar el BOT (no al correr macros) =====
async function sendWelcomeOnReady() {
  try {
    const chat = await resolveAlertChat();
    if (!chat) return;
    // Mensaje de bienvenida + gato negro
    if (fs.existsSync(BLACK_CAT_IMG)) {
      const cat = MessageMedia.fromFilePath(BLACK_CAT_IMG);
      await chat.sendMessage(cat, { caption: "🐈‍⬛ ¡Bot iniciado y listo! Si necesitas algo, aquí estoy." });
    } else {
      await chat.sendMessage("🐈‍⬛ ¡Bot iniciado y listo! (Coloca un gato en assets\\black_cat.png para foto real)");
    }
    // Luego de la bienvenida, enviar también el status
    await sendStatusSelf(chat, "📊 *Status Actual tras inicio* ✅");
  } catch (e) {
    console.error("Bienvenida error:", e?.message || e);
  }
}

client.on('ready', async () => {
  clearBootTimer();          // ya “agarró”
  restartAttempts = 0;       // éxito: resetea contador de reintentos
  waReady = true;
  console.log('✅ WhatsApp listo');
  await sendWelcomeOnReady(); // <<< AQUÍ la bienvenida con gato negro
  // Activar monitor OCR automáticamente 1 minuto después de iniciar
  setTimeout(() => {
    monitoring = true;
    console.log("🟢 Monitor OCR activado automáticamente tras 1 minuto de inicio.");
  }, 60000);

  // Enlazar señales para reiniciar si Chrome o la página se cierran
  try {
    if (client.pupBrowser) {
      client.pupBrowser.removeAllListeners?.('disconnected');
      client.pupBrowser.on('disconnected', () => {
        console.log('⚠️ Chrome/Puppeteer se cerró. Reintentando...');
        safeRestartWhatsApp('browser-disconnected');
      });
    }
    if (client.pupPage) {
      client.pupPage.removeAllListeners?.('close');
      client.pupPage.on('close', () => {
        console.log('⚠️ La página de WhatsApp se cerró. Reintentando...');
        safeRestartWhatsApp('page-closed');
      });
    }
  } catch (e) {
    console.log('No fue posible enlazar handlers de browser/page:', e.message);
  }

  // Iniciar planificador para Reinicio total (intervalo ajustable)
  if (!autoReinicioStarted) {
    startAutoReinicioLoop().catch(e => console.error("autoReinicio error:", e?.message || e));
    autoReinicioStarted = true;
  }
});
client.on('auth_failure', (m) => console.log('❌ auth_failure:', m));
client.on('change_state', (s) => console.log('🔄 state:', s));
client.on('disconnected', (r) => {
  waReady = false;
  console.log('⛔ disconnected:', r);
  safeRestartWhatsApp(`client-disconnected:${r || 'unknown'}`);
});

function shouldHandle(msg, source) {
  if (!msg || !msg.id || seenMsgIds.has(msg.id._serialized)) return false;
  if (source === 'message_create' && !msg.fromMe) return false;
  if (source === 'message' && msg.fromMe) return false;
  seenMsgIds.add(msg.id._serialized);
  return true;
}
client.on('message_create', async (msg) => { if (!shouldHandle(msg, 'message_create')) return; await handleChatMessage(msg, 'message_create'); });
client.on('message',        async (msg) => { if (!shouldHandle(msg, 'message'))        return; await handleChatMessage(msg, 'message'); });

// ======================= Mail.tm (igual que antes) =======================
const chatAccounts = new Map();
const watchers = new Map();
const creating = new Set();
const lastCorreoAt = new Map();
const pinSent = new Map();
const sendingPin = new Set();

let cachedDomains = [];
let cachedDomainsTs = 0;
const DOMAINS_TTL_MS = 5 * 60 * 1000;

async function getDomains() {
  const now = Date.now();
  if (cachedDomains.length && (now - cachedDomainsTs) < DOMAINS_TTL_MS) return cachedDomains;
  const res = await axios.get('https://api.mail.tm/domains?page=1');
  const arr = res.data?.['hydra:member'] || [];
  if (!arr.length) throw new Error('Sin dominios en Mail.tm');
  cachedDomains = arr.map(d => d.domain);
  cachedDomainsTs = now;
  return cachedDomains;
}
async function createMailTmAccountWithRetry(maxAttempts = 5) {
  let attempt = 0, lastErr;
  const domains = await getDomains();
  while (attempt < maxAttempts) {
    attempt++;
    try {
      await sleep(200 + Math.floor(Math.random() * 150));
      const domain = domains[attempt % domains.length] || domains[0];
      const local = 'bot' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const address = `${local}@${domain}`;
      const password = crypto.randomBytes(8).toString('hex');
      await axios.post('https://api.mail.tm/accounts', { address, password });
      const tokenRes = await axios.post('https://api.mail.tm/token', { address, password });
      const token = tokenRes.data?.token;
      if (!token) throw new Error('No se obtuvo token de Mail.tm');
      return { address, password, token };
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      let retryAfterMs = 0;
      if (status === 429) {
        const ra = e.response?.headers?.['retry-after'];
        if (ra) { const sec = parseInt(ra, 10); if (!isNaN(sec)) retryAfterMs = sec * 1000; }
        if (!retryAfterMs) retryAfterMs = Math.min(20000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
        await sleep(retryAfterMs);
        continue;
      }
      if (status === 409) { await sleep(300 + Math.random() * 300); continue; }
      await sleep(500 + Math.random() * 500);
    }
  }
  throw lastErr || new Error('Fallo creando cuenta Mail.tm');
}
async function listMessages(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await axios.get('https://api.mail.tm/messages', { headers });
  return res.data?.['hydra:member'] || [];
}
async function getMessage(token, id) {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await axios.get(`https://api.mail.tm/messages/${id}`, { headers });
  return res.data;
}
async function markMessageSeen(token, id) {
  const headers = { Authorization: `Bearer ${token}` };
  try { await axios.patch(`https://api.mail.tm/messages/${id}`, { seen: true }, { headers }); }
  catch (_) {}
}
async function deleteMailTmAccount(token) {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const me = await axios.get('https://api.mail.tm/me', { headers });
    const accountId = me.data?.id;
    if (accountId) await axios.delete(`https://api.mail.tm/accounts/${accountId}`, { headers });
  } catch (_) {}
}
function extractSixDigitFromSubjectFirst(msgDetail) {
  const KW_CODE_NEAR = /(?:(?:pin|c[oó]digo)\D{0,10}(\b\d{6}\b))|((\b\d{6}\b)\D{0,10}(?:pin|c[oó]digo))/i;
  if (msgDetail?.subject) {
    const m = msgDetail.subject.match(KW_CODE_NEAR);
    if (m) return (m[1] || m[2]).match(/\d{6}/)[0];
  }
  const pool = [];
  if (msgDetail?.intro) pool.push(msgDetail.intro);
  if (Array.isArray(msgDetail?.text)) pool.push(...msgDetail.text);
  else if (typeof msgDetail?.text === 'string') pool.push(msgDetail.text);
  if (Array.isArray(msgDetail?.html)) pool.push(...msgDetail.html);
  else if (typeof msgDetail?.html === 'string') pool.push(msgDetail.html);
  const body = pool.filter(Boolean).join('\n');
  const mBody = body.match(KW_CODE_NEAR);
  if (mBody) return (mBody[1] || mBody[2]).match(/\d{6}/)[0];
  return null;
}
function startWatcher(chatId, token, startedAt) {
  stopWatcher(chatId);
  const seenIds = new Set();
  const attempts = new Map();
  const firstSeen = new Map();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const MAX_ATTEMPTS = 8;
  const MAX_AGE_MS   = 90 * 1000;
  const BUFFER_MS    = 10 * 1000;
  const DUPE_WINDOW  = 120 * 1000;

  const intervalId = setInterval(async () => {
    try {
      if (pinSent.has(chatId)) { stopWatcher(chatId); return; }
      if (Date.now() >= expiresAt) { stopWatcher(chatId); return; }

      const msgs = await listMessages(token);
      const recent = msgs
        .filter(m => {
          if (m?.seen) return false;
          const t = m?.createdAt ? new Date(m.createdAt).getTime() : 0;
          return t >= (startedAt - BUFFER_MS);
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      for (const m of recent) {
        if (seenIds.has(m.id)) continue;

        if (!firstSeen.has(m.id)) firstSeen.set(m.id, Date.now());
        const age = Date.now() - firstSeen.get(m.id);
        const tries = (attempts.get(m.id) || 0);

        if (tries >= MAX_ATTEMPTS || age > MAX_AGE_MS) {
          seenIds.add(m.id);
          continue;
        }

        await sleep(900);
        attempts.set(m.id, tries + 1);

        let detail;
        try { detail = await getMessage(token, m.id); }
        catch (_) { continue; }

        const code = extractSixDigitFromSubjectFirst(detail);
        if (code) {
          if (sendingPin.has(chatId)) { continue; }
          const prev = pinSent.get(chatId);
          if (prev && prev.code === code && (Date.now() - prev.at) < DUPE_WINDOW) {
            await markMessageSeen(token, m.id);
            seenIds.add(m.id);
            continue;
          }
          sendingPin.add(chatId);
          try {
            await markMessageSeen(token, m.id);
            await sleep(150);
            await client.sendMessage(chatId, `PIN ${code}`);
            pinSent.set(chatId, { code, at: Date.now() });
            stopWatcher(chatId);
          } finally {
            sendingPin.delete(chatId);
          }
          return;
        }
      }
    } catch (err) {
      console.error("⚠️ Watcher error:", err?.message || err);
    }
  }, 2000);

  watchers.set(chatId, { intervalId, expiresAt, seenIds, attempts, firstSeen });
}
function stopWatcher(chatId) {
  const w = watchers.get(chatId);
  if (w?.intervalId) clearInterval(w.intervalId);
  watchers.delete(chatId);
}

// ======================= Instrucciones =======================
function instrucciones() {
  const s=SETTINGS;
  const hrs = Math.round(autoReinicioIntervalMs/3600000*10)/10;
  const estadoAuto = autoReinicioEnabled ? `ON cada ~${hrs}h` : 'OFF';
  return (
`📘 *Instrucciones*\n
🧪 *ping* — prueba rápida (respuesta: *pong*).
🟢 *monitor on* / 🔴 *monitor off* — activar/pausar monitoreo OCR.
🗺️ *zona actual* — envía captura cruda + preprocesada (lo que lee el OCR).
🚨 *test alert* — simula una alerta.
📊 *cuentas inactivas* — reporte con número y confianza.\n
🧭 *region x1 y1 x2 y2* — define zona exacta (px).
🪟 *scale X* — factor DPI (ej: 1.25 / 1.5).
🎯 *offset dx dy* — desplaza toda la zona (px).
⏱️ *poll X* — intervalo en ms (300–10000).
✅ *confirm X* — lecturas iguales para confirmar (1–10).
🧊 *cooldown X* — segundos entre alertas (0=sin espera).
🪲 *debug on|off* — logs.\n
🔎 *OCR*:
• 🟩 *ocr on* / ⏸️ *ocr off*
• 🧩 *ocr psm N* — 6/7/8.
• 🔤 *ocr whitelist <chars>* — p.ej. "0123456789".
• 🔎 *ocr upscale N* — 1..5 (recomendado 3).
• ⚖️ *ocr thr N* — -1..255 (200 por defecto, -1=gris).
• ⚖️ *ocr thr alt N* — alterno (160 por defecto).
• 🔎 *ocr upscale alt N* — alterno (4 por defecto).
• 🔁 *ocr autotune on|off*
• 🔄 *ocr invert on|off*
• 🎯 *ocr minconf N* — 0..100 (35 por defecto).\n
📈 *Lógica de alerta (número vigilado = cuentas inactivas)*:
• ⬆️ AUMENTA ⇒ se cerró una cuenta → **ALERTA** ✅
• ⬇️ DISMINUYE ⇒ tú iniciaste una cuenta → **NO alertar** ❌\n
🖼️ *status* — captura propia de la región de estado (sin AHK).
📑 *tabs* — usa macro Tabs.ahk (espera fin y envía captura del portapapeles).
✉️ *correo* — crea correo temporal y vigila PIN (Mail.tm).
▶️ *listo* — inicia UltraBot.ahk (si ya había uno, lo reinicia).
♻️ *reboot* — ejecuta reboot.ahk y al finalizar envía status.\n
🆕 *reinicio total* — ejecuta *reiniciototal.ahk*; espera fin y envía la imagen del portapapeles.
🆕 *capture* — ejecuta *capture.ahk*; espera fin y envía la imagen del portapapeles.\n
⏰ *Auto-Reinicio*: ${estadoAuto}
• *auto reinicio 2h* / *auto reinicio 120m* — cambia el intervalo
• *auto reinicio on* / *auto reinicio off*
• *ver auto reinicio* — muestra la configuración actual\n
⚙️ *Estado actual*:
• Región=(${s.REGION.x1},${s.REGION.y1})→(${s.REGION.x2},${s.REGION.y2})  |  SCALE=${s.SCALE}  |  OFFSET=(${s.OFFSET.dx},${s.OFFSET.dy})
• OCR: on=${s.OCR_ON}  |  psm=${s.OCR_PSM}  |  wl="${s.OCR_WHITELIST}"  |  upscale=${s.OCR_UPSCALE}x  |  thr=${s.OCR_THRESHOLD}  |  thr_alt=${s.OCR_THRESHOLD_ALT}  |  invert=${s.OCR_INVERT}  |  minconf=${s.OCR_MIN_CONF}  |  autotune=${s.OCR_AUTOTUNE ? 'ON':'OFF'}
• Confirm=${s.CONFIRM_CHANGES}  |  Cooldown=${Math.round(s.COOLDOWN_MS/1000)}s  |  Poll=${s.POLL_MS}ms  |  Debug=${s.DEBUG ? 'ON':'OFF'}`
  );
}

// ======================= Auto-mantenimiento (como antes) =======================
async function cleanupTempImages(maxAgeMs = 5 * 60 * 1000) {
  try {
    const dir = os.tmpdir();
    const prefixes = ['ultra_region_', 'status_', 'ultra_clip_'];
    const now = Date.now();
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!prefixes.some(p => f.startsWith(p))) continue;
      if (!/\.(png|jpg|jpeg|bmp|gif)$/i.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(full);
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error("cleanupTempImages:", e?.message || e);
  }
}

async function clearChromiumCacheAndCookies() {
  try {
    const page = client?.pupPage;
    if (!page) return;
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.clearBrowserCookies');
  } catch (e) {
    console.error("clearChromiumCacheAndCookies:", e?.message || e);
  }
}

async function performSelfMaintenance(reason = 'auto') {
  try {
    await cleanupTempImages(2 * 60 * 1000);
    seenMsgIds.clear();
    await clearChromiumCacheAndCookies();
    if (global.gc) {
      global.gc(); await sleep(200); global.gc();
    }
  } catch (e) {
    console.error("performSelfMaintenance:", e?.message || e);
  }
}

// ======================= Handler de mensajes =======================
async function handleChatMessage(msg, sourceEvent) {
  try {
    if (!waReady) return;
    const chat = await msg.getChat();
    lastKnownChatId = chat?.id?._serialized || lastKnownChatId;
    const raw = (msg.body || '').trim();
    const t = raw.toLowerCase();
    if (SETTINGS.DEBUG) console.log(`💬 [${sourceEvent}] text="${raw}" fromMe=${msg.fromMe}`);

    // Instrucciones
    if (t === 'instrucciones' || t === 'intrucciones' || t === 'help') {
      await chat.sendMessage(instrucciones()); return;
    }

    // Auto reinicio: ver/ajustar
   if (t === 'ver auto reinicio') {
  const hrs = Math.round(autoReinicioIntervalMs/3600000*10)/10;

  if (!autoReinicioEnabled) {
    await chat.sendMessage(`⏰ Auto-Reinicio: OFF (intervalo configurado cada ~${hrs}h)`);
    return;
  }

  if (!nextAutoReinicioAt) {
    await chat.sendMessage(`⏰ Auto-Reinicio: ON cada ~${hrs}h\n⚠️ Aún no se ha calculado el próximo reinicio.`);
    return;
  }

  const now = Date.now();
  const diffMs = nextAutoReinicioAt - now;
  if (diffMs <= 0) {
    await chat.sendMessage(`⏰ El reinicio automático debería estar iniciándose en este momento.`);
    return;
  }

  const totalSec = Math.floor(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  const nextDate = new Date(nextAutoReinicioAt);
  const horaExacta = nextDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  await chat.sendMessage(
    `⏰ Auto-Reinicio: ON cada ~${hrs}h\n` +
    `🕒 Próximo reinicio en: *${h}h ${m}m ${s}s*\n` +
    `📅 Hora exacta: *${horaExacta}*`
  );
  return;
}

    if (t === 'auto reinicio on') {
      autoReinicioEnabled = true;
      await chat.sendMessage(`✅ Auto-Reinicio activado (cada ~${Math.round(autoReinicioIntervalMs/3600000*10)/10}h).`);
      return;
    }
    if (t === 'auto reinicio off') {
      autoReinicioEnabled = false;
      await chat.sendMessage('⏸️ Auto-Reinicio desactivado.');
      return;
    }
    if (t.startsWith('auto reinicio ')) {
      // Formatos soportados: "auto reinicio 3h", "auto reinicio 90m"
      const arg = raw.slice('auto reinicio '.length).trim().toLowerCase();
      const m = arg.match(/^(\d+)\s*(h|hr|hrs|hora|horas|m|min|mins|minutos)?$/);
      if (!m) { await chat.sendMessage('⚠️ Usa: *auto reinicio 3h* o *auto reinicio 90m*'); return; }
      const n = parseInt(m[1], 10);
      const unit = m[2] || 'h';
      if (isNaN(n) || n <= 0) { await chat.sendMessage('⚠️ Debe ser un número mayor que 0.'); return; }
      let ms = 0;
      if (/^m/.test(unit)) ms = n * 60 * 1000; // minutos
      else ms = n * 60 * 60 * 1000;           // horas (default)
      autoReinicioIntervalMs = Math.max(5*60*1000, ms); // mínimo 5 min para seguridad
      await chat.sendMessage(`✅ Intervalo actualizado: cada ~${Math.round(autoReinicioIntervalMs/3600000*10)/10}h. (auto reinicio ${autoReinicioEnabled ? 'ON' : 'OFF'})`);
      return;
    }

    // Reporte “cuentas inactivas”
    if (
      t === 'cuentas inactivas' || t === 'estado de cuentas' ||
      t === 'reporte de cuentas' || t === 'reporte cuentas' ||
      t === 'conteo' || t === 'conteo actual' ||
      t === 'status cuentas' || t === 'cuántas hay' || t === 'cuantas hay' ||
      t === 'cuentas' || t === 'inactivas' || t === 'recuento'
    ) {
      const { text, conf } = await readRegionText();
      const n = parseInt(text, 10);
      const confTxt = Number.isFinite(conf) ? `${conf}%` : 'N/D';
      if (!isNaN(n)) {
        await chat.sendMessage(
          `📊 *Reporte de cuentas inactivas*\n` +
          `• Conteo detectado: *${n}*\n` +
          `• Confianza OCR: ${confTxt}\n` +
          `• Nota: Un número mayor indica más cuentas cerradas recientemente.\n` +
          `— _Solicitud: "cuentas inactivas"_ ✅`
        );
      } else {
        await chat.sendMessage(
          `ℹ️ No pude obtener un número válido en esta lectura.\n` +
          `Usa *zona actual* para verificar la región o ajusta OCR con *ocr thr 160/220*, *ocr invert on*, *ocr psm 7/8*.`
        );
      }
      return;
    }

    // Básicos
    if (t === 'ping')            { await chat.sendMessage('pong'); return; }
    if (t === 'monitor on')      { monitoring = true;  await chat.sendMessage('🟢 *Monitor* activado.'); return; }
    if (t === 'monitor off')     { monitoring = false; await chat.sendMessage('🔴 *Monitor* desactivado.'); return; }
    if (t === 'test alert')      { const c = await resolveAlertChat(); await sendAlert(c, true, lastNum, lastNumPrev); return; }

    // "zona actual" (sinónimos)
    if (
      t === 'zona actual' || t === 'zona' || t === 'ver zona' ||
      t === 'estado de zona' || t === 'captura zona' || t === 'región' || t === 'region'
    ) {
      await sendZonaActual(chat); return;
    }

    // OCR ajustes
    if (t === 'ocr on')          { SETTINGS.OCR_ON = true;  await chat.sendMessage('✅ OCR *ON*'); return; }
    if (t === 'ocr off')         { SETTINGS.OCR_ON = false; await chat.sendMessage('⏸️ OCR *OFF*'); return; }
    if (t.startsWith('ocr psm ')){
      const n = parseInt(raw.split(/\s+/)[2],10);
      if (!isNaN(n)&&n>=3&&n<=13){ SETTINGS.OCR_PSM=n; resetState(); await chat.sendMessage(`✅ OCR PSM=${n}`); }
      else { await chat.sendMessage('⚠️ Usa: "ocr psm 7" (3..13)'); }
      return;
    }
    if (t.startsWith('ocr whitelist ')) {
      const wl = raw.slice('ocr whitelist '.length).trim();
      SETTINGS.OCR_WHITELIST = wl || SETTINGS.OCR_WHITELIST; resetState();
      await chat.sendMessage(`✅ OCR whitelist="${SETTINGS.OCR_WHITELIST}"`); return;
    }
    if (t.startsWith('ocr upscale ')) {
      const n = parseFloat(raw.split(/\s+/)[2]);
      if (!isNaN(n)&&n>=1&&n<=5){ SETTINGS.OCR_UPSCALE=n; resetState(); await chat.sendMessage(`✅ OCR upscale=${n}x`); }
      else { await chat.sendMessage('⚠️ "ocr upscale 3" (1..5)'); }
      return;
    }
    if (t.startsWith('ocr thr ')){
      const n = parseInt(raw.split(/\s+/)[2],10);
      if (!isNaN(n)&&n>=-1&&n<=255){ SETTINGS.OCR_THRESHOLD=n; resetState(); await chat.sendMessage(`✅ OCR threshold=${n}`); }
      else { await chat.sendMessage('⚠️ "ocr thr 200" (-1..255)  (-1=gris)'); }
      return;
    }
    if (t.startsWith('ocr thr alt ')){
      const n = parseInt(raw.split(/\s+/)[3],10);
      if (!isNaN(n)&&n>=0&&n<=255){ SETTINGS.OCR_THRESHOLD_ALT=n; await chat.sendMessage(`✅ OCR threshold_alt=${n}`); }
      else { await chat.sendMessage('⚠️ "ocr thr alt 160" (0..255)'); }
      return;
    }
    if (t.startsWith('ocr upscale alt ')){
      const n = parseFloat(raw.split(/\s+/)[3]);
      if (!isNaN(n)&&n>=1&&n<=5){ SETTINGS.OCR_UPSCALE_ALT=n; await chat.sendMessage(`✅ OCR upscale_alt=${n}x`); }
      else { await chat.sendMessage('⚠️ "ocr upscale alt 4" (1..5)'); }
      return;
    }
    if (t === 'ocr autotune on')  { SETTINGS.OCR_AUTOTUNE = true;  await chat.sendMessage('✅ OCR autotune=ON'); return; }
    if (t === 'ocr autotune off') { SETTINGS.OCR_AUTOTUNE = false; await chat.sendMessage('⏸️ OCR autotune=OFF'); return; }
    if (t === 'ocr invert on')   { SETTINGS.OCR_INVERT=true;  resetState(); await chat.sendMessage('✅ OCR invert=ON'); return; }
    if (t === 'ocr invert off')  { SETTINGS.OCR_INVERT=false; resetState(); await chat.sendMessage('✅ OCR invert=OFF'); return; }
    if (t.startsWith('ocr minconf ')) {
      const n = parseInt(raw.split(/\s+/)[2],10);
      if (!isNaN(n)&&n>=0&&n<=100){ SETTINGS.OCR_MIN_CONF=n; await chat.sendMessage(`✅ OCR min_conf=${n}%`); }
      else { await chat.sendMessage('⚠️ "ocr minconf 35" (0..100)'); }
      return;
    }

    // Región/escala/offset
    if (t.startsWith('region ')) {
      const parts = raw.split(/\s+/).slice(1).map(n=>parseInt(n,10));
      if (parts.length===4 && parts.every(n=>!isNaN(n))) {
        let [x1,y1,x2,y2]=parts; if(x2<x1)[x1,x2]=[x2,x1]; if(y2<y1)[y1,y2]=[y2,y1];
        SETTINGS.REGION={x1,y1,x2,y2}; resetState();
        await chat.sendMessage(`✅ Región: (${x1},${y1}) → (${x2},${y2})`);
      } else { await chat.sendMessage('⚠️ "region 1781 767 1883 831"'); }
      return;
    }
    if (t.startsWith('scale ')) {
      const v = parseFloat(raw.split(/\s+/)[1]); if(!isNaN(v)&&v>0.2&&v<5){ SETTINGS.SCALE=v; resetState(); await chat.sendMessage(`✅ SCALE=${v}`);} else { await chat.sendMessage('⚠️ "scale 1.25"'); }
      return;
    }
    if (t.startsWith('offset ')) {
      const ps = raw.split(/\s+/).slice(1).map(n=>parseInt(n,10));
      if(ps.length===2 && ps.every(n=>!isNaN(n))){ SETTINGS.OFFSET={dx:ps[0],dy:ps[1]}; resetState(); await chat.sendMessage(`✅ OFFSET=(${ps[0]}, ${ps[1]})`);} else { await chat.sendMessage('⚠️ "offset 100 0"'); }
      return;
    }
    if (t.startsWith('poll ')) {
      const v=parseInt(raw.split(/\s+/)[1],10); if(!isNaN(v)&&v>=300&&v<=10000){ SETTINGS.POLL_MS=v; await chat.sendMessage(`✅ Poll=${v}ms`);} else { await chat.sendMessage('⚠️ "poll 800" (300..10000)'); }
      return;
    }
    if (t.startsWith('confirm ')) {
      const v=parseInt(raw.split(/\s+/)[1],10); if(!isNaN(v)&&v>=1&&v<=10){ SETTINGS.CONFIRM_CHANGES=v; await chat.sendMessage(`✅ Confirm=${v}`);} else { await chat.sendMessage('⚠️ "confirm 2" (1..10)'); }
      return;
    }
    if (t.startsWith('cooldown ')) {
      const v=parseInt(raw.split(/\s+/)[1],10); if(!isNaN(v)&&v>=0){ SETTINGS.COOLDOWN_MS=v*1000; await chat.sendMessage(`✅ Cooldown=${v}s`);} else { await chat.sendMessage('⚠️ "cooldown 60"'); }
      return;
    }
    if (t === 'debug on')  { SETTINGS.DEBUG=true;  await chat.sendMessage('🪲 Debug *ON*'); return; }
    if (t === 'debug off') { SETTINGS.DEBUG=false; await chat.sendMessage('🪲 Debug *OFF*'); return; }

    // ====== Comandos tipo sistema/ULTRA ======
    if (t === 'status') {
      await msg.reply("⏳ Obteniendo *Status Actual de Ultra*...");
      await sendStatusSelf(chat, "📊 *Status Actual de Ultra* ✅");
      return;
    }

    if (t === 'tabs') {
      await msg.reply("⏳ Obteniendo *Tabs Actuales de Ultra*...");
      await runAhkAndWait(AHK_TABS); // espera ESTRICTA
      await sendClipboardImage(chat, "📑 *Tabs Actuales de Ultra* ✅");
      return;
    }

    if (t === 'listo') {
      // ÚNICA función que puede solaparse: mata la instancia previa y relanza
      try {
        await chat.sendMessage("🔁 Reiniciando *UltraBot.ahk* (si estaba en ejecución)...");
        await killAhkByScript(AHK_SCRIPT);
        const acc = chatAccounts.get(chat.id._serialized);
        if (acc?.address) clipboardy.writeSync(acc.address);
        await new Promise((res)=> {
          exec(`start "" "${AHK_SCRIPT}"`, { shell: 'cmd.exe' }, () => res());
        });
        await chat.sendMessage("✅ *UltraBot.ahk* iniciado.");
      } catch (err) {
        console.error("⚠️ Error en comando Listo:", err.message);
        await chat.sendMessage("⚠️ Ocurrió un problema al iniciar UltraBot.");
      }
      return;
    }

    if (t === 'reboot') {
      try {
        rebootInProgress = true;
        await killAhkByScript(AHK_SCRIPT);
        await sleep(1000);
        await msg.reply("♻️ Se reiniciará la macro…");
        const acc = chatAccounts.get(chat.id._serialized);
        if (acc?.address) clipboardy.writeSync(acc.address);
        await new Promise((res)=> {
          exec(`start "" "${REBOOT_SCRIPT}"`, { shell: 'cmd.exe' }, () => res());
        });
      } catch (err) {
        console.error("⚠️ Error en comando reboot:", err?.message || err);
        await msg.reply("⚠️ No se pudo reiniciar la macro.");
      }
      return;
    }

    // ====== NUEVOS COMANDOS (con espera estricta) ======
    if (t === 'reinicio total' || t === 'reiniciototal' || t === 'reinicio_total') {
      try {
        await chat.sendMessage("🔄 Iniciando *Reinicio total* Tiempo aproximado: *6 minutos* …");
        await runAhkAndWait(REINICIO_TOTAL_SCRIPT);               // ESPERA real a que termine
        await chat.sendMessage("✅ *Reinicio total* finalizado. Preparando envío de captura del portapapeles…");
        await sendClipboardImage(chat, "🖼️ *Resultado Reinicio total*");
        await chat.sendMessage("📨 *Reinicio total* — captura enviada.\n🧹 Realizando auto-mantenimiento…");
        await performSelfMaintenance('manual-reinicio-total');
        await chat.sendMessage("✅ Auto-mantenimiento completado.");
      } catch (e) {
        console.error("⚠️ Reinicio total error:", e?.message || e);
        await chat.sendMessage("❌ Error durante *Reinicio total*.");
      }
      return;
    }

    if (t === 'capture') {
      try {
        await chat.sendMessage("📸 Iniciando *capture*…");
        await runAhkAndWait(CAPTURE_SCRIPT);                      // ESPERA real a que termine
        await chat.sendMessage("✅ *capture* finalizado. Preparando envío de captura del portapapeles…");
        await sendClipboardImage(chat, "🖼️ *Resultado capture*");
        await chat.sendMessage("📨 *capture* — captura enviada.");
      } catch (e) {
        console.error("⚠️ capture error:", e?.message || e);
        await chat.sendMessage("❌ Error durante *capture*.");
      }
      return;
    }

    // ====== Mail.tm: "correo" ======
    if (t === 'correo') {
      const chatId = chat.id._serialized;
      const now = Date.now();
      const last = lastCorreoAt.get(chatId) || 0;
      if (now - last < 2000) return;
      lastCorreoAt.set(chatId, now);
      if (creating.has(chatId)) return;
      creating.add(chatId);

      try {
        const prev = chatAccounts.get(chatId);
        if (prev?.token) {
          stopWatcher(chatId);
          await deleteMailTmAccount(prev.token);
          chatAccounts.delete(chatId);
        }
        pinSent.delete(chatId);
        sendingPin.delete(chatId);

        const acc = await createMailTmAccountWithRetry(5);
        const startedAt = Date.now();
        chatAccounts.set(chatId, { ...acc, startedAt });

        await msg.reply(`Correo ${acc.address}`);
        startWatcher(chatId, acc.token, startedAt);

        const record = { when: Date.now(), expiresAt: startedAt + 5 * 60 * 1000, ...acc };
        fs.appendFileSync('mailtm_accounts.jsonl', JSON.stringify(record) + '\n', 'utf8');
      } catch (e) {
        console.error('❌ Error creando Mail.tm:', e?.response?.data || e.message);
        await msg.reply('Error al crear correo');
      } finally {
        creating.delete(chatId);
      }
      return;
    }

  } catch (e) {
    console.log("⚠️ handleChatMessage error:", e.message);
  }
}

// ======================= Monitores Ultra/Reboot =======================
console.log("⚡ Lanzando Puppeteer/Chrome...");
startBootTimeoutTimer();     // ← arranca el watchdog de 180s
client.initialize();
setInterval(tick, SETTINGS.POLL_MS);

let wasRunningUltra = false;
let notifyingUltra = false;
let rebootInProgress = false;

// Monitor Ultra
setInterval(() => {
  const base = path.basename(AHK_SCRIPT).replace(/'/g, "''");
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command `
    + `"$bn='${base}'; `
    + `$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'AutoHotkey*' -and $_.CommandLine -like ('*' + $bn + '*') }; `
    + `if($procs){exit 0}else{exit 1}"`;
  exec(cmd, { windowsHide: true }, async (err) => {
    if (!err) { wasRunningUltra = true; }
    else {
      if (wasRunningUltra && !notifyingUltra) {
        if (rebootInProgress) { wasRunningUltra = false; return; }
        wasRunningUltra = false;
        notifyingUltra = true;
        try {
          let chat = null;
          if (lastKnownChatId) { try { chat = await client.getChatById(lastKnownChatId); } catch {} }
          if (!chat) { const chats = await client.getChats(); if (chats && chats.length) chat = chats[0]; }
          if (!chat) { notifyingUltra = false; return; }

          await chat.sendMessage("⏳ UltraBot finalizado. Obteniendo *Status*...");
          await sendStatusSelf(chat, "📊 *Status Actual de Ultra* ✅");
        } catch (e) {
          console.error("❌ Error notificando Status tras cierre de UltraBot:", e.message);
        } finally { notifyingUltra = false; }
      }
    }
  });
}, 5000);

// Monitor Reboot
let wasRunningReboot = false;
let notifyingReboot = false;
setInterval(() => {
  const base = path.basename(REBOOT_SCRIPT).replace(/'/g, "''");
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command `
    + `"$bn='${base}'; `
    + `$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'AutoHotkey*' -and $_.CommandLine -like ('*' + $bn + '*') }; `
    + `if($procs){exit 0}else{exit 1}"`;
  exec(cmd, { windowsHide: true }, async (err) => {
    if (!err) { wasRunningReboot = true; }
    else {
      if (wasRunningReboot && !notifyingReboot) {
        wasRunningReboot = false;
        notifyingReboot = true;
        try {
          let chat = null;
          if (lastKnownChatId) { try { chat = await client.getChatById(lastKnownChatId); } catch {} }
          if (!chat) { const chats = await client.getChats(); if (chats && chats.length) chat = chats[0]; }
          if (!chat) { notifyingReboot = false; return; }

          await chat.sendMessage("⏳ Reboot finalizado. Obteniendo *Status*...");
          await sendStatusSelf(chat, "📊 *Status tras Reboot* ✅");
        } catch (e) {
          console.error("❌ Error notificando Status tras cierre de reboot:", e.message);
        } finally {
          rebootInProgress = false;
          notifyingReboot = false;
        }
      }
    }
  });
}, 5000);

// ======================= Planificador: Reinicio total + Auto-mantenimiento =======================
// Por defecto 2 horas, ajustable por chat (auto reinicio 2h / 90m / on / off)
let autoReinicioStarted = false;
let autoReinicioEnabled = true;
let autoReinicioIntervalMs = 1 * 60 * 60 * 1000; // 1 horas por defecto
let nextAutoReinicioAt = null;   // ⏰ almacena la fecha/hora del próximo reinicio

async function startAutoReinicioLoop() {
  while (true) {
    if (!autoReinicioEnabled) { await sleep(30000); continue; }

    // Aviso 1 minuto antes
    const waitBefore = Math.max(0, autoReinicioIntervalMs - 60 * 1000);
  // Guardar próxima hora de reinicio
  nextAutoReinicioAt = Date.now() + autoReinicioIntervalMs;
    await sleep(waitBefore);
    try {
      const chat = await resolveAlertChat();
      if (chat) await chat.sendMessage("⏰ En *1 minuto* iniciaré *Reinicio total* automáticamente.");
    } catch (e) { console.error("autoReinicio (aviso-1m):", e?.message || e); }

    // Espera 1 min y ejecuta
    await sleep(60 * 1000);
    try {
      const chat = await resolveAlertChat();
      if (chat) await chat.sendMessage("🔄 Comenzando *Reinicio total* (tiempo aproximado ~ 10 minutos)...");
      await runAhkAndWait(REINICIO_TOTAL_SCRIPT); // espera estricta
      const chat2 = await resolveAlertChat();
      if (chat2) {
        await chat2.sendMessage("✅ *Reinicio total* finalizado. Enviando captura del portapapeles…");
        await sendClipboardImage(chat2, "🖼️ *Resultado Reinicio total (auto)*");
        await chat2.sendMessage("📨 *Reinicio total (auto)* — captura enviada.\n🧹 Realizando auto-mantenimiento…");
        await performSelfMaintenance('auto-reinicio-total');
        await chat2.sendMessage("✅ Auto-mantenimiento completado.");
      }
    } catch (e) {
      console.error("autoReinicio (ejecución):", e?.message || e);
      try {
        const chat = await resolveAlertChat();
        if (chat) await chat.sendMessage("❌ Error durante el *Reinicio total (auto)*.");
      } catch {}
    }

    // siguiente ciclo según el valor actual (si lo cambiaste, se usará el nuevo en el próximo loop)
  }
}

process.on('SIGINT', async () => { console.log('\n👋 Saliendo…'); process.exit(0); });
