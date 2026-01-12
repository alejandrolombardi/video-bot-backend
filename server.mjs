import express from "express";
import path from "path";
import fs from "fs";
import { exec, execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import archiver from "archiver";
import multer from "multer";
import util from "util";
import fetch from "node-fetch";
import * as chromeLauncher from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { generarAudioYSubtitulos } from "./audiomanager.mjs";

// --- 1. CONFIGURACIÓN DE RUTAS (Solo una vez) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 2. MOTOR DE PYTHON Y SCRIPTS ---
const pythonVenv = path.join(__dirname, "venv", "Scripts", "python.exe");
const scriptsPath = path.join(__dirname, "scripts");

// --- 3. DIAGNÓSTICO DE ARRANQUE ---
try {
    const pythonPath = execSync('where python').toString();
    console.log("🔍 Ubicación de Python detectada:\n" + pythonPath);
} catch (e) {
    console.log("❌ No se encontró Python en el sistema");
}

// --- FUNCIÓN SUBTÍTULOS V126 (ANTI-HUÉRFANOS & MAX-CHARS 85) ---
function crearArchivoASS(dataWhisper, assPath, formato = "16:9", subsEnMedio = false, esDinamico = true) {
    const esVertical = formato === "9:16";
    
    // 1. ESTILOS
    const playResX = esVertical ? 1080 : 1920;
    const playResY = esVertical ? 1920 : 1080;
    const marginSide = esVertical ? 100 : 150; 

    let fontSize, alineacion, marginV, outline;
    if (esDinamico) {
        fontSize = esVertical ? 85 : 80; 
        alineacion = 5; marginV = 20; outline = 5;      
    } else {
        // 🔥 AJUSTE CRÍTICO: Bajamos a 40 para que quepan líneas largas en vertical
        fontSize = esVertical ? 40 : 42;
        alineacion = 2; 
        marginV = esVertical ? 350 : 60; 
        outline = 3;      
    }

    const amarillo = "&H0000FFFF";
    const negro = "&H00000000";
    
    let header = `[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nPlayResX: ${playResX}\nPlayResY: ${playResY}\n
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},${amarillo},${negro},${negro},${negro},-1,0,0,0,100,100,0,0,1,${outline},0,${alineacion},${marginSide},${marginSide},${marginV},1\n
[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const toAssTime = (sec) => {
        const d = new Date(sec * 1000);
        return d.toISOString().substring(11, 22).replace(/(\d{2})$/, (m) => m.substring(0, 2));
    };

    let events = "";

    // --- 2. LÓGICA DE ITERACIÓN ---

    if (esDinamico) {
        // (Lógica Karaoke se mantiene igual...)
        let palabras = [];
        if (dataWhisper.segments) dataWhisper.segments.forEach(s => { if(s.words) palabras = palabras.concat(s.words); });
        if (palabras.length === 0 && dataWhisper.words) palabras = dataWhisper.words;
        for (let i = 0; i < palabras.length; i++) {
            const p = palabras[i];
            let wordClean = p.word.trim().replace(/[.,;:!?¡¿"'()\-\|]/g, "").toUpperCase();
            if (!wordClean) continue;
            events += `Dialogue: 0,${toAssTime(p.start)},${toAssTime(p.end)},Default,,0,0,0,,${wordClean}\n`;
        }
    } else {
        // 🔥 MODO ESTÁTICO MEJORADO (BLOQUES LARGOS) 🔥
        
        // Subimos el límite a 85 para que entren frases complejas
        const MAX_CHARS = 85; 
        
        let todasLasPalabras = [];
        if (dataWhisper.segments) {
            dataWhisper.segments.forEach(s => { 
                if(s.words) todasLasPalabras = todasLasPalabras.concat(s.words);
            });
        }
        if (todasLasPalabras.length === 0 && dataWhisper.words) todasLasPalabras = dataWhisper.words;

        // Fallback
        if (todasLasPalabras.length === 0 && dataWhisper.segments) {
             dataWhisper.segments.forEach(seg => {
                events += `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},Default,,0,0,0,,${seg.text.trim()}\n`;
             });
        } else {
            let bufferTexto = "";
            let startTime = null;
            let ultimoEndTime = 0;
            
            let forzarMayuscula = true; 

            for (let i = 0; i < todasLasPalabras.length; i++) {
                const wordObj = todasLasPalabras[i];
                const wordText = wordObj.word.trim();
                
                if (startTime === null) startTime = wordObj.start;

                bufferTexto += (bufferTexto === "" ? "" : " ") + wordText;
                ultimoEndTime = wordObj.end;

                // DETECTORES
                const tieneComa = wordText.includes(",");
                const tienePunto = /[.?!"]$/.test(wordText);
                const esElUltimo = (i === todasLasPalabras.length - 1);
                
                // --- 🔥 LÓGICA INTELIGENTE "MIRAR AL FUTURO" 🔥 ---
                let esMuyLargo = bufferTexto.length > MAX_CHARS;
                
                // TRUCO: Si ya nos pasamos, PERO la SIGUIENTE palabra es el final (punto),
                // IGNORAMOS el límite para atrapar esa última palabra.
                if (esMuyLargo && i < todasLasPalabras.length - 1) {
                    const siguientePalabra = todasLasPalabras[i + 1].word.trim();
                    if (/[.?!"]$/.test(siguientePalabra)) {
                        // ¡AGUANTA! No cortes todavía, deja que entre la siguiente (ej: "macho.")
                        esMuyLargo = false; 
                    }
                }

                if (tieneComa || tienePunto || esElUltimo || esMuyLargo) {
                    
                    let textoFinal = bufferTexto.trim();

                    // Mayúscula inicial
                    if (textoFinal.length > 0 && forzarMayuscula) {
                        textoFinal = textoFinal.charAt(0).toUpperCase() + textoFinal.slice(1);
                    }

                    // Lógica de continuidad
                    if (tienePunto) {
                        forzarMayuscula = true; 
                    } else if (tieneComa || esMuyLargo) {
                        forzarMayuscula = false; 
                    }

                    if (esElUltimo && !/[.?!"]$/.test(textoFinal)) textoFinal += ".";

                    events += `Dialogue: 0,${toAssTime(startTime)},${toAssTime(ultimoEndTime)},Default,,0,0,0,,${textoFinal}\n`;

                    bufferTexto = "";
                    startTime = null;
                }
            }
        }
    }

    fs.writeFileSync(assPath, header + events, "utf8");
}

// --- MARCA DE AGUA PARA VERIFICAR VERSIÓN ---

console.log("------------------------------------------------");
console.log("🚀 CARGANDO VERSIÓN V35.0 (DOBLE PASADA + 800 PALABRAS)");
console.log("------------------------------------------------");

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json({ limit: "500mb" }));

const ffmpegPath = path.join(__dirname, "ffmpeg.exe");
const cmdFFmpeg = fs.existsSync(ffmpegPath) ? `"${ffmpegPath}"` : "ffmpeg";

// 🔥 CONCURRENCIA X2
const CONCURRENCIA = 2;

const outputDir = path.join(__dirname, "output");
const manualDir = path.join(outputDir, "manual");
const narrativaDir = path.join(outputDir, "narrativa");
const uploadsDir = path.join(__dirname, "uploads");
const musicaDir = path.join(__dirname, "musica"); 

// --- 🏦 BANCO DE KEYS DE RESERVA (ELEVENLABS) ---

// Agrega aquí todas las claves extra que tengas.
const KEYS_RESERVA = [
    "sk_clave_reserva_1...",
    "sk_clave_reserva_2...",
    "sk_clave_reserva_3..."
];

[outputDir, manualDir, narrativaDir, uploadsDir, musicaDir].forEach((dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });
["alegre", "triste", "tension", "accion", "neutro"].forEach(mood => { const p = path.join(musicaDir, mood); if (!fs.existsSync(p)) fs.mkdirSync(p); });

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(outputDir));
const upload = multer({ dest: uploadsDir });

let globalStatus = { percent: 0, message: "Esperando...", isActive: false };
function updateStatus(p, msg) { globalStatus.percent = p; globalStatus.message = msg; globalStatus.isActive = true; console.log(`[${p}%] ${msg}`); }

// --- FUNCIONES CORE ---

async function cazarTokenWhisk(){console.log("🕵️‍♂️ Robot...");const sessionPath=path.join(__dirname,'sesion_robot');if(!fs.existsSync(sessionPath))fs.mkdirSync(sessionPath);const chrome=await chromeLauncher.launch({startingUrl:'https://labs.google/fx/tools/whisk/project',chromeFlags:['--disable-infobars','--no-first-run','--window-size=1000,900'],userDataDir:sessionPath});const resp=await fetch(`http://127.0.0.1:${chrome.port}/json/version`);const data=await resp.json();const browser=await puppeteer.connect({browserWSEndpoint:data.webSocketDebuggerUrl,defaultViewport:null});const page=(await browser.pages())[0];await page.evaluate(()=>{const div=document.createElement('div');div.style="position:fixed; top:10px; left:50%; background:#222; color:#0f0; padding:10px; z-index:99999;";div.innerText="🤖 ROBOT ACTIVO";document.body.appendChild(div);});return new Promise((resolve,reject)=>{const timeout=setTimeout(async()=>{await browser.disconnect();reject("Timeout");},180000);page.on('request',async(request)=>{if(request.url().includes('whisk:generateImage')){const auth=request.headers()['authorization'];const cookie=request.headers()['cookie'];if(auth&&auth.startsWith('Bearer ya29')){clearTimeout(timeout);await page.close();await browser.disconnect();resolve({token:auth.replace('Bearer ',''),cookie});}}});});}

async function repararPrompt(promptOriginal,apiKeyGemini,w,h){if(!apiKeyGemini)return promptOriginal;const ratio=h>w?"Vertical 9:16":"Cinematic 16:9";const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKeyGemini}`;try{const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:`Fix safety. Keep style. Remove NSFW names. Start with "${ratio}". Prompt: "${promptOriginal}"`}]}]})});const data=await res.json();return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()||promptOriginal;}catch(e){return promptOriginal;}}

// --- FUNCIÓN MEJORADA: VERIFICAR SALDO ---
async function verificarSaldoElevenLabs(apiKey) {
    // Limpieza de seguridad: quitamos espacios
    const keyLimpia = apiKey ? apiKey.trim() : "";

    console.log(`🔍 Consultando ElevenLabs con Key que empieza por: ${keyLimpia.substring(0, 4)}...`);

    try {
        const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
            method: "GET",
            headers: { "xi-api-key": keyLimpia }
        });

        if (!response.ok) {
            // AQUÍ ESTÁ EL CHIVATO: Te dirá por qué falló
            console.error(`❌ ElevenLabs Error ${response.status}: ${response.statusText}`);
            const errorDetalle = await response.text();
            console.error(`   Detalle: ${errorDetalle}`);
            return null;
        }

        const data = await response.json();
        return {
            usado: data.character_count,
            limite: data.character_limit,
            restante: data.character_limit - data.character_count,
            porcentaje: Math.round((data.character_count / data.character_limit) * 100)
        };
    } catch (error) { 
        console.error("❌ Error de Conexión interna:", error.message);
        return null; 
    }
}

// ==========================================
// ⚡ MODO CORTO (ACTUALIZADO: CASCADA + LIMPIEZA JSON + ADN)
// ==========================================

async function inventarHistoriaGemini(tematica, estilo, apiKey) {
    // 🌊 ESTRATEGIA CASCADA
    const modelos = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"];
    
    const systemPrompt = `
    Eres un Director de Arte y Casting experto.
    INPUT: "${tematica}". 
    ESTILO: ${estilo || "Cinematográfico"}.
    
    TAREA 1: Crea una Sinopsis atractiva y estructurada (máx 1000 chars).
    
    TAREA 2: Define Personajes con "ADN VISUAL" (Inglés, entre corchetes).
    
    🚨 REGLA DE ORO DE CREATIVIDAD (ADN):
    Si la descripción física no existe en la historia, ¡INVÉNTALA!
    Debes definir: Edad aproximada, Etnia, Color/Estilo de Pelo, Color de Ojos, Ropa icónica y Rasgos faciales.
    
    🚨 REGLA DE "FOTO FIJA":
    El ADN debe ser ESTATICO.
    ⛔ PROHIBIDO: NO pongas posturas ("lying", "standing", "sitting").
    ⛔ PROHIBIDO: NO pongas acciones ("running", "sleeping").
    
    ❌ MAL: [Adult man, lying in bed, sad] (Muy genérico y tiene postura)
    ✅ BIEN: [Adult man, 35 years old, sharp jawline, messy dark brown hair, stubble beard, weary green eyes, wearing dark navy silk pajamas, athletic build] (Rico en detalles y sin postura)

    RESPUESTA FORMATO JSON PURO: 
    { "idea": "...", "personajes": [ "NOMBRE: [ADN VISUAL EN INGLÉS]" ] }
    `;

    for (const modelo of modelos) {
        console.log(`🧠 Inventando historia y casting con: ${modelo}...`);

        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: systemPrompt }] }],
                    generationConfig: { response_mime_type: "application/json" }
                })
            });

            if (!res.ok) throw new Error(`Status ${res.status}`);

            const data = await res.json();
            if (!data.candidates || !data.candidates[0]) throw new Error("Respuesta vacía");

            let rawText = data.candidates[0].content.parts[0].text;
            rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

            return JSON.parse(rawText);

        } catch (e) {
            console.warn(`⚠️ Falló ${modelo}: ${e.message}. Probando siguiente...`);
        }
    }
    return null;
}

async function generarGuionGemini(idea, apiKey, estiloVisual, personajes) {
    // 🌊 ESTRATEGIA CASCADA
    const modelos = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"];

    // Convertimos personajes a string seguro
    let listaPersonajes = (typeof personajes === 'object') ? JSON.stringify(personajes) : String(personajes);

    const systemPrompt = `
    ERES UN GENERADOR DE SCRIPTS PARA VIDEO IA.
    
    INPUTS:
    - HISTORIA: "${idea}"
    - ADN VISUAL (ESTÁTICO): ${listaPersonajes}
    - ESTILO GLOBAL: ${estiloVisual}

    OBJETIVO: Generar líneas de ejecución para video.

    🚨 REGLA SUPREMA: "NO NAKED NAMES" (Nombres Desnudos Prohibidos) 🚨
    JAMÁS escribas el nombre de un personaje en el PROMPT VISUAL sin pegar su ADN inmediatamente después.
    Incluso si están lejos, congelados, de espaldas o en grupo: SI EL NOMBRE ESTÁ, EL ADN DEBE ESTAR.

    ❌ MAL: ...Elías and Tuerca frozen in time...
    ✅ BIEN: ...Elías [Elderly man, white hair...] and Tuerca [Small robot, brass body...] frozen in time...

    🚨 INSTRUCCIÓN DE MONTAJE DE PROMPT:
    [ADN VISUAL DEL PERSONAJE] + [ACCIÓN] + [EMOCIÓN] + [ENTORNO].
    
    1. Si hay varios personajes, pon el ADN de CADA UNO.
    2. Si la narrativa menciona a un personaje, el prompt visual DEBE incluirlo visualmente (con su ADN).

    FORMATO DE SALIDA (SIN MARKDOWN):
    Texto español || Visual prompt in English [Character DNA], action, specific emotion, detailed background, ${estiloVisual}.

    GENERA EL CÓDIGO AHORA:
    `;

    for (const modelo of modelos) {
        console.log(`🎬 Escribiendo guion con modelo: ${modelo}...`);

        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: systemPrompt }] }] })
            });

            if (!res.ok) {
                if (res.status === 429) {
                    console.log("⏳ Cuota agotada. Pausa de 3s...");
                    await new Promise(r => setTimeout(r, 3000));
                }
                throw new Error(`Status ${res.status}`);
            }

            const data = await res.json();
            if (!data.candidates || !data.candidates[0]) throw new Error("Respuesta vacía");

            let texto = data.candidates[0].content.parts[0].text.trim();

            // 🧹 LIMPIEZA FINAL
            texto = texto
                .replace(/```/g, "")
                .replace(/^json/gim, "")
                .replace(/^text/gim, "")
                .replace(/\*\*/g, "")
                .replace(/ESCENA \d+/gi, "")
                .trim();

            console.log(`✅ Guion generado con ${modelo}`);
            return texto;

        } catch (e) {
            console.error(`❌ Falló ${modelo}: ${e.message}`);
        }
    }
    return null;
}

