# SurpToken-ID

# Menjalankan Script

Jalankan dari folder utama. Pilih perintah dengan akhiran jaringan yang sama untuk seluruh deployment. Isi `.env` dan constants jaringan sebelum menjalankan.

## Persiapan

```bash
npm ci
npm run compile
```

## SurpSwap V3 Core dan Periphery

Source V3 bermerek berada di proyek Hardhat terpisah agar compiler, dependency, dan konfigurasi deploy-nya tidak mengganggu kontrak utama. Periphery menggunakan `v3-core` lokal melalui dependency `file:../v3-core`.

Jalankan instalasi, compile, dan test dari masing-masing folder:

```bash
cd v3-core
npm ci
npm run compile
npm test

cd ../v3-periphery
npm ci
npm run compile
npm test
```

Isi konfigurasi jaringan pada `.env` lokal masing-masing folder sebelum deploy. Setelah core dan periphery dideploy, isi `SURPSWAP_V3_FACTORY_<NETWORK>`, `SURPSIDY_SWAP_ROUTER_<NETWORK>`, `SURPSIDY_POSITION_MANAGER_<NETWORK>`, `SURPSIDY_QUOTER_<NETWORK>`, dan `SURPSIDY_QUOTER_V2_<NETWORK>` di `config/networks/<network>.cjs` dengan alamat dari deployment SurpSwap yang sama. Isi pool yang dipakai aplikasi dengan pool dari factory tersebut. Script deployment dan konfigurasi memeriksa bahwa router, position manager, quoter, dan pool tersambung ke factory SurpSwap yang dikonfigurasi.

Kontrak bisnis seperti SurpSidy, SurpZeroSubsidizer, LPManager, InvestorSale, PublicStaking, dan NFT memakai interface SurpSwap V3. Perubahan ini tidak mengubah kontrak helper Polygon; helper dual-DEX tetap punya konfigurasi Uniswap/QuickSwap tersendiri.

## Urutan deploy

### Core baru (lewati jika memakai core yang sudah ada)

```bash
npm run deploy:core:amoy
npm run deploy:core:polygon
```

### SurpSidy

```bash
npm run deploy:surpsidy:amoy
npm run deploy:surpsidy:polygon
```

### InvestorSale dan Shop

Isi lima `INVESTMENT_LEVEL_*_POL_<NETWORK>` dan pilih satu: `SRP_PRICE_POL_<NETWORK>` atau `SRP_WETH9_POOL_<NETWORK>`.

```bash
npm run deploy:investor:amoy
npm run deploy:investor:polygon
```

### Pastikan koneksi LPManager

Jalankan setelah SurpSidy dan InvestorSale terdeploy.

```bash
npm run configure:lp-manager:amoy
npm run configure:lp-manager:polygon
```

### Payout SRP otomatis setelah pembayaran PayPal

Isi tiga nilai berikut di `config/networks/amoy.cjs` atau `config/networks/polygon.cjs`. Batas memakai unit terkecil SRP (18 desimal); contoh 1 SRP ditulis `1000000000000000000`.

```js
LP_MANAGER_PAYPAL_RELAYER_<NETWORK>: 'alamat-wallet-backend',
LP_MANAGER_PAYPAL_MAX_PER_TX_<NETWORK>: 'batas-per-transaksi',
LP_MANAGER_PAYPAL_DAILY_LIMIT_<NETWORK>: 'batas-harian',
```

Jika ketiganya diisi saat `npm run deploy:core:<network>`, konfigurasi diterapkan pada LPManager baru sebelum deploy selesai. Jika LPManager sudah terdeploy atau pengaturannya ingin dilakukan kemudian, jalankan `npm run configure:lp-manager:<network>` setelah mengisi nilai. Script mengirim transaksi bila signer adalah owner; jika owner-nya Safe, script mencetak calldata untuk diusulkan melalui Safe. Biarkan ketiganya kosong untuk tidak mengaktifkan payout. Untuk menonaktifkan payout melalui script konfigurasi, isi alamat relayer dengan zero address dan kedua batas dengan `0`.

`LPManager` mendukung relayer payout yang dikonfigurasi owner (misalnya Safe). Owner memanggil:

