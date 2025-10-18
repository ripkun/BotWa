const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { webcrypto } = require("crypto");
globalThis.crypto = webcrypto; // ✅ Tambahkan agar crypto.subtle tersedia di Node.js

async function startBot() {
  // Simpan sesi auth di folder "auth"
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    // ❌ printQRInTerminal dihapus (sudah deprecated)
  });

  // Simpan kredensial bila berubah
  sock.ev.on("creds.update", saveCreds);

  // Monitor koneksi + tampilkan QR + auto-reconnect
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    const qrcode = require("qrcode-terminal");

    if (qr) {
      console.log("📱 Scan QR ini sebelum timeout:\n");
      qrcode.generate(qr, { small: true }); // tampilkan QR langsung di terminal
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(
        "❌ Koneksi terputus. Status:",
        statusCode,
        "| loggedOut =",
        loggedOut
      );
      if (!loggedOut) {
        console.log("🔁 Mencoba sambung ulang...");
        startBot();
      } else {
        console.log(
          '🚪 Kamu logout. Hapus folder "auth" lalu jalankan ulang untuk scan QR lagi.'
        );
      }
    } else if (connection === "open") {
      console.log("✅ Bot terhubung ke WhatsApp!");
    }
  });

  // Helper: ambil teks dari berbagai tipe pesan
  function getText(msg) {
    const m = msg.message;
    if (!m) return "";
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      ""
    ).trim();
  }

  // Helper: cek pesan dari grup
  const isGroupJid = (jid) => jid.endsWith("@g.us");

  // Helper: ambil info admin grup
  async function getGroupAdmins(jid) {
    const meta = await sock.groupMetadata(jid);
    return meta.participants.filter((p) => p.admin).map((p) => p.id);
  }

  // Helper: bagi array ke batch (untuk grup besar, kurangi beban)
  function chunkArray(arr, size = 25) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // =========================
  // 📌 FITUR WELCOME & GOODBYE
  // =========================
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const metadata = await sock.groupMetadata(update.id);
      const groupName = metadata.subject;

      for (const participant of update.participants) {
        if (update.action === "add") {
          await sock.sendMessage(update.id, {
            text: `*(Bot)* Selamat datang @${
              participant.split("@")[0]
            } di *${groupName}*! 👋\nJangan lupa baca deskripsi grup ya.`,
            mentions: [participant],
          });
        } else if (update.action === "remove") {
          await sock.sendMessage(update.id, {
            text: `*(Bot)* Selamat tinggal @${
              participant.split("@")[0]
            }!\nSemoga kita bertemu lagi.`,
            mentions: [participant],
          });
        }
      }
    } catch (err) {
      console.error("❌ Error welcome/goodbye:", err);
    }
  });

  // =========================
  // 📌 FITUR PESAN (COMMAND)
  // =========================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages[0]) return;
    const msg = messages[0];

    // Abaikan status message & system broadcast
    if (msg.key.remoteJid === "status@broadcast") return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const text = getText(msg);

    // --- Perintah sederhana: !ping
    if (text.toLowerCase() === "!ping") {
      await sock.sendMessage(from, { text: "Pong 🏓" });
      return;
    }

    // --- Perintah: !tagall [pesan opsional]
    if (text.toLowerCase().startsWith("!tagall")) {
      if (!isGroupJid(from)) {
        await sock.sendMessage(from, {
          text: "Perintah ini hanya untuk *grup*.",
        });
        return;
      }

      const admins = await getGroupAdmins(from);
      const isAdmin = admins.includes(sender);
      if (!isAdmin) {
        await sock.sendMessage(from, {
          text: "❌ Hanya *admin grup* yang bisa pakai perintah ini.",
        });
        return;
      }

      const meta = await sock.groupMetadata(from);
      let members = meta.participants.map((p) => p.id);

      const botJid = sock.user?.id;
      if (botJid) members = members.filter((j) => j !== botJid);

      const extraText = text.replace(/^!tagall/i, "").trim();
      const header = extraText ? extraText : "Izin tag semua anggota 😄";

      const batches = chunkArray(members, 25);
      for (const batch of batches) {
        const atText = batch.map((j) => "@" + j.split("@")[0]).join(" ");
        const body = `${header}\n\n${atText}`;
        await sock.sendMessage(from, { text: body, mentions: batch });
      }
      return;
    }
  });
}

// Jalankan bot
startBot();