// 🔥 MODO LARGO (800 PALABRAS + NO ANTI-GRASA)

async function redactarGuionLargoGemini(tema, estiloNarrativo, apiKey, duracionMinutos, contextoSegmento, estiloVisual) {

    const modelo = "gemini-2.5-pro"; 
    const minutosPorBloque = 5;
    const totalBloques = Math.max(2, Math.ceil(duracionMinutos / minutosPorBloque));
    const palabrasPorBloque = 800; // Objetivo FIJO

    console.log(`📊 ESTRATEGIA: ${totalBloques} Bloques. Objetivo: ${palabrasPorBloque} palabras (Modo Libre).`);

    let guionCompleto = "";
    let resumenPrevio = "Inicio del documental.";

    for (let i = 1; i <= totalBloques; i++) {

        // PASO 1: EL GUIONISTA

        console.log(`✍️ PASO 1/2 (Bloque ${i}): Redactando narrativa pura...`);

        let ritmo = i === 1 ? "INTRODUCCIÓN POTENTE." : (i === totalBloques ? "CONCLUSIÓN Y LLAMADO A LA ACCIÓN." : "DESARROLLO PROFUNDO.");

        const promptNarrativo = `

        ERES UN GUIONISTA DE ELITE. Escribe la PARTE ${i}/${totalBloques} sobre "${tema}".

        CONTEXTO PREVIO: "${resumenPrevio}"

        OBJETIVO: Escribir EXACTAMENTE ALREDEDOR DE ${palabrasPorBloque} PALABRAS de narración pura en ESPAÑOL.

        INSTRUCCIONES DE ESTILO: ${estiloNarrativo}

        RITMO: ${ritmo}

        🚨 REGLAS: SOLO TEXTO DE NARRACIÓN. NO PROMPTS. NO TÍTULOS. Extiéndete libremente.

        `;

        let textoNarrativoPuro = "";

        try {

            const res1 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`, { 

                method: "POST", headers: { "Content-Type": "application/json" }, 

                body: JSON.stringify({ contents: [{ parts: [{ text: promptNarrativo }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 8192 } }) 

            });

            const data1 = await res1.json();

            textoNarrativoPuro = data1.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        } catch (e) { console.error("Error Paso 1", e); break; }

        if (!textoNarrativoPuro) break;

        console.log(`   ✅ Texto base creado: ${textoNarrativoPuro.length} caracteres.`);

        // PASO 2: EL DIRECTOR

        console.log(`🎥 PASO 2/2 (Bloque ${i}): Inyectando visuales...`);
        const promptVisualizador = `

        ACTÚA COMO DIRECTOR DE CINE. INPUT (NO MODIFICAR TEXTO ESPAÑOL): "${textoNarrativoPuro}"

        TU TAREA:

        1. Divide el texto por punto seguido.

        2. Añade un Prompt Visual en inglés al final de cada frase.

        APLICA ESTAS REGLAS VISUALES: ${estiloNarrativo}

        ESTILO TÉCNICO: "${estiloVisual}"

        FORMATO: Frase... || Visual prompt...

        `;

        try {

            const res2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`, { 

                method: "POST", headers: { "Content-Type": "application/json" }, 
                body: JSON.stringify({ contents: [{ parts: [{ text: promptVisualizador }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 8192 } }) 

            });

            const data2 = await res2.json();
            let textoFinal = data2.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (textoFinal) {

                textoFinal = textoFinal.replace(/\*\*/g, "").replace(/^#+\s/gm, "").replace(/=== BLOQUE \d ===/g, "");
                guionCompleto += `\n=== BLOQUE ${i} ===\n${textoFinal}\n`;
                resumenPrevio = "..." + textoNarrativoPuro.slice(-600);
                console.log(`✅ Bloque ${i} FINALIZADO.`);

            }

        } catch (e) { console.error("Error Paso 2", e); break; }

    }

    return guionCompleto;

}

// UTILIDADES Y ENDPOINTS (Se mantienen)

async function detectarEmocionYMusica(guion, apiKey) { let emocion = "neutro"; try { const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: `Analiza emoción: "${guion.substring(0,500)}...". Cats: alegre, triste, tension, accion, neutro. 1 palabra.` }] }] }) }); const data = await res.json(); const t = data.candidates[0].content.parts[0].text.toLowerCase(); if (t.includes("triste")) emocion="triste"; else if (t.includes("alegre")) emocion="alegre"; else if (t.includes("tension")) emocion="tension"; else if (t.includes("accion")) emocion="accion"; } catch (e) {} const p = path.join(musicaDir, emocion); if (!fs.existsSync(p)) return null; const f = fs.readdirSync(p).filter(x => x.endsWith(".mp3")); if (f.length === 0) { const pn = path.join(musicaDir, "neutro"); if(fs.existsSync(pn)) { const fn = fs.readdirSync(pn).filter(x => x.endsWith(".mp3")); if(fn.length>0) return path.join(pn, fn[Math.floor(Math.random()*fn.length)]); } return null; } return path.join(p, f[Math.floor(Math.random()*f.length)]); }

