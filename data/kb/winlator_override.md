# Panduan Teknis Mutlak: Konfigurasi "Wine Library Override" (Winecfg) untuk Ekosistem Winlator & GameHub

Di tengah siklus resolusi pengujian utilitas pemetaan data (*Compatibility Layer Verification Suite*), problem fatal yang paling mendominasi kegagalan diagnosis subsistem virtual sandbox (seperti arsitektur emulasi **Winlator** atau **GameHub**) berpusat pada kekeliruan pemuatan **lapisan pemetaan pustaka (virtual path DLL mapping)**.

Subsistem kontainer sering mengalami *mishandling* saat me-resolve *dependencies API*, di mana ia menolak menyuntikkan _emulator library_ tiruan eksternal *(misalnya Goldberg Emulator)* yang bertempat bersebelahan dengan _Executable_ (*EXE*), dan sebaliknya terus memaksakan diri memuat file _Dynamic Link Library_ (_Builtin_) asli bawaan inti kernel Wine. Akibatnya, instrumen *sandbox* gagal menginisialisasi pembacaan memori direktori `steam_settings` dan berujung menabrak perbatasan pembatasan I/O virtual yang diblokir oleh Android (seperti rute *Documents/Virtual Registry* di dalam ranah privasi `drive_c`).

Sebagai intervensi resolusi agar lapisan emulasi termuat sempurna, administrator **wajib** mengubah perilaku primitif ini dengan melakukan pemaksaan "Wine Library Override".

## Langkah Eksplisit Restorasi Prioritas Modul API (Winecfg)

1. **Inisialisasi Lingkungan Emulasi (Container Desktop Boot)**
   Picukan operasi kontainer emulasi pada aplikasi Winlator atau GameHub Anda. Pastikan sesi telah memuat subsistem lingkungan dekstop grafis virtual secara penuh tanpa terdistraksi layar _loading_.
   
2. **Eksekusi Konfigurator Subsistem Utama (*Winecfg*)**
   - Lakukan ketukan _tap_ pada bilah manu navigasi inti yang terletak di pojok kiri bawah desktop virtual (**Start Menu**).
   - Bentangkan percabangan direktori hingga menyentuh panel sub-menu **System Tools**.
   - Klik modul program yang merujuk pada label utilitas **Wine Configuration**.

3. **Injeksi Parameter Entitas Penimpa Modul (*Library Overrides*)**
   - Jendela _Winecfg_ akan diinisiasi. Beralih dan ketuk tepat pada tabulat fungsi navigasi yang bernama **Libraries**.
   - Letakkan fokus _input keyboard_ pada boks panel teks yang berdeskripsi: *"New override for library"*.
   - Input secara akurat nama pustaka arsitektur 32-bit berikut:
     `steam_api`
   - Ketuk secara presisi tombol perintah **Add**.
   - Modul tersebut kini tergabung di kotak penampung. Berikan pendelegasian injeksi yang persis identik untuk subsistem modul API arsitektur 64-bit:
     `steam_api64`
   - Konfirmasikan dengan menekan tombol perintah **Add** sekali lagi.

4. **Operasi Modifikasi Hierarki Radikal (Native then Builtin)**
   - Perhatikan dengan saksama daftar entitas yang berada di dalam boks luasan tabel bersistem panel *scroll* dengan tajuk *"Existing overrides"*. 
   - Seleksilah instrumen parameter `steam_api` agar ditandai (highlight biru).
   - Eksekusi ketukan untuk masuk ke tombol kontrol **Edit...**.
   - Jendela kecil opsi akan menyembul. Pilih dan setel konfigurasinya menjadi mode instruksi mutlak pada opsi: **Native then Builtin**.
   - Kunci panel opsi dengan menekan **OK**. 
   - **PERHATIAN KRUSIAL**: Lakukan siklus langkah identik *(Edit -> Native then Builtin -> OK)* pada seleksi parameter entitas pendampingnya yaitu `steam_api64`.

5. **Penguncian Otoritas Injeksi *Virtual Registry***
   Selesaikan seluruh ritme pengaturan ini dengan menekan tombol **Apply** pada sisi bawah jendela _Winecfg_, diikuti ketukan penutup tombol konfirmasi **OK** untuk meruntuhkan tampilan antarmuka GUI dan menyegel perubahan operasi _I/O mapping_.

### Analisis Stabilitas Lingkungan Virtual
Pasca pemberlakuan mekanisme *Registry Apply* pada rutinitas modul *winecfg* tersebut, rutinitas _Translation Layer_ emulator mutlak diikat rantai untuk mengubah arsitektur _dependency tree_-nya. Arsitektur OS Android-Wine diamanatkan untuk segera meraup pemetaan pustaka aset DLL lokal *(Native)* dan berhenti tersesat mengaktifkan fungsi bawaan tertutup *(Builtin)*. Kebuntuan akses jalur resolusi I/O ke penyimpanan memori perantara (termasuk kelumpuhan akses pembacaan aset ke *public documents*) dipastikan lenyap dan pulih seutuhnya.
