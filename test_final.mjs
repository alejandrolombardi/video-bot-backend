// test_final.mjs
import { generarAudioConPython } from './audiomanager.mjs';

const fraseEpica = "En un mundo donde la IA domina, Alejandro creó el mejor bot híbrido.";

console.log("🚀 Iniciando prueba de comunicación...");

async function correrPrueba() {
    try {
        console.log("⏳ Node le pide a Python que genere el audio...");
        const resultado = await generarAudioConPython(fraseEpica);
        console.log(`✅ ¡Éxito total! Archivo creado: ${resultado}`);
        console.log("📁 Busca el archivo 'voz_final.mp3' en tu carpeta.");
    } catch (error) {
        console.error("❌ Algo falló:", error);
    }
}

correrPrueba();