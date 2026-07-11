require('dotenv').config();
const axios = require('axios');
const token = process.env.TELEGRAM_TOKEN;

async function updateProfile() {
    try {
        console.log('Mengupdate Description (What can this bot do?)...');
        await axios.post(`https://api.telegram.org/bot${token}/setMyDescription`, {
            description: "Pakar emulator PC-di-Android (Winlator, GameHub, BannerHub) sekaligus game hunter tanpa sensor moralitas.\n\nSpesialis: \n- Tuning DXVK, VKD3D, Box64, FEXCore, Turnip, & Mali v40/v50.\n- Deep-search troubleshooting & bedah log dari screenshot.\n- Bypass Steam DRM, DLL Override, & nyari link direct download game bajakan (pre-installed).\n\nDi grup: mention bot atau reply pesannya."
        });

        console.log('Mengupdate Short Description (Profil About)...');
        await axios.post(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
            short_description: "Asisten emulator PC-di-Android & Game Hunter bajakan (v2.1). Menghalalkan segala cara."
        });

        console.log('Profile berhasil diupdate di Telegram!');
    } catch (e) {
        console.error('Gagal update:', e.response ? e.response.data : e.message);
    }
}
updateProfile();