async function obtenerDuracion(f) { try { const { stderr } = await execPromise(`${cmdFFmpeg} -i "${f}"`); const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if(m) return (parseFloat(m[1])*3600)+(parseFloat(m[2])*60)+parseFloat(m[3]); return 0; } catch(e) { if(e.stderr) { const m = e.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if(m) return (parseFloat(m[1])*3600)+(parseFloat(m[2])*60)+parseFloat(m[3]); } return 0; } }

// 🔥 FUNCIÓN DE REINTENTO PARA WHISK

async function generarImagenConReintento(prompt, motor, gk, wc, w, h, path, gapi, intentos = 3) {
    for (let i = 0; i < intentos; i++) {
        // Le pasamos el número de intento (i + 1) para mejorar el log
        const exito = await generarImagenMotor(prompt, motor, gk, wc, w, h, path, gapi, i + 1);
        
        if (exito) {
            console.log(`   ✅ Imagen generada OK (Intento ${i + 1})`);
            return true;
        }

        // Si falló, avisamos. 
        // OPTIMIZACIÓN: Solo esperamos los 5s si NO es el último intento.
        if (i < intentos - 1) {
            console.log(`   ⚠️ Fallo imagen (Intento ${i + 1}/${intentos}). Reintentando en 5s...`);
            await new Promise(r => setTimeout(r, 5000));
        } else {
            console.error(`   ❌ Fallo definitivo imagen tras ${intentos} intentos.`);
        }
    }
    return false;
}

