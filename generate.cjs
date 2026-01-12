import express from "express";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import archiver from "archiver";
import multer from "multer";

const app = express();
app.use(express.json({ limit: "500mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carpetas
const outputDir = path.join(__dirname, "output");
const audioLineasDir = path.join(outputDir, "audio_lineas");
const videoDir = path.join(outputDir, "video");
const manualDir = path.join(outputDir, "manual");
const narrativaDir = path.join(outputDir, "narrativa");
const uploadsDir = path.join(__dirname, "uploads");

[outputDir, audioLineasDir, videoDir, manualDir, narrativaDir, uploadsDir].forEach(function(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(outputDir));

const upload = multer({ dest: uploadsDir });

// --- FUNCIÓN 1: IMAGEN IA (Pollinations) ---
async function descargarImagenIA(prompt, outputPath, seed, w, h) {
    const promptEncoded = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${promptEncoded}?width=${w}&height=${h}&model=flux&seed=${seed}&nologo=true`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Error Imagen: ${response.statusText}`);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(outputPath, Buffer.from(buffer));
        return true;
    } catch (error) {
        console.error("❌ Falló imagen IA:", error);
        return false;
    }
}

// --- FUNCIÓN 2: AUDIO IA (ElevenLabs) ---
async function generarAudioElevenLabs(texto, voiceId, apiKey, outputPath) {
    if (!apiKey || !voiceId) throw new Error("Falta API Key o Voice ID");
    
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: texto,
                model_id: "eleven_multilingual_v2", // Modelo que habla bien español
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`ElevenLabs Error: ${errorText}`);
        }

        const buffer = await response.arrayBuffer();
        fs.writeFileSync(outputPath, Buffer.from(buffer));
        return true;

    } catch (error) {
        console.error("❌ Falló Audio ElevenLabs:", error.message);
        return false;
    }
}

// ======================================================
// 1. MODO AUTOMÁTICO (FULL IA: ELEVENLABS + FLUX)
// ======================================================
app.post("/api/generar-full-ia", async function(req, res) {
    const { guion, descripcionPersonaje, estilo, formato, elevenApiKey, voiceId } = req.body;

    if (!guion) return res.status(400).json({ ok: false, error: "Guion vacío" });
    if (!elevenApiKey) return res.status(400).json({ ok: false, error: "Falta la API Key de ElevenLabs" });

    // Configurar Formato
    let w = 1080; let h = 1920;
    if (formato === "16:9") { w = 1920; h = 1080; }

    console.log(`🎬 [Auto] Iniciando producción completa en ${formato}...`);

    // Limpiar carpeta de trabajo
    if (fs.existsSync(manualDir)) {
        fs.readdirSync(manualDir).forEach(f => fs.unlinkSync(path.join(manualDir, f)));
    }

    const lineas = guion.split("\n").filter(l => l.trim().length > 0);
    const listTxtPath = path.join(manualDir, "list.txt");
    let fileListContent = "";
    const seedGlobal = Math.floor(Math.random() * 1000000);

    // Bucle principal: Procesar línea por línea
    for (let i = 0; i < lineas.length; i++) {
        const num = String(i + 1).padStart(3, "0");
        const lineaTexto = lineas[i].trim();
        
        console.log(`⚡ Procesando Línea ${i+1}/${lineas.length}: "${lineaTexto.substring(0, 20)}..."`);

        const audioDest = path.join(manualDir, `audio_${num}.mp3`);
        const imageDest = path.join(manualDir, `image_${num}.jpg`);
        const sceneDest = path.join(manualDir, `escena_${num}.mp4`);

        // 1. GENERAR AUDIO (ElevenLabs)
        const audioOk = await generarAudioElevenLabs(lineaTexto, voiceId, elevenApiKey, audioDest);
        if (!audioOk) return res.status(500).json({ok:false, error: `Fallo audio en línea ${i+1}`});

        // 2. GENERAR IMAGEN (Pollinations)
        // Prompt = Descripción Personaje + Acción (Texto Línea) + Estilo
        const finalPrompt = `${descripcionPersonaje}, ${lineaTexto}, ${estilo}`;
        await descargarImagenIA(finalPrompt, imageDest, seedGlobal, w, h);

        // 3. CREAR VIDEO ESCENA (FFmpeg)
        // Zoom puro para llenar pantalla
        const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
        const cmd = `ffmpeg -y -loop 1 -i "${imageDest}" -i "${audioDest}" -vf "${vf}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -tune stillimage -c:a aac -shortest "${sceneDest}"`;

        await new Promise((resolve) => exec(cmd, () => resolve()));
        fileListContent += `file 'escena_${num}.mp4'\n`;
    }

    // 4. UNIR VIDEO FINAL
    fs.writeFileSync(listTxtPath, fileListContent, "utf8");
    console.log("🔗 Uniendo video final...");
    
    exec(`ffmpeg -y -f concat -safe 0 -i list.txt -c copy final_manual.mp4`, { cwd: manualDir }, function(err) {
        if (err) return res.status(500).json({ ok: false, error: "Error uniendo video final" });
        res.json({ ok: true, videoUrl: "/output/manual/final_manual.mp4" });
    });
});

