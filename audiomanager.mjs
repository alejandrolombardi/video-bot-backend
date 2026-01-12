import { spawn, exec } from "child_process"; // Añadido exec
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import util from "util"; // Añadido util

const execPromise = util.promisify(exec); // Promisificamos exec
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pythonVenv = path.join(__dirname, "venv", "Scripts", "python.exe");
const scriptsPath = path.join(__dirname, "scripts");

/**
 * MODO GRATIS: Ahora recibe 'idEscena' para que el temporal sea único.
 */
export async function generarAudioYSubtitulos(texto, audioPath, idEscena = "000") {
    console.log(`🎙️ [Manager] Orquestando Escena ${idEscena}: ${path.basename(audioPath)}`);
    try {
        // PASO 1: Generar Voz con nombre de archivo único
        const audioOk = await ejecutarEmilio(texto, audioPath, idEscena);
        if (!audioOk) throw new Error("Fallo en la generación de audio con Emilio");

        // PASO 2: Whisper analiza el archivo ya movido a manual/
        const jsonPath = await sincronizarConWhisper(audioPath);
        
        console.log(`✅ [Manager] Escena ${idEscena} completada.`);
        return { audio: audioPath, tiempos: jsonPath };
    } catch (e) {
        console.error(`❌ Error en Escena ${idEscena}:`, e);
        return null;
    }
}

/**
 * MODO DIAGNÓSTICO: Ejecuta Whisper y muestra TODOS los errores de Python
 */
export async function sincronizarConWhisper(rutaAudio) {
    const scriptWhisper = path.join(scriptsPath, "sincronizar.py"); // Asegúrate de que tu script se llama así
    const jsonPath = rutaAudio.replace(".mp3", ".json");

    // 1. Verificación previa
    if (!fs.existsSync(rutaAudio)) {
        throw new Error(`El archivo de audio NO existe: ${rutaAudio}`);
    }

    // 2. Construcción del comando (con comillas para rutas con espacios)
    const comando = `"${pythonVenv}" "${scriptWhisper}" "${rutaAudio}"`;

    console.log(`🐍 [Whisper] Ejecutando: ${comando}`);

    try {
        // Ejecutamos y esperamos la salida
        const { stdout, stderr } = await execPromise(comando);

        // Si Python mandó warnings o logs, los mostramos
        if (stderr) console.log(`⚠️ [Python Log]: ${stderr}`);
        if (stdout) console.log(`ℹ️ [Python Out]: ${stdout}`);

        // 3. Verificación final
        if (fs.existsSync(jsonPath)) {
            return jsonPath;
        } else {
            throw new Error("Python terminó sin código de error, pero el archivo .json NO apareció.");
        }

    } catch (error) {
        // 4. Captura de errores reales (Librerías faltantes, sintaxis, etc.)
        console.error("❌ ERROR CRÍTICO PYTHON:", error.message);
        if (error.stderr) console.error("📝 Detalle del error:", error.stderr);
        throw error; // Lanzamos el error para que server.mjs lo detecte y pare la escena
    }
}

// --- ESPECIALISTA INTERNO: EMILIO CON NOMBRES ÚNICOS ---

function ejecutarEmilio(texto, rutaDestino, idEscena) {
    return new Promise((resolve) => {
        const scriptVoz = path.join(scriptsPath, "voz.py");
        
        // Creamos un nombre temporal único para esta escena (evita el error EBUSY)
        const nombreTemporal = `temp_voz_${idEscena}.mp3`;
        const tempPath = path.join(process.cwd(), nombreTemporal);

        // Pasamos el nombre del archivo deseado como 3er argumento al script de Python
        const py = spawn(pythonVenv, [scriptVoz, texto, "es-DO-EmilioNeural", nombreTemporal]);

        py.on('close', (code) => {
            if (code === 0) {
                // Pequeña pausa para que Windows suelte el archivo
                setTimeout(() => {
                    try {
                        if (fs.existsSync(tempPath)) {
                            // Borramos el audio viejo en manual/ si existe
                            if (fs.existsSync(rutaDestino)) fs.unlinkSync(rutaDestino);
                            
                            // Movemos el temporal de la raíz a manual/audio_XXX.mp3
                            fs.renameSync(tempPath, rutaDestino);
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    } catch (err) {
                        console.error("❌ Error moviendo archivo:", err.message);
                        resolve(false);
                    }
                }, 300); 
            } else {
                resolve(false);
            }
        });
    });
}