/* MuseSGen2 — library koneksi ke headset Muse S Gen 2 lewat Web Bluetooth
   =========================================================================
   Library ini menangani semua bagian rumit: koneksi GATT ke headset,
   decode paket EEG mentah, FFT, dan hitung band power (Delta/Theta/Alpha/
   Beta/Gamma). Web yang memakainya cukup subscribe event dan panggil
   connect()/disconnect() — tidak perlu tahu detail protokol Bluetooth-nya.

   Cara pakai (lihat contoh lengkap di ../index.html + ../script.js):

     <script src="musesgen2/script.js"></script>
     <script>
       const muse = new MuseSGen2();
       muse.onStatusChange((text, state) => console.log(state, text));
       muse.onBattery(pct => console.log('battery', pct));
       muse.onBandPower(powers => console.log(powers)); // {delta, theta, alpha, beta, gamma}
       muse.onReset(() => console.log('disconnected, reset tampilan'));
       document.getElementById('btn').onclick = () => muse.connect();
     </script>

   MuseSGen2.BANDS berisi daftar band (key, label, rangeLabel, color) kalau
   mau bikin kartu/legenda otomatis tanpa hardcode 5x di HTML.

   Kenapa ditulis manual (bukan pakai library MuseJS atau library FFT dari
   npm)? Lihat README.md di folder ini. */