// ======================================================
// 2. NARRATIVA (SOLO IMÁGENES)
// ======================================================
app.post("/api/generar-imagenes-narrativa", async function(req, res) {
    const { guion, estilo, formato } = req.body;
    if (!guion) return res.status(400).json({ ok: false, error: "Guion vacío" });

    let w = 1080; let h = 1920;
    if (formato === "16:9") { w = 1920; h = 1080; }

    if (fs.existsSync(narrativaDir)) fs.readdirSync(narrativaDir).forEach(f => fs.unlinkSync(path.join(narrativaDir, f)));

    const lineas = guion.split("\n").filter(l => l.trim().length > 0);
    const generatedFiles = [];
    const seedGlobal = Math.floor(Math.random() * 1000000);

    for (let i = 0; i < lineas.length; i++) {
        const num = String(i + 1).padStart(3, "0");
        const fileName = `imagen_${num}.jpg`;
        const outputPath = path.join(narrativaDir, fileName);
        const finalPrompt = `${estilo}, ${lineas[i].trim()}`;
        
        console.log(`🖌️ [Storyboard] Generando ${i+1}...`);
        await descargarImagenIA(finalPrompt, outputPath, seedGlobal, w, h);
        generatedFiles.push(`/output/narrativa/${fileName}`);
    }
    res.json({ ok: true, images: generatedFiles });
});

app.get("/api/descargar-narrativa-zip", function(req, res) {
    if (!fs.existsSync(narrativaDir)) return res.status(404).send("No hay imágenes");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="imagenes_historia.zip"');
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);
    archive.directory(narrativaDir, false);
    archive.finalize();
});

// ======================================================
// 3. MODO MANUAL (ARCHIVOS PROPIOS)
// ======================================================
app.post("/api/video-manual", upload.fields([{ name: "audios" }, { name: "imagenes" }]), async function(req, res) {
  try {
    const formato = req.body.formato || "9:16"; 
    let w = 1080; let h = 1920;
    if (formato === "16:9") { w = 1920; h = 1080; }

    const files = req.files || {};
    const audioFiles = files.audios || [];
    const imgFiles = files.imagenes || [];

    if (audioFiles.length === 0 || imgFiles.length === 0) return res.status(400).json({ ok: false, error: "Faltan archivos" });

    if (fs.existsSync(manualDir)) fs.readdirSync(manualDir).forEach(f => fs.unlinkSync(path.join(manualDir, f)));

    const listTxtPath = path.join(manualDir, "list.txt");
    let fileListContent = "";

    for (let i = 0; i < audioFiles.length; i++) {
      const num = String(i + 1).padStart(3, "0");
      const audioPath = path.join(manualDir, "audio_" + num + path.extname(audioFiles[i].originalname));
      const imgPath = path.join(manualDir, "image_" + num + path.extname(imgFiles[i].originalname));
      const scenePath = path.join(manualDir, "escena_" + num + ".mp4");

      fs.renameSync(audioFiles[i].path, audioPath);
      fs.renameSync(imgFiles[i].path, imgPath);

      const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
      const cmd = `ffmpeg -y -loop 1 -i "${imgPath}" -i "${audioPath}" -vf "${vf}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -tune stillimage -c:a aac -shortest "${scenePath}"`;

      await new Promise((resolve) => exec(cmd, () => resolve()));
      fileListContent += `file 'escena_${num}.mp4'\n`;
    }

    fs.writeFileSync(listTxtPath, fileListContent, "utf8");
    exec(`ffmpeg -y -f concat -safe 0 -i list.txt -c copy final_manual.mp4`, { cwd: manualDir }, function(err) {
      if (err) return res.status(500).json({ ok: false, error: "Error uniendo" });
      res.json({ ok: true, videoUrl: "/output/manual/final_manual.mp4" });
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const PORT = 3000;
app.listen(PORT, function() {
  console.log("🔥 Servidor listo en http://localhost:" + PORT);
});