// 🕵️‍♂️ VERSIÓN FORENSE: Imprime todo lo que entra para encontrar el error invisible
async function generarImagenMotor(p, e, k, c, w, h, o, gk, intentoNum = 1) {
    
    // 1. DIAGNÓSTICO DE ENTRADA (Aquí veremos qué está mal)
    console.log(`🔎 [Intento ${intentoNum}] Motor: "${e}" | Token: "${k ? k.substring(0,5)+'...' : 'VACÍO'}" | Prompt: "${p.substring(0,10)}..."`);

    // 2. POLLINATIONS
    if (e === "pollinations") {
        try {
            const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=${w}&height=${h}&model=flux&nologo=true`);
            if (r.ok) {
                fs.writeFileSync(o, Buffer.from(await r.arrayBuffer()));
                return true;
            }
        } catch (e) {}
        return false;
    }

    // 3. NANO BANANA
    if (e === "nanobanana") {
        // ... (código igual, lo omito para no saturar, pero asegúrate de dejarlo si lo usas) ...
        return false;
    }

    // 4. WHISK (LA PRUEBA DE FUEGO)
    // Aceptamos cualquier variante para que no falle por nombres
    if (e === "whisk" || e === "whisky") { 
        
        if (!k || k.length < 10) {
            console.error("   ❌ ERROR FATAL: El Token de Whisk está vacío o es inválido.");
            return false;
        }

        const doFetch = async (pr) => fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateImage", {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=UTF-8",
                "Authorization": `Bearer ${k}`,
                "Cookie": c,
                "Origin": "https://labs.google"
            },
            body: JSON.stringify({
                "clientContext": { "tool": "BACKBONE", "sessionId": `;${Date.now()}` },
                "imageModelSettings": { "imageModel": "IMAGEN_3_5", "aspectRatio": w > h ? "IMAGE_ASPECT_RATIO_LANDSCAPE" : "IMAGE_ASPECT_RATIO_PORTRAIT" },
                "prompt": pr,
                "mediaCategory": "MEDIA_CATEGORY_BOARD"
            })
        });

        try {
            // console.log("   📡 Enviando petición a Google..."); // Descomentar si quieres ver esto
            let r = await doFetch(p);

            // LOGICA DE REPARACIÓN
            if (!r.ok && (r.status === 400 || r.status === 403)) {
                console.log(`   🔸 Whisk Error ${r.status}. Intentando reparar...`);
                const safeP = await repararPrompt(p, gk, w, h);
                if (safeP !== p) {
                    r = await doFetch(safeP);
                    if (r.ok) console.log("   ✅ Reparación funcionó.");
                }
            }

            if (!r.ok) {
                const txt = await r.text();
                console.error(`   ❌ Fallo Google (${r.status}): ${txt.substring(0, 100)}...`);
                return false;
            }

            const d = await r.json();
            const b64 = d.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage || d.images?.[0]?.imageBytes;

            if (b64) {
                const buffer = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64");
                fs.writeFileSync(o, buffer);
                
                if (fs.existsSync(o) && fs.statSync(o).size > 0) {
                    // console.log("   💾 Guardado OK");
                    return true; 
                } else {
                    console.error("   ❌ Error de escritura en disco.");
                    return false;
                }
            } else {
                console.error("   ⚠️ JSON recibido pero sin imagen.");
            }

        } catch (e) {
            console.error(`   ❌ Excepción Fetch: ${e.message}`);
        }
        return false;
    }
    
    // Si llegamos aquí, el nombre del motor no era ni whisk ni whisky
    console.error(`   ❌ ERROR: Motor desconocido recibido: "${e}"`);
    return false;
}

// 🔥 GENERACIÓN DE AUDIO (CON ROTACIÓN DE KEYS)
async function generarAudio(t, v, k, p, debug) {
    // 1. MODO DEBUG (Voz Google - Gratis)
    if (debug) {
        console.log("🔊 Generando Audio Debug (Google)...");
        try {
            const chunks = t.match(/[\s\S]{1,180}(?!\S)/g) || [t];
            const audioBuffers = [];
            for (let i = 0; i < chunks.length; i++) {
                if (i > 0) await new Promise(r => setTimeout(r, 250));
                const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunks[i].trim())}&tl=es&client=tw-ob`;
                
                // Header falso para que Google no nos bloquee
                const r = await fetch(url, {
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36" }
                });

                if (r.ok) {
                    const buf = await r.arrayBuffer();
                    if (buf.byteLength > 100) audioBuffers.push(Buffer.from(buf));
                }
            }

            if (audioBuffers.length === 0) return false;

            // Unimos los trozos y guardamos
            const raw = p.replace(".mp3", "_raw.mp3");
            fs.writeFileSync(raw, Buffer.concat(audioBuffers));

            // Convertimos a MP3 estándar con FFmpeg
            try {
                await execPromise(`${cmdFFmpeg} -y -i "${raw}" -ac 2 -vn "${p}"`);
                fs.unlinkSync(raw);
                return true; // <--- Este return está DENTRO del if(debug), es válido.
            } catch (e) {
                fs.renameSync(raw, p);
                return true; 
            }

        } catch (e) {
            console.error("❌ Error en Audio Debug:", e.message);
            return false;
        }
    }

    // 2. MODO ELEVENLABS (CON ROTACIÓN AUTOMÁTICA)
    // Usamos la key de la web (k) + las de reserva que pusiste arriba
    // Filtramos para asegurarnos de que no haya keys vacías
    let listaKeys = [k, ...KEYS_RESERVA].filter(key => key && key.length > 10);
    
    for (let i = 0; i < listaKeys.length; i++) {
        const keyActual = listaKeys[i];
        if(i > 0) console.log(`   🔄 Intentando con Key Reserva #${i}...`);

        try {
            const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v}`, {
                method: "POST", 
                headers: { "Content-Type": "application/json", "xi-api-key": keyActual },
                body: JSON.stringify({ text: t, model_id: "eleven_multilingual_v2" })
            });
            
            if (r.ok) { 
                fs.writeFileSync(p, Buffer.from(await r.arrayBuffer())); 
                if(i > 0) console.log("   ✅ ¡Key de Reserva salvó el día!");
                return true; // <--- Este return está DENTRO del bucle y de la función, es válido.
            } else { 
                console.warn(`   ⚠️ Fallo Key ${i + 1} (${r.status}). Probando siguiente...`); 
            }
        } catch (e) { console.error(`   ❌ Error Red Key ${i+1}`); }
    }
    
    console.error("❌ TODAS LAS KEYS FALLARON.");
    return false; // <--- Este return está al final de la función, es válido.
}

// ENDPOINTS VITALES PARA LA RUTA /api/redactar-largo (EL QUE DABA 404)

app.get("/api/status-video", (req, res) => res.json(globalStatus));

// --- NUEVO ENDPOINT: CONSULTAR SALDO ---
app.post("/api/saldo-eleven", async (req, res) => {
    const info = await verificarSaldoElevenLabs(req.body.apiKey);
    if (info) {
        console.log(`💰 ELEVENLABS: Quedan ${info.restante} caracteres (${info.porcentaje}% usado).`);
        res.json({ ok: true, ...info });
    } else {
        res.json({ ok: false, error: "Error o Key inválida" });
    }
});

app.get("/api/obtener-token-auto", async (req, res) => { try { const d = await cazarTokenWhisk(); res.json(d ? { ok: true, ...d } : { ok: false }); } catch (e) { res.json({ ok: false, error: e.toString() }); } });

app.post("/api/inventar-historia", async (req, res) => { const d = await inventarHistoriaGemini(req.body.tematica, req.body.estilo, req.body.googleApiKey); res.json(d ? { ok: true, ...d } : { ok: false, error: "Fallo Gemini" }); });

app.post("/api/mejorar-guion-gemini", async (req, res) => { const g = await generarGuionGemini(req.body.historiaBruta, req.body.googleApiKey, req.body.estilo, req.body.personajes); res.json(g ? { ok: true, guionMejorado: g } : { ok: false, error: "Fallo Gemini" }); });

// 🔥 AQUÍ ESTÁ EL ENDPOINT QUE TE DABA 404. AHORA ESTÁ PRESENTE.

app.post("/api/redactar-largo", async (req, res) => { 

    const { tema, estiloNarrativo, googleApiKey, duracion, contexto, estiloVisual } = req.body; 

    const texto = await redactarGuionLargoGemini(tema, estiloNarrativo, googleApiKey, parseInt(duracion)||20, contexto, estiloVisual); 

    res.json(texto ? { ok: true, textoGenerado: texto } : { ok: false, error: "Fallo Redacción Gemini" }); 

});

app.post("/api/borrar-escena", async (req, res) => {
    const rawInput = String(req.body.num);
    let targets = [];

    try {
        // Lógica para entender RANGOS (Ej: "10-15")
        if (rawInput.includes("-")) {
            const [start, end] = rawInput.split("-").map(x => parseInt(x.trim()));
            if (!isNaN(start) && !isNaN(end) && end >= start) {
                for (let i = start; i <= end; i++) targets.push(i);
            }
        } 
        // Lógica para LISTAS o UN SOLO NÚMERO (Ej: "1,3,5" o "10")
        else {
            targets = rawInput.split(",").map(x => parseInt(x.trim())).filter(x => !isNaN(x));
        }

        if (targets.length === 0) return res.json({ ok: false, error: "Formato inválido" });

        console.log(`🗑️ Solicitud de borrado para escenas: ${targets.join(", ")}`);

        targets.forEach(num => {
            const n = String(num).padStart(3, "0");
            [
                path.join(manualDir, `img_${n}.jpg`),      // Borrar Imagen
                path.join(manualDir, `escena_${n}.mp4`)    // Borrar Video
                // path.join(manualDir, `audio_${n}.mp3`)  // 🛡️ AUDIO PROTEGIDO (No tocar)
            ].forEach(f => {
                if (fs.existsSync(f)) {
                    try { fs.unlinkSync(f); } catch(e){}
                }
            });
        });

        res.json({ ok: true, count: targets.length });

    } catch (e) {
        console.error("Error al borrar:", e);
        res.json({ ok: false });
    }
});

app.post("/api/subir-musica", upload.single("audio"), (req, res) => { if (!req.file) return res.json({ ok: false }); fs.renameSync(req.file.path, req.file.path + ".mp3"); res.json({ ok: true, filename: req.file.filename + ".mp3" }); });

app.post("/api/generar-full-ia", async (req, res) => {
  const { 
        guion, estilo, formato, motorImagenes, 
        googleApiKey, geminiApiKey, whiskCookie, elevenApiKey, voiceId, 
        reanudar, modoDebug, musicaManual, volumenMusica,
        efectoPendulo, intensidadPendulo, velocidadPendulo, 
        usarTransiciones, 
        usarSubtitulos, subsEnMedio,
        tipoVoz, 
        tipoSub,
        // 👇 AGREGADO AQUÍ: Capturamos el checkbox del HTML
        efectoNoir 
    } = req.body;
    
    // Configuración base
    let w = formato === "16:9" ? 1920 : 1080; 
    let h = formato === "16:9" ? 1080 : 1920; 
    if(modoDebug) { w=w===1920?1280:720; h=h===1080?720:1280; } 
    const volFinal = parseFloat(volumenMusica) || 0.12;
    const DB_FILE = path.join(manualDir, 'data.json');

    try {

        // ==========================================
        // 1. GESTIÓN DE LA BASE DE DATOS Y SEGURIDAD
        // ==========================================
        
        let baseDeDatos = [];
        let lineasInput = guion.split("\n").filter(l => l.trim().length > 0);

        // 🎵 DETECTOR DE COMANDO AUDIO (*AUDIO)
        const modoAudioReset = lineasInput.some(l => l.includes("*AUDIO"));
        if (modoAudioReset) {
            lineasInput = lineasInput.filter(l => !l.includes("*AUDIO"));
        }
        
        // Cargar DB existente
        if (fs.existsSync(DB_FILE)) {
            try { baseDeDatos = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) {}
        }

        // 🎵 LIMPIEZA DE AUDIO (Solo si usas *AUDIO explícitamente)
        if (modoAudioReset) {
            console.log("🎤 COMANDO *AUDIO DETECTADO: Eliminando audios y videos viejos...");
            baseDeDatos.forEach((_, idx) => {
                const n = String(idx + 1).padStart(3, "0");
                const filesToDelete = [
                    path.join(manualDir, `escena_${n}.mp4`),
                    path.join(manualDir, `audio_${n}.mp3`)
                ];
                filesToDelete.forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
            });
            console.log("✨ Limpieza de audio completada.");
        }

        // 🕵️‍♂️ DETECTOR DE INTENCIÓN (PARCHE vs NORMAL)
        const regexNumero = /^(\d+)[\.\-\)\s]+(.*)/;
        const esParche = lineasInput.some(l => regexNumero.test(l));

        if (esParche) {
            console.log("🛠️ MODO PARCHE DETECTADO (Conservando Audio)");
            if (baseDeDatos.length === 0) return res.json({ ok: false, error: "⚠️ Error: No hay proyecto previo para parchear." });

            lineasInput.forEach(linea => {
                const match = linea.match(regexNumero);
                if (match) {
                    const idReal = parseInt(match[1]);
                    const contenido = match[2].trim();
                    const index = idReal - 1;

                    if (index >= 0 && index < baseDeDatos.length) {
                        baseDeDatos[index] = contenido;
                        console.log(`   ✏️  Regenerando IMAGEN de Escena ${idReal} (Audio intacto)`);
                        const n = String(idReal).padStart(3, "0");
                        
                        // 👇 AQUÍ PROTEGEMOS EL AUDIO EN MODO PARCHE
                        [
                            path.join(manualDir, `img_${n}.jpg`),     // Borramos imagen
                            path.join(manualDir, `escena_${n}.mp4`),  // Borramos video
                            // path.join(manualDir, `audio_${n}.mp3`) // 🛡️ COMENTADO: ¡NO BORRAMOS EL AUDIO!
                        ].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                    }
                }
            });
        } else {
            // 🚨 RED DE SEGURIDAD
            if (reanudar && baseDeDatos.length > 5 && lineasInput.length < 5) {
                return res.json({ ok: false, error: "⛔ SEGURIDAD: Intentas reemplazar muchas escenas con pocas líneas sin número. Si son correcciones, usa el número (ej: '5. Texto')." });
            }

            if (reanudar && baseDeDatos.length > 0) {
                console.log("📂 MODO REANUDAR: Actualizando guion...");
                baseDeDatos = lineasInput; 
            } else {
                console.log("🆕 PROYECTO NUEVO: Limpieza total.");
                if (fs.existsSync(manualDir)) {
                     fs.readdirSync(manualDir).forEach(f => { try { fs.unlinkSync(path.join(manualDir, f)); } catch(e){} });
                }
                baseDeDatos = lineasInput;
            }
        }

        fs.writeFileSync(DB_FILE, JSON.stringify(baseDeDatos, null, 2));


        // ==========================================
        // 2. EL MOTOR DE GENERACIÓN
        // ==========================================
        
        const totalEscenas = baseDeDatos.length;
        const listaFinalDeVideos = new Array(totalEscenas).fill(null);
        const trabajosPendientes = [];

        console.log("🔍 Escaneando estado del proyecto...");

       baseDeDatos.forEach((lineaRaw, idx) => {
            const num = String(idx + 1).padStart(3, "0");
            const imgPath = path.join(manualDir, `img_${num}.jpg`);
            const scenePath = path.join(manualDir, `escena_${num}.mp4`);
            const audioPath = path.join(manualDir, `audio_${num}.mp3`);
            // 1. DEFINIMOS la ruta del JSON de tiempos
            const jsonPath = path.join(manualDir, `audio_${num}.json`);
            
            // 2. CAMBIO CRÍTICO: Añadimos fs.existsSync(jsonPath) a la condición.
            // Ahora, si falta el JSON, la escena se enviará a "trabajosPendientes" para ser procesada.
            if (fs.existsSync(imgPath) && fs.existsSync(scenePath) && fs.existsSync(audioPath) && fs.existsSync(jsonPath) && fs.statSync(imgPath).size > 0) {
                listaFinalDeVideos[idx] = `file '${scenePath.replace(/\\/g, "/")}'`;
            } else {
                trabajosPendientes.push({ linea: lineaRaw, originalIndex: idx });
            }
        });

        const completados = totalEscenas - trabajosPendientes.length;
        console.log(`📊 Reporte: ${completados} listos / ${trabajosPendientes.length} por procesar.`);

// =========================================================================
// 🛠️ FUNCIÓN AUXILIAR: CIRUGÍA DE TEXTO (VERSIÓN ELÁSTICA ANTICORTES)
// =========================================================================
function inyectarTextoEnJSON(datosWhisper, textoManual) {
    if (!textoManual) return datosWhisper;

    // 1. Convertimos tu texto en una lista de palabras (respetando puntuación)
    const palabrasUser = textoManual
        .replace(/\r?\n/g, " ") // Quita enters
        .trim()
        .split(/\s+/); // Separa por cualquier espacio

    // 2. Aplanamos la estructura de Whisper para tener una lista lineal de "huecos de tiempo"
    let slotsDeTiempo = [];
    if (datosWhisper.segments) {
        datosWhisper.segments.forEach(seg => {
            if (seg.words) {
                seg.words.forEach(w => slotsDeTiempo.push(w));
            }
        });
    }

    // Si Whisper no detectó NADA (silencio total), no podemos hacer nada
    if (slotsDeTiempo.length === 0) return datosWhisper;

    // 3. LLENADO DE HUECOS
    for (let i = 0; i < slotsDeTiempo.length; i++) {
        if (i < palabrasUser.length) {
            // Caso Normal: Metemos tu palabra en el hueco de tiempo i
            slotsDeTiempo[i].word = palabrasUser[i];
        } else {
            // Caso Sobra Tiempo: Whisper oyó ruido extra -> Lo limpiamos
            slotsDeTiempo[i].word = "";
        }
    }

    // 4. 🔥 EL SALVAVIDAS (Si tú escribiste más palabras de las que Whisper oyó) 🔥
    if (palabrasUser.length > slotsDeTiempo.length) {
        // Tomamos todas las palabras que sobraron
        const sobrante = palabrasUser.slice(slotsDeTiempo.length).join(" ");
        // Y las pegamos TODAS en el último hueco de tiempo disponible
        // (Así aparecerán al final rápido, pero NO se cortarán)
        slotsDeTiempo[slotsDeTiempo.length - 1].word += " " + sobrante;
    }

    // 5. Actualizamos los textos de los segmentos para coherencia interna
    datosWhisper.segments.forEach(seg => {
        if (seg.words) seg.text = seg.words.map(w => w.word).join(" ");
    });

    return datosWhisper;
}

// =========================================================================
// 🚀 PROCESADOR PRINCIPAL DE ESCENAS (Versión Corregida)
// =========================================================================
const procesarItem = async (item) => {
    const { linea, originalIndex } = item;
    const num = String(originalIndex + 1).padStart(3, "0");
    if(!linea || !linea.includes("||")) return false; 

    const [texto, promptRaw] = linea.split("||").map(x => x.trim());
    const imgPath = path.join(manualDir, `img_${num}.jpg`); 
    const audioPath = path.join(manualDir, `audio_${num}.mp3`);
    const jsonPath = path.join(manualDir, `audio_${num}.json`);
    const assPath = path.join(manualDir, `sub_${num}.ass`);
    const scenePath = path.join(manualDir, `escena_${num}.mp4`);
    
    // --- TEXTURA ---
    const texturaPath = path.join(manualDir, "textura.mp4");
    const hayTextura = fs.existsSync(texturaPath) && efectoNoir;

    let generamosAlgoNuevo = false;

    // 1. IMAGEN
    if (!fs.existsSync(imgPath) || fs.statSync(imgPath).size < 1000) {
        console.log(`🎨 Escena ${num}: Generando imagen nueva...`);
        const ok = await generarImagenConReintento(promptRaw, motorImagenes, googleApiKey, whiskCookie, w, h, imgPath, geminiApiKey);
        if (!ok) return false; 
        generamosAlgoNuevo = true;
    }

    // 2. AUDIO Y TIEMPOS
    let tieneAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 500;
    let tieneJson = fs.existsSync(jsonPath) && fs.statSync(jsonPath).size > 10; 

    if (!tieneAudio || !tieneJson) {
        if (!tieneAudio) {
            console.log(`🎤 Escena ${num}: Generando Audio nuevo...`);
            if (modoDebug) {
                await generarAudio(texto, voiceId, elevenApiKey, audioPath, true);
            } else if (tipoVoz === "gratis") {
                await generarAudioYSubtitulos(texto, audioPath, num); 
            } else {
                await generarAudio(texto, voiceId, elevenApiKey, audioPath, false);
            }
        }
        // Sincronización Whisper (Solo si falta el JSON)
        if (fs.existsSync(audioPath) && !fs.existsSync(jsonPath)) {
            try {
                const { sincronizarConWhisper } = await import("./audiomanager.mjs");
                await sincronizarConWhisper(audioPath);
                if (!fs.existsSync(jsonPath)) await new Promise(r => setTimeout(r, 1000));
            } catch (errorWhisper) { return false; }
        }
        generamosAlgoNuevo = true;
    }

    const listoParaMontar = fs.existsSync(audioPath) && fs.existsSync(jsonPath);

    // --- 3. CONSTRUCCIÓN DE FILTROS FFmpeg ---
    
    let inputsFFmpeg = `-loop 1 -i "${imgPath}" -i "${audioPath}"`;
    if (hayTextura) {
        inputsFFmpeg += ` -stream_loop -1 -i "${texturaPath}"`;
    }

    let filterChain = "";

    // A. PROCESAMIENTO IMAGEN BASE (gbrp para evitar verdes)
    let scaleFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=gbrp`;
    
    if (efectoPendulo) {
        const zoom = 1.15;
        const ang = (intensidadPendulo || 4) / 100;
        const vel = velocidadPendulo || 1.3;
        scaleFilter = `scale=${w}*${zoom}:${h}*${zoom}:force_original_aspect_ratio=increase,` +
                      `rotate='${ang}*sin(t*${vel})':ow='iw':oh='ih':fillcolor=black@0,crop=${w}:${h},setsar=1,format=gbrp`;
    }
    filterChain += `[0:v]${scaleFilter}[base];`;

    // B. APLICACIÓN DE TEXTURA
    if (hayTextura) {
        const opacidad = 0.6; 
        filterChain += `[2:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},hue=s=0,setsar=1,format=gbrp[tex];`;
        filterChain += `[base][tex]blend=all_mode='multiply':all_opacity=${opacidad},format=yuv420p[video_mix];`;
    } else {
        filterChain += `[base]format=yuv420p[video_mix];`;
    }

    // C. SUBTÍTULOS (LOGICA HÍBRIDA APLICADA)
    let outputLabel = "[video_mix]"; 

    if (usarSubtitulos && listoParaMontar) {
        try {
            const modoDinamico = (tipoSub === "karaoke"); 
            const contenidoJson = fs.readFileSync(jsonPath, 'utf8');
            
            // 1. Leemos datos de Whisper
            let datosWhisper = JSON.parse(contenidoJson); 

            // 🔥 2. INYECTAMOS TU TEXTO MANUAL (RAASMEX) 🔥
            datosWhisper = inyectarTextoEnJSON(datosWhisper, texto);

            // 3. Generamos ASS corregido
            crearArchivoASS(datosWhisper, assPath, formato, subsEnMedio, modoDinamico);
            
            const subPathFFmpeg = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
            filterChain += `[video_mix]subtitles='${subPathFFmpeg}'[final]`;
            outputLabel = "[final]";
        } catch (e) { console.error(`❌ Error Subs Escena ${num}:`, e.message); }
    }

    let finalMap = outputLabel === "[final]" ? `-map "[final]"` : `-map "[video_mix]"`;
    
    // RENDER FINAL (QuickSync)
    let cmd = `${cmdFFmpeg} -y ${inputsFFmpeg} -filter_complex "${filterChain}" ${finalMap} -map 1:a -c:v h264_qsv -global_quality 25 -preset faster -pix_fmt yuv420p -c:a aac -shortest "${scenePath}"`;
    
    try { 
        await execPromise(cmd); 
        listaFinalDeVideos[originalIndex] = `file '${scenePath.replace(/\\/g, "/")}'`;
        return generamosAlgoNuevo; 
    } catch (e) { 
        console.error(`❌ Error FFmpeg Escena ${num}:`, e.message);
        return false; 
    }
};

