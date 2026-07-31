# MuseSGen2 (library)

Library JavaScript untuk terhubung ke headset **Muse S Gen 2** lewat Web
Bluetooth. Menangani semua bagian rumit — koneksi GATT, decode paket EEG
mentah, FFT, dan hitung band power (Delta/Theta/Alpha/Beta/Gamma) — supaya
web yang memakainya cukup subscribe event, tidak perlu tahu detail
protokol Bluetooth-nya. Dipakai oleh web utama di `../index.html` +
`../script.js`.

## Cara pakai

```html
<script src="musesgen2/script.js"></script>
<script>
  const muse = new MuseSGen2();

  muse.onStatusChange((text, state) => console.log(state, text));
  // state: 'connecting' | 'connected' | 'disconnected' | 'error'

  muse.onBattery(pct => console.log('battery', pct)); // 0-100

  muse.onBandPower(powers => console.log(powers));
  // powers = { delta, theta, alpha, beta, gamma } — daya (uV^2) per band

  muse.onReset(() => console.log('sudah disconnect, reset tampilan'));

  document.getElementById('btn').onclick = () => {
    muse.isConnected ? muse.disconnect() : muse.connect();
  };
</script>
```

`MuseSGen2.BANDS` — array 5 band `{ key, label, rangeLabel, color, range }`,
berguna untuk bikin kartu/legenda otomatis tanpa hardcode 5x.

`MuseSGen2.formatPower(v)` — helper format angka band power jadi string
yang enak dibaca.

Untuk dipakai dari repo/project lain, ganti path lokal dengan URL jsdelivr
setelah repo ini di-push ke GitHub:

```html
<script src="https://cdn.jsdelivr.net/gh/enuma-technology/musesgen2@main/script.js"></script>
```

## Kenapa ditulis manual, bukan pakai library dari npm/CDN?

- **Koneksi Bluetooth**: ditulis manual lewat Web Bluetooth GATT
  (service/characteristic UUID asli Muse), **bukan** lewat library MuseJS.
  MuseJS versi CDN sempat dicoba tapi tidak bisa decode paket Muse S Gen 2
  (Athena) dengan benar (EEG kosong, battery selalu '-'), jadi protokolnya
  dibicarakan langsung ke headset.
- **FFT / band power**: dihitung manual (radix-2 FFT + Hann window). Tidak
  ada library FFT yang punya build browser siap pakai lewat `<script>` tag
  polos tanpa bundler (mis. `fft.js` di npm cuma format CommonJS), jadi
  bagian ini tetap kode sendiri — ukurannya kecil dan sudah teruji.

Grafik-nya sendiri **tidak** ditulis manual — web utama (`../script.js`)
memakai [Chart.js](https://www.chartjs.org/) untuk itu.

---

Dikembangkan oleh **[Enuma Technology](https://enumatechnology.com)**
([GitHub](https://github.com/enuma-technology)).