```solidity
setPayPalPayoutConfig(relayer, maxPerTransaction, dailyLimit)
```

Setelah pembayaran PayPal benar-benar terkonfirmasi, backend memanggil:

```solidity
releaseForPayPal(paymentId, walletPembeli, jumlahSRP)
```

`paymentId` harus unik untuk setiap transaksi PayPal dan berupa `bytes32`; kontrak menolak ID yang sudah pernah dipakai. `maxPerTransaction` dan `dailyLimit` memakai unit terkecil SRP (18 desimal). Batas harian dihitung per hari berdasarkan timestamp blockchain. Set `setPayPalPayoutConfig(address(0), 0, 0)` untuk menonaktifkan payout. Jika owner LPManager adalah Safe, konfigurasi relayer dilakukan sebagai transaksi Safe; relayer backend tidak perlu menjadi owner.

Relayer dapat memilih wallet tujuan dan jumlah dalam batas yang disetujui, jadi kunci relayer tetap harus dijaga. Kontrak tidak memverifikasi pembayaran PayPal atau status refund; backend wajib memvalidasi webhook/pembayaran dan mencegah payout sebelum pembayaran final. Payout menggunakan saldo SRP LPManager yang sama dengan subsidi dan InvestorSale sehingga dapat mengurangi saldo yang tersedia untuk keduanya. Pertimbangkan pendanaan dan batas harian dengan hati-hati.

Perubahan source ini tidak memperbarui LPManager yang sudah terdeploy (kontrak bukan proxy). Jangan sekadar deploy manager baru tanpa merencanakan perpindahan saldo serta perubahan koneksi SurpSidy dan InvestorSale; alamat manager baru perlu dikonfigurasi dan divalidasi untuk seluruh alur terkait.

### Add LP oleh relayer LPManager

Script add-LP memverifikasi wallet signer adalah relayer yang terdaftar di LPManager, lalu wallet relayer langsung memanggil SurpSwap V3 Position Manager dengan SRP dan token pasangan dari saldonya sendiri. NFT posisi LP dikirim ke owner/Safe LPManager. Isi `LP_MANAGER_ADD_LIQ_POSITION_MANAGER_<NETWORK>` dan `LP_MANAGER_ADD_LIQ_PAIR_TOKEN_<NETWORK>`, lalu jalankan `npm run configure:lp-manager:<network>` sebagai owner atau ajukan calldata yang dicetak melalui Safe. Kedua token harus ada di wallet relayer, dan pool harus sudah dibuat serta diinisialisasi pada SurpSwap. Script ini tidak memanggil fungsi `addLiquidityForRelayer` pada kontrak LPManager.

Pilih jumlah melalui konfigurasi profil `ADD_LIQ_*`, pastikan `ADD_LIQ_TOKEN_A_*` adalah SRP, dan `ADD_LIQ_TOKEN_B_*` sama dengan token pasangan yang dikonfigurasi pada LPManager. Wallet relayer harus memiliki SRP dan POL untuk gas. Jika token pasangan adalah WETH9 proyek (WSRP) dan saldo WSRP kurang, script otomatis membungkus kekurangan dari saldo POL relayer. Untuk token pasangan lain, token harus sudah tersedia di wallet relayer. Script memberi approval terbatas langsung ke SurpSwap V3 Position Manager jika allowance belum cukup. Untuk menjalankan:

```bash
npm run add-lp:relayer:amoy
npm run add-lp:relayer:polygon
npm run add-lp:relayer:wpol:1:amoy
npm run add-lp:relayer:wpol:1:polygon
```

Perintah `add-lp:relayer:<network>` memakai fee 0,3%; akhiran `add-lp:relayer:wpol:1:<network>` memakai fee 1%. Setelah add-LP berhasil, script menyimpan alamat ke `ADD_LIQ_POOL_ADDRESS_<NETWORK>` dan, jika pasangan serta tier fee cocok dengan konfigurasi SurpSidy, ke field pool SurpSidy terkait. Script memakai `LP_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY` dari `.env` jika tersedia, lalu memakai `PRIVATE_KEY` sebagai fallback. Private key tersebut harus cocok dengan relayer LPManager yang dikonfigurasi on-chain. `ADD_LIQ_MIN_AMOUNT0/1` mengatur minimum berdasarkan urutan token pool; gunakan `AUTO` agar memakai `ADD_LIQ_SLIPPAGE_BPS`.

