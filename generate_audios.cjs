// generate_audios.cjs  -> Genera 1 MP3 por cada línea del guion.txt

const fs = require("fs");
const path = require("path");
require("dotenv/config");

// Claves de ElevenLabs desde .env
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE = process.env.ELEVEN_VOICE;

// Validar claves
if (!ELEVEN_API_KEY || !ELEVEN_VOICE) {
  console.error("❌ Faltan ELEVEN_API_KEY o ELEVEN_VOICE en el archivo .env");
  process.exit(1);
}

// Asegurar carpetas de salida
const audioDir = path.join("output", "audio_lineas");
if (!fs.existsSync("output")) fs.mkdirSync("output");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// 🧹 LIMPIAR MP3 VIEJOS ANTES DE GENERAR
const archivosViejos = fs.readdirSync(audioDir);
for (const f of archivosViejos) {
  if (f.toLowerCase().endsWith(".mp3")) {
    fs.unlinkSync(path.join(audioDir, f));
  }
}

// Leer guion.txt
if (!fs.existsSync("guion.txt")) {
  console.error("❌ No se encontró guion.txt en la carpeta del proyecto.");
  process.exit(1);
}

const rawGuion = fs.readFileSync("guion.txt", "utf8");

// Cada línea = una escena / un audio
const lineas = rawGuion
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

if (!lineas.length) {
  console.error("❌ guion.txt está vacío o sin líneas válidas.");
  process.exit(1);
}

console.log("🎬 Líneas detectadas:", lineas.length);

// --------- FUNCIÓN PARA GENERAR AUDIO CON ELEVENLABS ----------
async function generarAudio(texto, outputPath) {
  console.log("🔊 Generando audio:", outputPath);

  const url =
    "https://api.elevenlabs.io/v1/text-to-speech/" + ELEVEN_VOICE;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: texto,
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Error ElevenLabs:", errText);
    throw new Error("Error generando audio");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

// ---------------------- MAIN ----------------------
async function main() {
  let idx = 1;

  for (const linea of lineas) {
    const num = String(idx).padStart(3, "0");
    const outputPath = path.join(audioDir, "linea_" + num + ".mp3");

    console.log("\n---- LÍNEA " + idx + " ----");
    console.log(linea);

    await generarAudio(linea, outputPath);

    idx++;
  }

  console.log("\n✅ Listo. Audios guardados en:", audioDir);
}

main().catch((e) => {
  console.error("❌ Error general:", e);
  process.exit(1);
});