// ==========================================
// ⚡ EJECUCIÓN DEL BUCLE TURBO DINÁMICO (Optimizado i5 + Reloj)
// ==========================================

// 1. ⏱️ INICIO DEL CRONÓMETRO
let tiempoInicio = Date.now(); 

if (trabajosPendientes.length > 0) {
    
    // 🔍 El sistema revisa si ya existen los archivos para decidir la velocidad
    const esSoloMontaje = trabajosPendientes.every(item => {
        const num = String(item.originalIndex + 1).padStart(3, "0");
        const tieneImg = fs.existsSync(path.join(manualDir, `img_${num}.jpg`));
        const tieneAudio = fs.existsSync(path.join(manualDir, `audio_${num}.mp3`));
        return tieneImg && tieneAudio;
    });

    // 🚀 LÓGICA DE VELOCIDAD: 4 si ya existen los archivos, 2 si hay que usar APIs
    const CONCURRENCIA_REAL = esSoloMontaje ? 4 : 2; 
    
    console.log("------------------------------------------------");
    console.log(esSoloMontaje 
        ? "🚀 MODO TURBO (i5): Archivos detectados localmente. Procesando de 4 en 4." 
        : "🐢 MODO SEGURO: Generando contenido nuevo. Procesando de 2 en 2 para cuidar APIs.");
    console.log("------------------------------------------------");

    // Mensaje inicial con tiempo 00:00
    res.write(JSON.stringify({ 
        progreso: 10, 
        mensaje: `🚀 Regenerando ${trabajosPendientes.length} escenas (Velocidad x${CONCURRENCIA_REAL})...`, 
        tiempo: "00:00" 
    }) + "\n");

    for (let i = 0; i < trabajosPendientes.length; i += CONCURRENCIA_REAL) {
        const lote = trabajosPendientes.slice(i, i + CONCURRENCIA_REAL);
        
        // 2. ⏱️ CÁLCULO DE TIEMPO TRANSCURRIDO
        let diff = Math.floor((Date.now() - tiempoInicio) / 1000); 
        let mins = Math.floor(diff / 60);
        let segs = diff % 60;
        let tiempoTexto = `${mins.toString().padStart(2, '0')}:${segs.toString().padStart(2, '0')}`;

        // Calculamos porcentaje
        let porcentajeActual = Math.round(20 + (i / trabajosPendientes.length) * 60);

        // 3. ENVÍO DE DATOS AL HTML
        res.write(JSON.stringify({ 
            progreso: porcentajeActual, 
            mensaje: `⚡ Lote ${Math.ceil(i / CONCURRENCIA_REAL) + 1} (${tiempoTexto})...`,
            tiempo: tiempoTexto 
        }) + "\n");
        
        // Se lanzan los procesos en paralelo
        const resultados = await Promise.all(lote.map(item => procesarItem(item)));
        
        // 💡 Enfriamiento si se usó API (Ajustado a 1 segundo)
        const huboUsoDeApi = resultados.some(res => res === true);
        if (huboUsoDeApi && i + CONCURRENCIA_REAL < trabajosPendientes.length) {
            console.log("⏳ Enfriando motores por uso de API (1s)...");
            await new Promise(r => setTimeout(r, 1000)); // <--- AHORA ES 1 SEGUNDO
        }
    }
} else {
    // Si no hay nada que hacer, enviamos tiempo final
    let diff = Math.floor((Date.now() - tiempoInicio) / 1000);
    let mins = Math.floor(diff / 60);
    let segs = diff % 60;
    let tiempoTexto = `${mins.toString().padStart(2, '0')}:${segs.toString().padStart(2, '0')}`;
    
    res.write(JSON.stringify({ progreso: 50, mensaje: "⏩ Nada nuevo por generar.", tiempo: tiempoTexto }) + "\n");
}

    // ==========================================
    // 3. ENSAMBLAJE FINAL (UNIR VIDEOS Y MÚSICA - OPTIMIZADO GPU)
    // ==========================================
    const listaLimpia = listaFinalDeVideos.filter(x => x !== null);
    if (listaLimpia.length === 0) return res.json({ ok: false, error: "No hay escenas listas para unir." });

    fs.writeFileSync(path.join(manualDir, "list.txt"), listaLimpia.join("\n"), "utf8");

    // Calculamos tiempo para el mensaje
    let diffConcat = Math.floor((Date.now() - tiempoInicio) / 1000);
    let tiempoConcat = `${Math.floor(diffConcat/60).toString().padStart(2,'0')}:${(diffConcat%60).toString().padStart(2,'0')}`;

    // Enviamos estado con reloj
    res.write(JSON.stringify({ 
        progreso: 85, 
        mensaje: "🔗 Uniendo escenas...", 
        tiempo: tiempoConcat 
    }) + "\n");

    const videoMudo = path.join(manualDir, "temp.mp4"); 
    const videoFinal = path.join(manualDir, "final.mp4");

    // Unir todas las partes (Rápido, copia directa)
    await execPromise(`${cmdFFmpeg} -y -f concat -safe 0 -i "${path.join(manualDir, "list.txt")}" -c copy "${videoMudo}"`);

    // Calculamos tiempo para el mensaje de audio
    let diffAudio = Math.floor((Date.now() - tiempoInicio) / 1000);
    let tiempoAudio = `${Math.floor(diffAudio/60).toString().padStart(2,'0')}:${(diffAudio%60).toString().padStart(2,'0')}`;

    res.write(JSON.stringify({ 
        progreso: 90, 
        mensaje: "🎵 Mezclando audio (GPU)...", 
        tiempo: tiempoAudio 
    }) + "\n");

    // BUSCAMOS LA MÚSICA QUE SUBISTE EN EL HTML
    let musicPath = null;
    if (musicaManual) {
        const rutaManual = path.join(uploadsDir, musicaManual);
        if (fs.existsSync(rutaManual)) {
            musicPath = rutaManual;
            console.log("🎸 Usando música manual:", musicPath);
        }
    }

    if (!musicPath) {
        musicPath = await detectarEmocionYMusica(baseDeDatos.join(" "), googleApiKey);
    }

    if (musicPath) {
        const dur = await obtenerDuracion(videoMudo);
        let af = `[1:a]volume=${volFinal}`; 
        if (dur > 3) af += `,afade=t=out:st=${dur - 3}:d=3`; 
        af += `[bg];[0:a][bg]amix=inputs=2:duration=first[a]`;

        // 🔥 GPU ACTIVADA (h264_qsv)
        await execPromise(`${cmdFFmpeg} -y -i "${videoMudo}" -stream_loop -1 -i "${musicPath}" -filter_complex "${af}" -map 0:v -map "[a]" -c:v h264_qsv -global_quality 25 -preset faster -pix_fmt yuv420p "${videoFinal}"`);
        
        try { fs.unlinkSync(videoMudo); } catch (e) {}
    } else {
        // Si no hay música, solo aseguramos el formato
        await execPromise(`${cmdFFmpeg} -y -i "${videoMudo}" -c copy -pix_fmt yuv420p "${videoFinal}"`);
        try { fs.unlinkSync(videoMudo); } catch (e) {}
    }

    // --- ✅ CIERRE CORRECTO DEL STREAM ---
    // En lugar de res.json(), enviamos el dato final por el stream y cerramos con .end()
    res.write(JSON.stringify({ 
        progreso: 100, 
        mensaje: "✅ Producción Finalizada", 
        tiempo: tiempoAudio,
        videoUrl: "/output/manual/final.mp4", // <--- AQUÍ VA LA URL
        ok: true 
    }) + "\n");
    
    res.end(); // <--- FINALIZAMOS LA CONEXIÓN LIMPIAMENTE

  } catch (e) {
    console.error("❌ ERROR CRÍTICO:", e);
    
    // Manejo de error seguro: Si ya enviamos headers (el stream estaba abierto), usamos write.
    // Si no, usamos json.
    if (res.headersSent) {
        res.write(JSON.stringify({ ok: false, error: e.message }) + "\n");
        res.end();
    } else {
        res.json({ ok: false, error: e.message });
    }
  }
});