(function () {
  'use strict';

  var MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb';
  var MUSE_CHAR = {
    control: '273e0001-4c4d-454d-96be-f03bac821358',
    tp9:     '273e0003-4c4d-454d-96be-f03bac821358',
    af7:     '273e0004-4c4d-454d-96be-f03bac821358',
    af8:     '273e0005-4c4d-454d-96be-f03bac821358',
    tp10:    '273e0006-4c4d-454d-96be-f03bac821358',
    battery: '273e000b-4c4d-454d-96be-f03bac821358'
  };

  // Standard BLE Battery Service (0x180F / 0x2A19) — kalau tersedia, ini persentase
  // paling akurat (sama seperti app Muse resmi). Kalau tidak ada, fallback ke reply
  // status control-channel ("bp"), lalu ke telemetry proprietary (273e000b).
  var BATTERY_SERVICE = 0x180f;
  var BATTERY_LEVEL_CHAR = 0x2a19;

  var PRESET_GEN2 = 'p1035';     // Muse S Gen 2 (Athena): EEG + PPG + IMU
  var ADC_MIDPOINT = 2048;       // pusat 12-bit unsigned (0..4095)
  var UV_PER_UNIT = 0.48828125;  // 1 unit ADC -> microvolt
  var SAMPLES_PER_PACKET = 12;

  var MUSE_SAMPLE_RATE = 256;    // Hz
  var FFT_SIZE = 256;            // ~1 detik per window analisis

  var BANDS = [
    { key: 'delta', label: 'Delta', rangeLabel: '0.5-4Hz',  color: '#3b82f6', range: [0.5, 4] },
    { key: 'theta', label: 'Theta', rangeLabel: '4-8Hz',    color: '#8b5cf6', range: [4, 8] },
    { key: 'alpha', label: 'Alpha', rangeLabel: '8-13Hz',   color: '#10b981', range: [8, 13] },
    { key: 'beta',  label: 'Beta',  rangeLabel: '13-30Hz',  color: '#f59e0b', range: [13, 30] },
    { key: 'gamma', label: 'Gamma', rangeLabel: '30-100Hz', color: '#ef4444', range: [30, 100] }
  ];

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ── FFT & band power (tidak ada library FFT browser-ready lewat <script>
     tag polos tanpa bundler, jadi ditulis manual — lihat README) ────────── */

  function fft(re, im, N) {
    var j = 0;
    for (var i = 1; i < N; i++) {
      var bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= N; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (var start = 0; start < N; start += len) {
        var curRe = 1, curIm = 0;
        for (var k = 0; k < len / 2; k++) {
          var uRe = re[start + k], uIm = im[start + k];
          var vRe = re[start + k + len / 2] * curRe - im[start + k + len / 2] * curIm;
          var vIm = re[start + k + len / 2] * curIm + im[start + k + len / 2] * curRe;
          re[start + k]           = uRe + vRe;
          im[start + k]           = uIm + vIm;
          re[start + k + len / 2] = uRe - vRe;
          im[start + k + len / 2] = uIm - vIm;
          var tmp = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = tmp;
        }
      }
    }
  }

  // Hann-window PSD lalu integrasi per pita -> daya absolut (uV^2) per band
  function bandPowers(samples) {
    var N = samples.length;
    var mean = samples.reduce(function (a, s) { return a + s; }, 0) / N;
    var re = new Float64Array(N);
    var im = new Float64Array(N);
    var U = 0;
    for (var n = 0; n < N; n++) {
      var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1));
      re[n] = (samples[n] - mean) * w;
      U += w * w;
    }
    fft(re, im, N);

    var freqRes = MUSE_SAMPLE_RATE / N;
    var half = N >> 1;
    var norm = 2 / (MUSE_SAMPLE_RATE * U);
    var psd = new Float64Array(half);
    for (var k = 1; k < half; k++) {
      psd[k] = (re[k] * re[k] + im[k] * im[k]) * norm;
    }

    var powers = {};
    BANDS.forEach(function (b) {
      var lo = b.range[0], hi = b.range[1];
      var p = 0;
      for (var kk = Math.ceil(lo / freqRes); kk <= Math.floor(hi / freqRes) && kk < half; kk++) {
        p += psd[kk] * freqRes;
      }
      powers[b.key] = p;
    });
    return powers;
  }

  function meanPowers(a, b) {
    var out = {};
    BANDS.forEach(function (bd) {
      out[bd.key] = ((a[bd.key] || 0) + (b[bd.key] || 0)) / 2;
    });
    return out;
  }

  function fmtBandPower(v) {
    if (v == null || !isFinite(v)) return '-';
    if (v >= 100) return String(Math.round(v));
    if (v >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  /* ── Class MuseSGen2 ──────────────────────────────────────────────────── */

  function MuseSGen2() {
    this.isConnected = false;

    this._listeners = { status: [], battery: [], bandpower: [], reset: [] };

    this._buffers = { tp9: [], af7: [], af8: [], tp10: [] };
    this._eegPacketCount = 0;

    this._device = null;
    this._server = null;
    this._service = null;
    this._controlChar = null;
    this._stdBatteryChar = null;
    this._stdBatteryAvailable = false;
    this._ctrlBatteryReceived = false;
    this._ctrlBuf = '';
    this._battPollTimer = null;
  }

  MuseSGen2.BANDS = BANDS;
  MuseSGen2.formatPower = fmtBandPower;

  MuseSGen2.prototype.onStatusChange = function (fn) { this._listeners.status.push(fn); return this; };
  MuseSGen2.prototype.onBattery = function (fn) { this._listeners.battery.push(fn); return this; };
  MuseSGen2.prototype.onBandPower = function (fn) { this._listeners.bandpower.push(fn); return this; };
  MuseSGen2.prototype.onReset = function (fn) { this._listeners.reset.push(fn); return this; };

  MuseSGen2.prototype._emit = function (kind) {
    var args = Array.prototype.slice.call(arguments, 1);
    this._listeners[kind].forEach(function (fn) { fn.apply(null, args); });
  };

  // Perintah ke Muse dikirim sebagai [panjang][teks perintah + '\n'] lewat control characteristic
  MuseSGen2.prototype._sendCommand = async function (cmd) {
    if (!this._controlChar) return;
    var encoded = new TextEncoder().encode(cmd + '\n');
    var packet = new Uint8Array(encoded.length + 1);
    packet[0] = encoded.length;
    packet.set(encoded, 1);
    await this._controlChar.writeValue(packet);
  };

  // Reply JSON dari perintah 's' (status) membawa field "bp" = persentase baterai langsung
  MuseSGen2.prototype._onControlReply = function (dataView) {
    try {
      var len = dataView.getUint8(0);
      var s = '';
      for (var i = 1; i <= len && i < dataView.byteLength; i++) {
        s += String.fromCharCode(dataView.getUint8(i));
      }
      this._ctrlBuf += s;
      if (this._ctrlBuf.indexOf('}') !== -1) {
        if (!this._stdBatteryAvailable) {
          var m = this._ctrlBuf.match(/"bp"\s*:\s*([\d.]+)/);
          if (m) {
            var pct = Math.max(0, Math.min(100, parseFloat(m[1])));
            if (isFinite(pct)) {
              this._ctrlBatteryReceived = true;
              this._emit('battery', pct);
            }
          }
        }
        this._ctrlBuf = '';
      }
    } catch (e) { /* abaikan reply yang tidak lengkap */ }
  };

  // Fallback battery telemetry proprietary: offset 2 = raw uint16, raw/512 = persen
  MuseSGen2.prototype._applyPropBattery = function (dv) {
    if (!dv || dv.byteLength < 6) return;
    var raw = dv.getUint16(2, false);
    var pct = raw / 512;
    if (!isFinite(pct) || pct < 0) return;
    this._emit('battery', Math.max(0, Math.min(100, pct)));
  };

  // Paket EEG 20-byte: [0-1] index sample, [2-19] 12 sample x 12-bit unsigned (big-endian)
  MuseSGen2.prototype._onEEGPacket = function (key, dataView) {
    var buf = this._buffers[key];
    var fits = Math.max(0, Math.floor(((dataView.byteLength - 2) * 8) / 12));
    var count = Math.min(SAMPLES_PER_PACKET, fits);

    for (var i = 0; i < count; i++) {
      var bitIndex = i * 12;
      var byteOffset = 2 + (bitIndex >> 3);
      var bitOffset = bitIndex & 7;
      var word = (dataView.getUint8(byteOffset) << 8) | dataView.getUint8(byteOffset + 1);
      var raw12 = (word >> (4 - bitOffset)) & 0x0fff;
      var uv = (raw12 - ADC_MIDPOINT) * UV_PER_UNIT;
      buf.push(uv);
    }
    if (buf.length > FFT_SIZE * 2) buf.splice(0, buf.length - FFT_SIZE * 2);

    // Hitung band power dari channel frontal AF7 (+AF8 kalau ada), tiap ~200ms
    if (key === 'af7' && buf.length >= FFT_SIZE) {
      this._eegPacketCount++;
      if (this._eegPacketCount % 8 === 0) {
        var pAF7 = bandPowers(buf.slice(-FFT_SIZE));
        var af8Buf = this._buffers.af8;
        var combined = pAF7;
        if (af8Buf.length >= FFT_SIZE) {
          combined = meanPowers(pAF7, bandPowers(af8Buf.slice(-FFT_SIZE)));
        }
        this._emit('bandpower', combined);
      }
    }
  };

  // Baterai kadang jarang di-notify, jadi di-poll berkala supaya angkanya tidak beku
  MuseSGen2.prototype._pollBattery = async function () {
    try {
      if (!this.isConnected || !this._device || !this._device.gatt || !this._device.gatt.connected) return;
      if (this._stdBatteryAvailable && this._stdBatteryChar) {
        var dv = await this._stdBatteryChar.readValue();
        if (dv && dv.byteLength >= 1) this._emit('battery', dv.getUint8(0));
      } else {
        try { await this._sendCommand('s'); } catch (e) { /* abaikan */ }
      }
    } catch (e) { /* koneksi mungkin sedang putus */ }
  };

  MuseSGen2.prototype.connect = async function () {
    if (!navigator.bluetooth) {
      this._emit('status', 'Browser ini tidak mendukung Web Bluetooth. Gunakan Chrome atau Edge.', 'error');
      return;
    }

    this._emit('status', 'menghubungkan...', 'connecting');

    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'Muse' },
          { services: [MUSE_SERVICE] }
        ],
        optionalServices: [MUSE_SERVICE, BATTERY_SERVICE]
      });
      this._device.addEventListener('gattserverdisconnected', () => this._handleDisconnected());

      this._server = await this._device.gatt.connect();
      this._service = await this._server.getPrimaryService(MUSE_SERVICE);

      // Control characteristic dulu — Muse S Gen 2 (Athena) perlu di-halt sebelum ganti preset
      this._controlChar = await this._service.getCharacteristic(MUSE_CHAR.control);
      try {
        await this._controlChar.startNotifications();
        this._controlChar.addEventListener('characteristicvaluechanged', (e) => this._onControlReply(e.target.value));
      } catch (e) { /* notify control opsional */ }

      await this._sendCommand('h');   // halt streaming lama sebelum mulai yang baru
      await delay(200);

      // Subscribe ke 4 channel EEG mentah (dipakai sebagai input FFT band power)
      for (const key of ['tp9', 'af7', 'af8', 'tp10']) {
        const char = await this._service.getCharacteristic(MUSE_CHAR[key]);
        await char.startNotifications();
        char.addEventListener('characteristicvaluechanged', (e) => this._onEEGPacket(key, e.target.value));
      }

      // Baterai: coba BLE Battery Service standar dulu (paling akurat)
      this._stdBatteryAvailable = false;
      try {
        var battSvc = await this._server.getPrimaryService(BATTERY_SERVICE);
        this._stdBatteryChar = await battSvc.getCharacteristic(BATTERY_LEVEL_CHAR);
        var dv0 = await this._stdBatteryChar.readValue();
        if (dv0 && dv0.byteLength >= 1) this._emit('battery', dv0.getUint8(0));
        this._stdBatteryAvailable = true;
        try {
          await this._stdBatteryChar.startNotifications();
          this._stdBatteryChar.addEventListener('characteristicvaluechanged', (e) => {
            if (e.target.value && e.target.value.byteLength >= 1) this._emit('battery', e.target.value.getUint8(0));
          });
        } catch (e) { /* read-only juga tidak apa */ }
      } catch (e) {
        // Battery Service standar tidak ada -> nanti pakai reply "bp" atau telemetry proprietary
      }

      // Fallback: telemetry proprietary (dipakai hanya kalau dua sumber lain belum ada)
      try {
        var battChar = await this._service.getCharacteristic(MUSE_CHAR.battery);
        await battChar.startNotifications();
        battChar.addEventListener('characteristicvaluechanged', (e) => {
          if (!this._stdBatteryAvailable && !this._ctrlBatteryReceived) this._applyPropBattery(e.target.value);
        });
      } catch (e) { /* battery char tidak selalu ada */ }

      // Mulai streaming dengan preset Muse S Gen 2, lalu minta status (battery) dan mulai data
      await this._sendCommand(PRESET_GEN2);
      await this._sendCommand('s');
      await this._sendCommand('d');

      if (this._battPollTimer) clearInterval(this._battPollTimer);
      this._battPollTimer = setInterval(() => this._pollBattery(), 30000);

      this.isConnected = true;
      this._emit('status', 'terhubung (' + (this._device.name || 'Muse') + ')', 'connected');
    } catch (err) {
      var msg = (err && err.name === 'NotFoundError')
        ? 'tidak ada perangkat Muse yang dipilih'
        : 'gagal terhubung (coba lagi)';
      this._emit('status', msg, 'disconnected');
    }
  };

  MuseSGen2.prototype.disconnect = async function () {
    try { await this._sendCommand('h'); } catch (e) { /* abaikan */ }
    if (this._device && this._device.gatt && this._device.gatt.connected) this._device.gatt.disconnect();
  };

  // Kalau headset diputus (misal dimatikan atau di luar jangkauan), balikin status
  MuseSGen2.prototype._handleDisconnected = function () {
    this.isConnected = false;
    if (this._battPollTimer) { clearInterval(this._battPollTimer); this._battPollTimer = null; }
    this._controlChar = null;
    this._stdBatteryChar = null;
    this._stdBatteryAvailable = false;
    this._ctrlBatteryReceived = false;
    this._ctrlBuf = '';
    this._eegPacketCount = 0;
    this._buffers = { tp9: [], af7: [], af8: [], tp10: [] };

    this._emit('reset');
    this._emit('status', 'terputus', 'disconnected');
  };

  window.MuseSGen2 = MuseSGen2;
})();