Add-LP tidak memakai saldo token LPManager dan tidak memakai cap payout PayPal per transaksi/harian. Relayer menyediakan SRP dan token pasangan; POL dapat dibungkus menjadi WSRP oleh script bila diperlukan. Token yang tidak terpakai tetap di wallet relayer, dan NFT posisi dikirim ke owner/Safe.

### Menghentikan event staking, dividen, dan mining NFT

Owner dapat menghentikan penerimaan staking/dividen baru dan start mining NFT melalui `pause()`, lalu membuka kembali dengan `unpause()`. Saat paused, posisi/event baru tidak bisa dimulai; claim reward yang sudah menjadi hak pengguna, penarikan principal, dan claim hasil mining yang sudah berjalan tetap berfungsi. Untuk `PublicStaking`, pause/unpause sudah tersedia; `InvestorDividend` dan seluruh koleksi NFT mewarisi kontrol yang sama dari kontrak terbaru. Menghentikan event tidak membatalkan reward atau hasil yang sudah diperoleh. Kontrak yang sudah terdeploy dan bukan proxy perlu dideploy ulang untuk mendapatkan perubahan baru.

### Payout PayPal dari P2EManager

P2EManager juga mendukung relayer payout PayPal secara terpisah dari LPManager. Isi `P2E_MANAGER_PAYPAL_RELAYER_<NETWORK>`, `P2E_MANAGER_PAYPAL_MAX_PER_TX_<NETWORK>`, dan `P2E_MANAGER_PAYPAL_DAILY_LIMIT_<NETWORK>` pada konfigurasi jaringan. Nilai batas menggunakan unit terkecil SRP. Konfigurasi diterapkan saat `deploy:core:<network>` jika relayer diisi; untuk manager yang sudah terdeploy, jalankan:

```bash
npm run configure:p2e-manager:amoy
npm run configure:p2e-manager:polygon
```

Owner (misalnya Safe) mengatur relayer dengan `setPayPalPayoutConfig(relayer, maxPerTransaction, dailyLimit)`. Setelah pembayaran terkonfirmasi, relayer memanggil `releaseForPayPal(paymentId, walletPembeli, jumlahSRP)`. ID pembayaran `bytes32` hanya dapat dipakai sekali dan batas transaksi serta batas harian berlaku lintas semua penerima. Gunakan zero address dan kedua batas `0` untuk menonaktifkan relayer. Jalur `payout(user, amount)` milik mining pool resmi tetap tersedia.

Payout ini memakai saldo vault P2E yang sama dengan reward staking dan dividen. Batas relayer tidak mengetahui atau melindungi saldo yang telah menjadi kewajiban reward; pastikan vault memiliki dana terpisah/lebih dari seluruh kewajiban sebelum mengaktifkannya. Kontrak juga tidak memverifikasi pembayaran PayPal atau refund, sehingga backend harus memastikan pembayaran final sebelum mengirim transaksi. Perubahan ini tidak memperbarui P2EManager yang sudah terdeploy; kontrak non-proxy harus dideploy ulang agar fitur tersedia.

### NFT dan koneksi InvestorSale/Shop/P2EManager

Isi enam `NFT_BASE_URI_<KOLEKSI>_<NETWORK>`.

```bash
npm run deploy:investor-nfts:amoy
npm run deploy:investor-nfts:polygon
```

### InvestorSale, Shop, dan NFT sekaligus

Alternatif untuk menjalankan seluruh deployment Investor dalam satu script. Jangan jalankan bersama langkah InvestorSale/NFT terpisah untuk deployment yang sama.
Deployment mengaktifkan InvestorSale dengan harga manual dari `SRP_PRICE_POL_<NETWORK>`. Konfigurasi pool DEX dilakukan terpisah setelah pool SRP/WETH9 siap TWAP.
Rewards tidak termasuk; jalankan `npm run deploy:rewards:amoy` hanya jika ingin memakai staking/dividen.

```bash
npm run deploy:investor:all:amoy
npm run deploy:investor:all:polygon
```

### Ganti harga InvestorSale ke pool DEX