// ==========================================
// 🕵️‍♂️ REPORTE DE SALUD DEL PROYECTO
// ==========================================

app.get("/reporte", (req, res) => {
    const DB_FILE = path.join(manualDir, 'data.json');
    if (!fs.existsSync(DB_FILE)) return res.send("<h1>No hay proyecto (data.json no existe)</h1>");

    let baseDeDatos = [];
    try { baseDeDatos = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) {}

    const total = baseDeDatos.length;
    const faltanImg = [];
    const faltanAudio = [];
    const faltanVideo = [];

    baseDeDatos.forEach((_, idx) => {
        const n = String(idx + 1).padStart(3, "0");
        const img = path.join(manualDir, `img_${n}.jpg`);
        const aud = path.join(manualDir, `audio_${n}.mp3`);
        const vid = path.join(manualDir, `escena_${n}.mp4`);

        // Verificamos existencia y tamaño > 0
        if (!fs.existsSync(img) || fs.statSync(img).size === 0) faltanImg.push(idx + 1);
        if (!fs.existsSync(aud) || fs.statSync(aud).size === 0) faltanAudio.push(idx + 1);
        if (!fs.existsSync(vid) || fs.statSync(vid).size === 0) faltanVideo.push(idx + 1);
    });

    // Imprimir en consola también para que lo veas rápido
    console.log(`\n📊 --- REPORTE DE ESTADO (${total} Escenas) ---`);
    console.log(`🖼️  Imágenes faltantes: ${faltanImg.length > 0 ? faltanImg.join(", ") : "✅ NINGUNA"}`);
    console.log(`🎤 Audios faltantes:   ${faltanAudio.length > 0 ? faltanAudio.join(", ") : "✅ NINGUNO"}`);
    console.log(`🎬 Videos faltantes:   ${faltanVideo.length > 0 ? faltanVideo.join(", ") : "✅ NINGUNO"}`);
    console.log("------------------------------------------\n");

    res.json({
        total_escenas: total,
        estado: {
            imagenes_faltantes: faltanImg,
            audios_faltantes: faltanAudio,
            videos_faltantes: faltanVideo
        },
        mensaje: "Revisa la consola del servidor para ver el resumen."
    });
});

// RUTA PARA BORRAR SOLO LOS VIDEOS (MP4) Y FORZAR RE-RENDER DE EFECTOS
app.post("/api/limpiar-renders", (req, res) => {
    try {
        let cont = 0;
        if (fs.existsSync(manualDir)) {
            const archivos = fs.readdirSync(manualDir);
            archivos.forEach(archivo => {
                // Solo borramos los "escena_XXX.mp4"
                // MANTENEMOS: "img_XXX.jpg" y "audio_XXX.mp3"
                if (archivo.startsWith("escena_") && archivo.endsWith(".mp4")) {
                    fs.unlinkSync(path.join(manualDir, archivo));
                    cont++;
                }
            });
        }
        console.log(`♻️ Se eliminaron ${cont} videos para aplicar nuevos efectos.`);
        res.json({ ok: true, count: cont });
    } catch (e) {
        console.error(e);
        res.json({ ok: false, error: e.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🔥 Servidor Final listo en http://localhost:${PORT}`));