Alamat pool SRP/WETH9 yang dibuat melalui script add-LP otomatis disimpan ke `SRP_WETH9_POOL_<NETWORK>`. Jalankan command setelah pool memiliki observasi TWAP minimal 30 menit. Command ini mematikan sementara InvestorSale saat mengubah sumber harga, lalu mengaktifkannya kembali jika sebelumnya aktif. Setelah DEX pricing diaktifkan, harga manual tidak lagi digunakan.

```bash
npm run configure:investor-pool:amoy
npm run configure:investor-pool:polygon
```

### Atur harga manual InvestorSale

Isi `SRP_PRICE_POL_<NETWORK>` di `config/networks/amoy.cjs` atau `config/networks/polygon.cjs`, dengan satuan POL per SRP, misalnya `0.00005`. InvestorSale harus nonaktif saat harga diubah. Jika DEX pricing sudah diaktifkan, harga manual terkunci dan tidak dapat diatur kembali.

```bash
npm run set-base-harga-investor-sale:amoy
npm run set-base-harga-investor-sale:polygon
```

Jalankan sebagai owner InvestorSale. Jika owner-nya Safe, script menampilkan calldata untuk diajukan melalui Safe; pastikan sale nonaktif sebelum eksekusi.

### Ubah nominal level InvestorSale di Polygon

Fungsi ini tersedia setelah InvestorSale versi terbaru dideploy. Isi `INVESTMENT_LEVEL_1_POL_POLYGON` sampai `INVESTMENT_LEVEL_5_POL_POLYGON`, lalu jalankan saat sale nonaktif:

```bash
npm run set-nominal-investor-sale:polygon
```

Nominal level memakai POL. Script hanya menargetkan Polygon mainnet, memeriksa chain dan alamat InvestorSale, serta menampilkan calldata jika owner-nya Safe. Kontrak InvestorSale yang sudah terdeploy tidak bisa mendapat fungsi baru karena bukan proxy; deploy ulang dan migrasikan konfigurasi/koneksi terkait sebelum menjalankannya.

### Atur pool harga keenam NFT investor

Setelah pool SRP/WETH9 siap TWAP minimal 30 menit, isi `SRP_WETH9_POOL_<NETWORK>` dan jalankan command ini untuk mengatur `tokenPoolAddress` serta `quoteToken` (WETH9) pada keenam NFT investor yang sudah terdeploy:

```bash
npm run configure:investor-nft-pools:amoy
npm run configure:investor-nft-pools:polygon
```

### Atur harga dan buka public mint NFT

Isi `NFT_PUBLIC_PRICE_<KOLEKSI>_<NETWORK>` pada `config/networks/amoy.cjs` atau `config/networks/polygon.cjs` untuk setiap koleksi. Nilai harga memakai satuan SRP, misalnya `25` berarti 25 SRP. Wallet `PRIVATE_KEY` harus menjadi owner keenam NFT.

```bash
npm run setup:nft-public-sale:amoy
npm run setup:nft-public-sale:polygon
```

Script mengatur `publicPrice` dan membuka public mint (`isPublicMintActive`) tanpa mengubah status mint voucher investor. Pembeli harus approve SRP ke kontrak NFT sebelum memanggil `publicMint`; maksimal 5 NFT per transaksi. Ini tidak mengatur listing jual-beli NFT yang sudah dimiliki ataupun status `InvestorSale`.

### Rewards

```bash
npm run deploy:rewards:amoy
npm run deploy:rewards:polygon
```

Alamat rewards disimpan ke `PUBLIC_STAKING_ADDRESS_<NETWORK>` dan `INVESTOR_DIVIDEND_ADDRESS_<NETWORK>`. Script deploy otomatis mendaftarkannya di P2EManager. Jalankan `register:reward-pools` hanya jika kontrak rewards sudah ada tetapi belum terdaftar:

```bash
npm run register:reward-pools:amoy
npm run register:reward-pools:polygon
```

### Safe dan ownership (terakhir)

```bash
npm run create:safe:amoy
npm run finalize:ownership:amoy
npm run accept:ownership:amoy

npm run create:safe:polygon
npm run finalize:ownership:polygon
npm run accept:ownership:polygon
```

Jika Safe tidak tersedia di UI jaringan yang digunakan, command `accept:ownership:<network>` mengeksekusi penerimaan semua ownership yang masih pending ke Safe untuk kontrak yang tercantum di atas, setelah minimal 3 owner Safe menandatangani. Masukkan private key tiga owner yang berbeda sebagai `SAFE_OWNER_1_PRIVATE_KEY` sampai `SAFE_OWNER_5_PRIVATE_KEY` di `.env` lokal, lalu jalankan command dan ketik `ACCEPT ALL OWNERSHIP` saat diminta. `PRIVATE_KEY` membayar gas eksekusi dan tidak dihitung sebagai tanda tangan kecuali juga dimasukkan sebagai salah satu `SAFE_OWNER_*_PRIVATE_KEY`. Jangan kirim atau commit private key; hapus kembali nilai sementara dari `.env` setelah transaksi selesai. Command `accept:lp-ownership:<network>` masih tersedia sebagai alias.

## Pool dan likuiditas

### Amoy

```bash
npm run add-lp:wpol:amoy
npm run add-lp:wpol:1:amoy
npm run configure:surpsidy-pools:amoy
```

### Polygon

### LP NFT lock

Deploy `LPNFTLocker` ke Amoy atau Polygon. Durasi awalnya 10 tahun (365 hari per tahun); owner bisa mengubah durasi dengan `setLockDuration(seconds)`. Perubahan hanya berlaku untuk lock baru, tidak mempersingkat lock yang sudah berjalan. Isi `LP_NFT_UNLOCK_SIGNER_<NETWORK>` dengan alamat wallet backend di config sebelum deploy; deploy script akan mengatur alamat itu sebagai `unlockSigner`. Private key signer tetap hanya di backend. Tanpa signer terkonfigurasi, locker menolak NFT baru. Pemilik NFT memberi approval ke locker lalu memanggil `lock(nftContract, tokenId)`. Setelah `unlockTime`, beneficiary memanggil `unlock(nftContract, tokenId, deadline, signature)` dengan signature EIP-712 backend atas `Unlock(nftContract, tokenId, beneficiary, nonce, deadline)`. Jadi unlock tetap perlu backend meski masa lock habis.

```bash
npm run deploy:lp-nft-locker:amoy
npm run deploy:lp-nft-locker:polygon
```

Untuk memakai Safe sebagai owner, isi `SAFE_ADDRESS_<NETWORK>`, lalu jalankan `finalize:ownership:<network>` dan `accept:ownership:<network>` setelah deployment. `LPNFTLocker` sudah termasuk dalam kedua alur ownership tersebut.

Untuk mengubah durasi, set `LP_NFT_LOCK_DURATION_SECONDS_<NETWORK>` di config jaringan, lalu jalankan:

```bash
npm run set:lp-nft-lock-duration:amoy
npm run set:lp-nft-lock-duration:polygon
```

Nilai durasi dalam detik. Jika owner locker adalah Safe, script menampilkan transaksi `setLockDuration` untuk diajukan melalui Safe.

Untuk first add-LP pada SurpSwap, buat dan inisialisasi pool SRP/WETH9 untuk kedua fee tier dari terminal. Atur harga awal di `SURPSWAP_INITIAL_PRICE_POL_PER_SRP_POLYGON`, lalu jalankan preflight:

```bash
npm run create:surpswap-pools:polygon
```

Jika preflight benar, konfirmasi akan membuat pool fee 3000 dan 10000 pada harga awal yang sama; tiap pool yang belum siap memerlukan transaksi terpisah. Script menyimpan alamat pool, tetapi belum menambahkan likuiditas. Setelah pool siap, jalankan command `add-lp:wpol` untuk fee tier yang ingin diberi likuiditas. Konfirmasi transaksi:

```bash
CONFIRM_CREATE_SURPSWAP_POOLS=YES npm run create:surpswap-pools:polygon
```

```bash
npm run add-lp:polygon
npm run add-lp:wpol:polygon
npm run add-lp:wpol:1:polygon
npm run configure:surpsidy-pools:polygon
npm run deploy:dex-swap:polygon
npm run deploy:lp-helper:polygon
```

`DUAL_LP_SLIPPAGE_BPS` di `config/networks/polygon.cjs` mengatur satu batas slippage untuk satu penambahan likuiditas melalui Uniswap atau QuickSwap: `10` = 0,1%, `50` = 0,5%, atau `100` = 1%. Pilih satu nilai sebelum menjalankan `add-lp:polygon`. Jika minimum amount disetel `AUTO`, script menghitung minimum token berdasarkan nilai tersebut; jika minimum ditulis manual, nilai manual yang digunakan.

Untuk inisialisasi pool saja tanpa menambahkan likuiditas, atur `DUAL_LP_DEX`, `DUAL_LP_TOKEN0`, `DUAL_LP_TOKEN1`, dan `DUAL_LP_INITIAL_PRICE_TOKEN1_PER_TOKEN0` di `config/networks/polygon.cjs`, lalu jalankan:

```bash
npm run init:dual-lp-pool:polygon
```

Untuk Uniswap, atur juga `DUAL_LP_UNISWAP_FEE`. Script ini hanya membuat/menginisialisasi pool dan menyimpan alamatnya; ia tidak melakukan approval atau mint LP. Harga awal adalah rasio token1 per token0. Pool yang sudah diinisialisasi tidak diubah. `npm run add-lp:polygon` tetap menjalankan penambahan likuiditas.

Frontend dapat menawarkan slippage 0,1%, 0,5%, 1%, atau 2% dengan menghitung `amountOutMinimum` dari quote, lalu mengirim minimum tersebut ke fungsi `buy(mode, fee, amountOutMinimum, deadline)` atau `buyWithProtection(...)`. Untuk sell, minimum hasil yang sama dikirim ke `sell(...)` atau `sellForTokenB(...)`. Kontrak menerima batas jumlah minimum, seperti helper, bukan angka persentase. Buy dan sell dengan Token B tetap memiliki batas internal 2%; `amountOutMinimum` dari frontend dapat memperketat batas untuk pilihan slippage di bawah 2%.

Menu Uniswap di frontend memakai `PolygonDexSwapHelper` dan hanya bertransaksi di Polygon mainnet. Setelah alamat token SRP, helper, dan Quoter tersedia, masukkan nilainya ke `NETWORK_DEPLOYMENTS[137]` di `frontend/src/constants/deployments.ts` dan `POLYGON_DEX_ADDRESSES` di `backend/config/blockchain.js`. Backend menyediakan quote melalui `POST /api/dex/uniswap/quote`; alamat frontend/backend harus sama. Script deploy menyimpan alamat helper ke `deployments/polygon.json`; deployment ke Polygon mainnet mengirim transaksi on-chain dan membutuhkan POL.

Command ini hanya menjadwalkan perubahan pool SurpSidy melalui timelock 24 jam. Jadwal disimpan otomatis ke file deployment. Setelah waktu tunggu habis, jalankan command berikut untuk mengeksekusi semua jadwal yang sudah siap—tidak perlu membuka explorer atau memanggil fungsi kontrak manual:

```bash
npm run execute:surpsidy-config:amoy
npm run execute:surpsidy-config:polygon
```

Jadwal pool Amoy yang dibuat pada 24 Oktober 2026 sekitar pukul 03:58 WIB siap dieksekusi pada 25 Oktober sekitar pukul 03:59 WIB.

## Script setup/admin

### Amoy

```bash
npm run set-base:amoy
npm run set-base-harga-shop:amoy
npm run setup-limit:amoy
npm run rescue:amoy
npm run rescue:p2e:amoy
npm run withdraw-srp:amoy
npm run withdraw-wpol:amoy
```

`set-base` hanya dijalankan setelah NFT dideploy. Alamat `NFT_*_ADDRESS_AMOY` ditambahkan otomatis ke constants saat `deploy:investor-nfts:amoy` berhasil; sebelum itu alamatnya memang belum ada dan script `set-base` belum bisa dipakai. URI yang akan dipasang ada di `NFT_BASE_URI_*_AMOY`.

Untuk mengatur harga SRP Shop, isi `SRP_SHOP_STAMINA_PRICE_AMOY`, `SRP_SHOP_DURABILITY_PRICE_AMOY`, dan `SRP_SHOP_BANK_PRICE_AMOY` di `config/networks/amoy.cjs`. Nilai memakai satuan SRP (18 desimal), misalnya `25` berarti 25 SRP. Jalankan command sebagai owner Shop; jika owner-nya Safe, script akan mencetak calldata untuk diajukan melalui Safe.

### Polygon

```bash
npm run set-base:polygon
npm run set-base-harga-shop:polygon
npm run setup-limit:polygon
npm run rescue:polygon
npm run rescue:p2e:polygon
npm run withdraw-srp:polygon
npm run withdraw-wpol:polygon
```

`setup-limit:<network>` hanya untuk mengubah batas subsidi SurpSidy. Pastikan SurpSidy sudah dideploy (`CONTRACT_ADDRESS_<NETWORK>` terisi), lalu isi `SUBSIDY_MAX_TX_<NETWORK>` dan `SUBSIDY_MAX_DAILY_<NETWORK>` dalam jumlah SRP, misalnya `"100"` berarti 100 SRP. Perintah ini menjadwalkan perubahan; setelah 24 jam, jalankan `executeConfig(nonce, data)` pada SurpSidy menggunakan nonce dan data yang dicetak. Jika batas default saat ini sudah sesuai, lewati perintah ini. Nilai Polygon masih kosong di constants dan wajib diisi jika ingin menjalankannya.

### Wallet penerima hasil penjualan

`SALES_TREASURY_ADDRESS_AMOY` dan `SALES_TREASURY_ADDRESS_POLYGON` di `config/networks/` disiapkan untuk wallet penerima khusus. Saat alamat diisi sebelum deployment, InvestorSale mengirim hasil investasi POL ke wallet itu, mint NFT mengirim SRP ke wallet itu, SRP Shop meneruskan pembayaran SRP ke wallet itu, dan seluruh pembayaran resale NFT POL masuk ke wallet itu. Royalti resale yang sudah terkumpul sebelum treasury dikonfigurasi tetap dapat ditarik oleh owner melalui `withdrawBySeries()` ke treasury aktif.

Jika alamat treasury kosong, perilaku lama dipertahankan. Kontrak yang sudah ter-deploy tidak berubah karena bukan proxy; dukungan treasury berlaku setelah kontrak terkait dideploy ulang menggunakan source baru dan alamat treasury terisi. Resale yang dialihkan ke treasury tidak membayar bagian 95% kepada penjual.

Untuk Polygon, `set-base` juga hanya dijalankan setelah NFT dideploy; alamat `NFT_*_ADDRESS_POLYGON` disimpan otomatis oleh script deploy NFT. URI yang akan dipasang ada di `NFT_BASE_URI_*_POLYGON`.

Untuk mengatur harga SRP Shop, isi `SRP_SHOP_STAMINA_PRICE_POLYGON`, `SRP_SHOP_DURABILITY_PRICE_POLYGON`, dan `SRP_SHOP_BANK_PRICE_POLYGON` di `config/networks/polygon.cjs`. Nilai memakai satuan SRP (18 desimal), misalnya `25` berarti 25 SRP. Jalankan command sebagai owner Shop; jika owner-nya Safe, script akan mencetak calldata untuk diajukan melalui Safe.

`rescue:<network>` hanya mengeksekusi satu transaksi dari relayer LPManager; `rescue:p2e:<network>` hanya mengeksekusi satu transaksi dari relayer P2EManager. Isi `LP_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY` atau `P2E_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY` di `.env` sesuai command; key `PRIVATE_KEY` dapat dipakai jika alamatnya cocok dengan relayer terpilih. Tentukan nominal SRP yang ingin ditarik melalui `RESCUE_LP_AMOUNT_AMOY`/`RESCUE_LP_AMOUNT_POLYGON` untuk LPManager dan `RESCUE_P2E_AMOUNT_AMOY`/`RESCUE_P2E_AMOUNT_POLYGON` untuk P2E. Jika jumlah melebihi saldo atau batas payout yang tersedia, script berhenti tanpa mengirim transaksi. Token diambil dari `SRP_TOKEN_<NETWORK>` secara default, atau dari `RESCUE_TOKEN_ADDRESS_<NETWORK>` jika diisi dan alamatnya sama dengan token manager.
